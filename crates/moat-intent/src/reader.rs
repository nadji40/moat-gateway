//! Asking the model, and turning its answer into fields.
//!
//! The model is served by llama.cpp's `llama-server`, which speaks the OpenAI
//! chat completions API and constrains the answer to a JSON schema, so a
//! malformed answer is not something this code has to parse around. The
//! message is sent to the configured model endpoint, which may be remote.
//!
//! The prompt and the schema are part of the record. Every intent this
//! reader registers says which model read it and which prompt it was given,
//! by hash, so a verdict can be traced to exactly what decided it.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use moat_core::hash::sha256_hex;
use moat_core::session::IntentFields;
use serde::Serialize;
use serde_json::{json, value::RawValue, Value};

use crate::ground::{ground, ModelOutput};
use crate::redact::{redact, Redacted};

/// What the model is told. Rerun the corpus when the prompt, schema order,
/// or serving configuration changes; each can change the model's answers.
pub const SYSTEM_PROMPT: &str = "\
You read ONE message that a user wrote to their payment assistant, in any language.
Report what the user asks for. Copy every name and number EXACTLY as it appears in the message:
same characters, same script, same spelling. Never translate, never transliterate, never invent.

Return JSON with these fields:
- \"pay\": names of the people or companies the user asks to pay NOW. Leave it empty if the user
  cancels, refuses, only asks a question, or names no payee.
- \"refused\": names the user says not to pay, cancels, or calls a scam, including names inside
  something the user quotes and tells you to ignore.
- \"amount\": the amount to pay, digits exactly as written, without the currency. null if none.
- \"currency\": the ISO 4217 code of the currency the user named by code, symbol or word. null if none.
- \"destinations\": the placeholders (DEST_1, DEST_2, ...) of the accounts or addresses the user
  asks to pay to. Only placeholders that appear in the message; an empty list if there are none.
- \"references\": invoice, order, ticket or other reference numbers, exactly as written.
- \"cancels_previous\": true only when the user withdraws an earlier request as a whole, such as
  \"cancel that\", \"forget it\" or \"never mind\". Refusing a payee by name is not cancelling:
  put that name in \"refused\" and leave this false.
A name is only the name: no verbs, no prepositions, no attached particles.";

// llama.cpp emits schema properties in their supplied order. A Value sorts
// them alphabetically, making cancellation precede pay/refused and changing
// measured accuracy. Keep the notebook's order all the way onto the wire.
const SCHEMA: &str = include_str!("intent.schema.json");

#[derive(Serialize)]
struct CompletionRequest<'a> {
    model: &'a str,
    messages: [Value; 2],
    temperature: u8,
    max_tokens: u16,
    response_format: ResponseFormat<'a>,
    chat_template_kwargs: Value,
}

#[derive(Serialize)]
struct ResponseFormat<'a> {
    r#type: &'a str,
    json_schema: NamedSchema<'a>,
}

#[derive(Serialize)]
struct NamedSchema<'a> {
    name: &'a str,
    schema: &'a RawValue,
}

/// A hash of the prompt and the schema together, for the record.
pub fn prompt_sha256() -> String {
    sha256_hex(format!("{SYSTEM_PROMPT}\n{}", SCHEMA.trim()).as_bytes())
}

/// How a message was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The model answered and its answer was checked.
    Read,
    /// The model could not be reached or did not answer. The fields are
    /// empty, so nothing in this message counts as asked for.
    Unavailable,
}

/// One message, read.
#[derive(Debug, Clone, Serialize)]
pub struct Reading {
    /// Whether the model answered.
    pub status: Status,
    /// What will be registered with the gateway.
    pub fields: IntentFields,
    /// Every value the model returned that the message did not support.
    pub dropped: Vec<String>,
    /// The message as it will be kept: as typed, without card numbers.
    pub record: String,
    /// How many card numbers were removed from it.
    pub cards_removed: usize,
    /// Why the model could not be used, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Reads messages with a model served by `llama-server`.
#[derive(Clone)]
pub struct Reader {
    client: reqwest::Client,
    llm_url: String,
    model: String,
}

impl Reader {
    /// A reader for the model at `llm_url`, labelled `model` in the record.
    pub fn new(llm_url: &str, model: &str, timeout: Duration) -> Result<Reader> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .context("building the model client")?;
        Ok(Reader {
            client,
            llm_url: llm_url.trim_end_matches('/').to_owned(),
            model: model.to_owned(),
        })
    }

    /// What goes in the `reader` field of every intent this reader registers.
    pub fn label(&self) -> String {
        format!(
            "moat-intent {} model={} prompt=sha256:{}",
            env!("CARGO_PKG_VERSION"),
            self.model,
            &prompt_sha256()[..16]
        )
    }

    /// Read one message. Never fails: a model that cannot be used yields
    /// empty fields and says so.
    pub async fn read(&self, text: &str) -> Reading {
        let message = redact(text);
        match self.ask(&message).await {
            Ok(out) => {
                let grounded = ground(out, &message);
                let mut fields = grounded.fields;
                fields.reader = Some(self.label());
                Reading {
                    status: Status::Read,
                    fields,
                    dropped: grounded.dropped,
                    record: message.for_record,
                    cards_removed: message.cards_removed,
                    error: None,
                }
            }
            Err(error) => {
                tracing::error!(%error, "the model could not read the message; nothing in it will count as asked for");
                Reading {
                    status: Status::Unavailable,
                    fields: IntentFields {
                        reader: Some(format!("{} unavailable", self.label())),
                        ..Default::default()
                    },
                    dropped: Vec::new(),
                    record: message.for_record,
                    cards_removed: message.cards_removed,
                    error: Some(format!("{error:#}")),
                }
            }
        }
    }

    async fn ask(&self, message: &Redacted) -> Result<ModelOutput> {
        let schema: &RawValue = serde_json::from_str(SCHEMA.trim()).context("intent schema")?;
        let body = CompletionRequest {
            model: &self.model,
            messages: [
                json!({"role": "system", "content": SYSTEM_PROMPT}),
                json!({"role": "user", "content": message.for_model}),
            ],
            temperature: 0,
            max_tokens: 400,
            response_format: ResponseFormat {
                r#type: "json_schema",
                json_schema: NamedSchema {
                    name: "intent",
                    schema,
                },
            },
            // Thinking models answer faster and no worse here without it.
            chat_template_kwargs: json!({"enable_thinking": false}),
        };
        let response = self
            .client
            .post(format!("{}/v1/chat/completions", self.llm_url))
            .json(&body)
            .send()
            .await
            .context("reaching the model")?;
        let status = response.status();
        let reply: Value = response.json().await.context("reading the model's reply")?;
        if !status.is_success() {
            return Err(anyhow!("the model server answered {status}: {reply}"));
        }
        let content = reply
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("the model's reply has no content"))?;
        serde_json::from_str(content).context("the model's answer is not the JSON asked for")
    }
}
