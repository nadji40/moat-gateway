//! Asking the model, and turning its answer into fields.
//!
//! Which model reads is configuration, not code. Three kinds of server are
//! spoken to, and each constrains the answer to the same JSON schema, so a
//! malformed answer is not something this code has to parse around:
//!
//! - [`Provider::Llama`], llama.cpp's `llama-server`, local or tunnelled.
//!   This is the default, and what the corpus was measured against.
//! - [`Provider::Anthropic`], Claude through Anthropic's Messages API.
//! - [`Provider::OpenAi`], any server that speaks OpenAI's chat completions
//!   API with a bearer key, hosted or self-run.
//!
//! The message is sent to the configured endpoint, which may be remote. An
//! API key, when one is needed, is held in memory and sent only to it.
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

/// The schema with extra properties forbidden, which the hosted APIs ask
/// for before they constrain an answer to it. Spliced as text so the field
/// order stays the order above.
fn closed_schema() -> String {
    let open = SCHEMA.trim();
    let body = open.strip_suffix('}').unwrap_or(open);
    format!("{body},\"additionalProperties\":false}}")
}

/// The Anthropic API version this code speaks.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Models that take `fallbacks: "default"`: when their safety classifiers
/// decline a message, Anthropic reads it with another model instead of
/// returning a refusal. Which model answered goes in the record.
const ANTHROPIC_FALLBACK_MODELS: &[&str] = &[
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];

/// Which kind of server reads the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// llama.cpp's `llama-server`. Needs no key.
    Llama,
    /// Anthropic's Messages API. Needs a key.
    Anthropic,
    /// Any OpenAI-compatible chat completions API. Needs a key.
    OpenAi,
}

impl Provider {
    /// Its name, as configuration spells it.
    pub fn name(self) -> &'static str {
        match self {
            Provider::Llama => "llama",
            Provider::Anthropic => "anthropic",
            Provider::OpenAi => "openai",
        }
    }

    /// Where it is, when the configuration does not say.
    pub fn default_url(self) -> Option<&'static str> {
        match self {
            Provider::Llama => Some("http://127.0.0.1:8092"),
            Provider::Anthropic => Some("https://api.anthropic.com"),
            Provider::OpenAi => None,
        }
    }

    /// Which model it runs, when the configuration does not say.
    pub fn default_model(self) -> Option<&'static str> {
        match self {
            Provider::Llama => Some("gemma-4-E4B-it-Q4_K_M"),
            Provider::Anthropic => Some("claude-opus-5-5"),
            Provider::OpenAi => None,
        }
    }

    /// Whether it refuses requests without a key.
    pub fn needs_key(self) -> bool {
        !matches!(self, Provider::Llama)
    }
}

impl std::str::FromStr for Provider {
    type Err = String;

    fn from_str(name: &str) -> Result<Provider, String> {
        match name.trim().to_ascii_lowercase().as_str() {
            "llama" | "gemma" | "local" => Ok(Provider::Llama),
            "anthropic" | "claude" => Ok(Provider::Anthropic),
            "openai" | "openai-compatible" => Ok(Provider::OpenAi),
            other => Err(format!(
                "unknown provider {other:?}; use llama, anthropic or openai"
            )),
        }
    }
}

/// Where the model is and how to ask it.
pub struct Backend {
    /// The kind of server.
    pub provider: Provider,
    /// Its base URL, without `/v1/...`.
    pub url: String,
    /// The model to ask for, and to name in the record.
    pub model: String,
    /// The key it wants, if any. Never logged and never put in the record.
    pub api_key: Option<String>,
    /// How hard a Claude model thinks before answering (`low`, `medium`,
    /// ...). `None` leaves it to the model's default. Ignored elsewhere.
    pub effort: Option<String>,
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

/// Reads messages with a model. Deliberately not `Debug`: it holds the key.
#[derive(Clone)]
pub struct Reader {
    client: reqwest::Client,
    provider: Provider,
    llm_url: String,
    model: String,
    api_key: Option<String>,
    effort: Option<String>,
}

impl Reader {
    /// A reader for the `llama-server` at `llm_url`, labelled `model` in the
    /// record.
    pub fn new(llm_url: &str, model: &str, timeout: Duration) -> Result<Reader> {
        Reader::with_backend(
            Backend {
                provider: Provider::Llama,
                url: llm_url.to_owned(),
                model: model.to_owned(),
                api_key: None,
                effort: None,
            },
            timeout,
        )
    }

    /// A reader for any backend.
    pub fn with_backend(backend: Backend, timeout: Duration) -> Result<Reader> {
        let api_key = backend.api_key.filter(|key| !key.trim().is_empty());
        if backend.provider.needs_key() && api_key.is_none() {
            return Err(anyhow!(
                "the {} provider needs an API key, and none was given",
                backend.provider.name()
            ));
        }
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .context("building the model client")?;
        Ok(Reader {
            client,
            provider: backend.provider,
            llm_url: backend.url.trim_end_matches('/').to_owned(),
            model: backend.model,
            api_key,
            effort: backend.effort.filter(|e| !e.trim().is_empty()),
        })
    }

    /// What goes in the `reader` field of every intent this reader registers.
    pub fn label(&self) -> String {
        self.label_for(&self.model)
    }

    /// The label, naming `model` as the one that read. A local model is
    /// named bare, as it always has been; a hosted one by its provider too.
    fn label_for(&self, model: &str) -> String {
        let model = match self.provider {
            Provider::Llama => model.to_owned(),
            other => format!("{}/{model}", other.name()),
        };
        format!(
            "moat-intent {} model={model} prompt=sha256:{}",
            env!("CARGO_PKG_VERSION"),
            &prompt_sha256()[..16]
        )
    }

    /// Read one message. Never fails: a model that cannot be used yields
    /// empty fields and says so.
    pub async fn read(&self, text: &str) -> Reading {
        let message = redact(text);
        match self.ask(&message).await {
            Ok(Answer { output, model }) => {
                let grounded = ground(output, &message);
                let mut fields = grounded.fields;
                fields.reader = Some(self.label_for(model.as_deref().unwrap_or(&self.model)));
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

    async fn ask(&self, message: &Redacted) -> Result<Answer> {
        match self.provider {
            Provider::Llama | Provider::OpenAi => self.ask_chat_completions(message).await,
            Provider::Anthropic => self.ask_anthropic(message).await,
        }
    }

    /// llama-server and the OpenAI-compatible APIs.
    async fn ask_chat_completions(&self, message: &Redacted) -> Result<Answer> {
        let messages = [
            json!({"role": "system", "content": SYSTEM_PROMPT}),
            json!({"role": "user", "content": message.for_model}),
        ];
        // llama-server gets exactly the request the corpus was measured
        // with. A hosted API gets the closed schema it wants for strict
        // output, no sampling settings some of its models reject, and room
        // for a reasoning model to think before it answers.
        let open: &RawValue = serde_json::from_str(SCHEMA.trim()).context("intent schema")?;
        let closed = closed_schema();
        let closed: &RawValue = serde_json::from_str(&closed).context("intent schema")?;
        let request = if self.provider == Provider::Llama {
            self.client
                .post(format!("{}/v1/chat/completions", self.llm_url))
                .json(&LlamaRequest {
                    model: &self.model,
                    messages,
                    temperature: 0,
                    max_tokens: 400,
                    response_format: ResponseFormat::new(open, None),
                    // Thinking models answer faster and no worse here without it.
                    chat_template_kwargs: json!({"enable_thinking": false}),
                })
        } else {
            self.client
                .post(format!("{}/v1/chat/completions", self.llm_url))
                .json(&HostedChatRequest {
                    model: &self.model,
                    messages,
                    max_completion_tokens: 4000,
                    response_format: ResponseFormat::new(closed, Some(true)),
                })
        };
        let request = match &self.api_key {
            Some(key) => request.bearer_auth(key),
            None => request,
        };
        let reply = send(request).await?;
        let content = reply
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("the model's reply has no content"))?;
        Ok(Answer {
            output: serde_json::from_str(content)
                .context("the model's answer is not the JSON asked for")?,
            model: None,
        })
    }

    /// Claude, through Anthropic's Messages API.
    async fn ask_anthropic(&self, message: &Redacted) -> Result<Answer> {
        let closed = closed_schema();
        let schema: &RawValue = serde_json::from_str(&closed).context("intent schema")?;
        let fallback = ANTHROPIC_FALLBACK_MODELS.contains(&self.model.as_str());
        let body = MessagesRequest {
            model: &self.model,
            // Generous: the model may think before it answers, and what it
            // does not use is not paid for.
            max_tokens: 16000,
            system: SYSTEM_PROMPT,
            messages: [json!({"role": "user", "content": message.for_model})],
            output_config: OutputConfig {
                effort: self.effort.as_deref(),
                format: OutputFormat {
                    r#type: "json_schema",
                    schema,
                },
            },
            fallbacks: fallback.then_some("default"),
        };
        let mut request = self
            .client
            .post(format!("{}/v1/messages", self.llm_url))
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("x-api-key", self.api_key.as_deref().unwrap_or_default());
        if fallback {
            request = request.header("anthropic-beta", "server-side-fallback-2026-07-01");
        }
        let reply = send(request.json(&body)).await?;
        anthropic_answer(&reply)
    }
}

/// Send a request and return the reply, or what the server said instead.
async fn send(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request.send().await.context("reaching the model")?;
    let status = response.status();
    let reply: Value = response.json().await.context("reading the model's reply")?;
    if !status.is_success() {
        return Err(anyhow!("the model server answered {status}: {reply}"));
    }
    Ok(reply)
}

// Models generate schema properties in their supplied order, so every
// request is a struct and the schema raw text, never a Value, which would
// sort the properties and change the answers.
#[derive(Serialize)]
struct LlamaRequest<'a> {
    model: &'a str,
    messages: [Value; 2],
    temperature: u8,
    max_tokens: u16,
    response_format: ResponseFormat<'a>,
    chat_template_kwargs: Value,
}

#[derive(Serialize)]
struct HostedChatRequest<'a> {
    model: &'a str,
    messages: [Value; 2],
    max_completion_tokens: u16,
    response_format: ResponseFormat<'a>,
}

#[derive(Serialize)]
struct ResponseFormat<'a> {
    r#type: &'a str,
    json_schema: NamedSchema<'a>,
}

impl<'a> ResponseFormat<'a> {
    fn new(schema: &'a RawValue, strict: Option<bool>) -> ResponseFormat<'a> {
        ResponseFormat {
            r#type: "json_schema",
            json_schema: NamedSchema {
                name: "intent",
                strict,
                schema,
            },
        }
    }
}

#[derive(Serialize)]
struct NamedSchema<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    strict: Option<bool>,
    schema: &'a RawValue,
}

#[derive(Serialize)]
struct MessagesRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: &'a str,
    messages: [Value; 1],
    output_config: OutputConfig<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallbacks: Option<&'a str>,
}

#[derive(Serialize)]
struct OutputConfig<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<&'a str>,
    format: OutputFormat<'a>,
}

#[derive(Serialize)]
struct OutputFormat<'a> {
    r#type: &'a str,
    schema: &'a RawValue,
}

/// What a model answered, and which model it was when that can differ from
/// the one asked for.
struct Answer {
    output: ModelOutput,
    model: Option<String>,
}

/// The answer in a Messages API reply. A refusal, or an answer cut off
/// before it closed, is not an answer: the message then reads as asking for
/// nothing, which costs a confirmation and never a payment.
fn anthropic_answer(reply: &Value) -> Result<Answer> {
    match reply.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => {
            return Err(anyhow!(
                "the model declined to read the message: {}",
                reply.get("stop_details").unwrap_or(&Value::Null)
            ))
        }
        Some("max_tokens") => return Err(anyhow!("the model ran out of tokens before answering")),
        _ => {}
    }
    let text = reply
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.is_empty() {
        return Err(anyhow!("the model's reply has no text"));
    }
    Ok(Answer {
        output: serde_json::from_str(&text)
            .context("the model's answer is not the JSON asked for")?,
        model: reply
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;

    #[test]
    fn the_closed_schema_is_the_schema_with_extra_fields_forbidden_in_the_same_order() {
        let closed = closed_schema();
        let value: Value = serde_json::from_str(&closed).unwrap();
        assert_eq!(value["additionalProperties"], false);
        let open: Value = serde_json::from_str(SCHEMA).unwrap();
        assert_eq!(value["properties"], open["properties"]);
        assert!(closed.find("\"pay\"").unwrap() < closed.find("\"cancels_previous\"").unwrap());
    }

    #[test]
    fn providers_are_named_the_way_configuration_spells_them() {
        assert_eq!("llama".parse(), Ok(Provider::Llama));
        assert_eq!("Gemma".parse(), Ok(Provider::Llama));
        assert_eq!("anthropic".parse(), Ok(Provider::Anthropic));
        assert_eq!("openai-compatible".parse(), Ok(Provider::OpenAi));
        assert!("bard".parse::<Provider>().is_err());
    }

    #[test]
    fn a_hosted_provider_without_a_key_is_refused_at_start() {
        let backend = |api_key: Option<&str>| Backend {
            provider: Provider::Anthropic,
            url: "https://api.anthropic.com".into(),
            model: "claude-opus-5-5".into(),
            api_key: api_key.map(Into::into),
            effort: None,
        };
        assert!(Reader::with_backend(backend(None), Duration::from_secs(1)).is_err());
        assert!(Reader::with_backend(backend(Some("  ")), Duration::from_secs(1)).is_err());
        let reader = Reader::with_backend(backend(Some("k")), Duration::from_secs(1)).unwrap();
        assert!(reader.label().contains("model=anthropic/claude-opus-5-5 "));
    }

    #[test]
    fn a_messages_reply_is_read_past_thinking_and_refusals_are_not_answers() {
        let answer = json!({"pay": ["Atlas"], "refused": [], "amount": "5", "currency": "USD",
            "destinations": [], "references": [], "cancels_previous": false});
        let reply = json!({
            "model": "claude-opus-5-5",
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "", "signature": "s"},
                {"type": "text", "text": answer.to_string()},
            ],
        });
        let read = anthropic_answer(&reply).unwrap();
        assert_eq!(read.model.as_deref(), Some("claude-opus-5-5"));
        assert!(format!("{:?}", read.output).contains("Atlas"));

        let refused = json!({"stop_reason": "refusal", "content": [],
            "stop_details": {"type": "refusal", "category": null}});
        assert!(anthropic_answer(&refused).is_err());
        let cut = json!({"stop_reason": "max_tokens",
            "content": [{"type": "text", "text": "{\"pay\": ["}]});
        assert!(anthropic_answer(&cut).is_err());
    }
}
