//! Policy files and their evaluation.
//!
//! The policy is a plain YAML document (see `policies/default.yaml`). This
//! module reads it, validates it once, and evaluates payment calls against
//! it. There is no expression language: a rule's `when` is exactly
//! `field == <name>`, and the checks a rule can make are `require_source`
//! and `max`.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::destination::Destination;
use crate::money::{parse_major, Asset, AssetRegistry, Minor};
use crate::provenance::{resolve_with, MatchMode, Resolution};
use crate::rail::Rail;
use crate::session::{Event, Session};
use crate::source::SourceKind;
use crate::verdict::{Decision, RuleOutcome, Verdict};

/// Why a policy could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    /// File could not be read.
    #[error("reading policy {path}: {source}")]
    Io {
        /// The path.
        path: String,
        /// The error.
        #[source]
        source: std::io::Error,
    },
    /// YAML did not parse into the policy shape.
    #[error("parsing policy: {0}")]
    Parse(#[from] serde_norway::Error),
    /// The document parsed but is not usable.
    #[error("invalid policy: {0}")]
    Invalid(String),
}

/// A `server` / `tool` pair; `*` matches anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolMatcher {
    /// Upstream name or `*`.
    pub server: String,
    /// Tool name or `*`.
    pub tool: String,
}

impl ToolMatcher {
    fn matches(&self, server: &str, tool: &str) -> bool {
        (self.server == "*" || self.server == server) && (self.tool == "*" || self.tool == tool)
    }
}

/// What a policy says a tool is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolClass {
    /// Evaluated before it is forwarded.
    Payment,
    /// Declared to move no money, and forwarded as it is.
    NonPayment,
    /// In neither list. Refused, and hidden from the agent: a server that
    /// gains a tool nobody classified must not gain a way to pay around Moat.
    Unclassified,
}

/// How a logical field's value is compared against what Moat has seen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    /// A name or a number, matched the way ADR 0001 describes.
    #[default]
    Text,
    /// A destination: matched exactly on its canonical form, never by
    /// substring and never as a number. Declare this for any field naming an
    /// account, an IBAN or an address.
    Destination,
}

fn is_text_kind(kind: &FieldKind) -> bool {
    matches!(kind, FieldKind::Text)
}

/// Which argument names feed a logical field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldSpec {
    /// How the field's value is compared. Text unless stated, which is what
    /// every field was before destinations were typed.
    #[serde(default, skip_serializing_if = "is_text_kind")]
    pub kind: FieldKind,
    /// Argument names, first match wins.
    pub args: Vec<String>,
}

/// The allowlist section.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Allowlist {
    /// Payees that are trusted without a user intent.
    #[serde(default)]
    pub payees: Vec<String>,
    /// Destinations the user has approved out of band: IBANs, addresses,
    /// provider account ids. Compared canonically, so an IBAN's spacing is
    /// presentation and a near-miss address is still not a match.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<String>,
}

/// One rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    /// Unique id, reported in evidence.
    pub id: String,
    /// `field == <name>`.
    pub when: String,
    /// Sources the field must have resolved to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub require_source: Option<Vec<SourceKind>>,
    /// Numeric upper bound on the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// What failure means.
    pub on_fail: Decision,
    /// Explanation on failure. Defaults to something derived from the checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl Rule {
    /// The field named in `when`.
    pub fn field(&self) -> Result<&str, PolicyError> {
        let rest = self.when.trim();
        let Some(rest) = rest.strip_prefix("field") else {
            return Err(PolicyError::Invalid(format!(
                "rule {:?}: `when` must be `field == <name>`, got {:?}",
                self.id, self.when
            )));
        };
        let Some(name) = rest.trim_start().strip_prefix("==") else {
            return Err(PolicyError::Invalid(format!(
                "rule {:?}: `when` must be `field == <name>`, got {:?}",
                self.id, self.when
            )));
        };
        let name = name.trim();
        if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return Err(PolicyError::Invalid(format!(
                "rule {:?}: bad field name in `when`: {:?}",
                self.id, self.when
            )));
        }
        Ok(name)
    }
}

/// Rate limits across a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Velocity {
    /// Maximum payment calls evaluated per session, including denied ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_calls_per_session: Option<u32>,
    /// Maximum payment calls in any rolling sixty seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_calls_per_minute: Option<u32>,
    /// Most a session may pay without an approval, summed per currency over
    /// the payments already allowed and this one. A cap per payment cannot
    /// see the same amount split into pieces under it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_amount_per_session: Option<f64>,
    /// What exceeding either means.
    pub on_exceed: Decision,
}

/// A loaded policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    /// Must be 1.
    pub version: u32,
    /// Which tools are payments.
    pub payment_tools: Vec<ToolMatcher>,
    /// Which tools move no money. Anything in neither list is refused.
    #[serde(default)]
    pub non_payment_tools: Vec<ToolMatcher>,
    /// Logical fields and the argument names that feed them.
    #[serde(default)]
    pub fields: BTreeMap<String, FieldSpec>,
    /// Trusted values.
    #[serde(default)]
    pub allowlist: Allowlist,
    /// Rules, evaluated in order.
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// Rate limits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub velocity: Option<Velocity>,
    /// Assets this deployment uses that are not built in, or whose exponent
    /// differs on its network. A token must be known before it can be paid:
    /// nothing about the name `USDC` says it has six decimal places.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<Asset>,
    /// What `step_up` becomes when the host said no human is present.
    #[serde(default = "default_no_human")]
    pub no_human_available: Decision,
    /// What a payment nobody asked for becomes: no approval was presented,
    /// and neither its payee, its amount nor its destination came from what
    /// the user said. A trusted payee vouches for who is paid, not for
    /// whether to pay. `allow` turns the check off, which only a comparison
    /// arm modelling a control that never knows what the user asked should do.
    #[serde(default = "default_unrequested")]
    pub unrequested_payment: Decision,
}

fn default_no_human() -> Decision {
    Decision::Deny
}

fn default_unrequested() -> Decision {
    Decision::StepUp
}

impl Policy {
    /// Parse and validate a YAML document.
    pub fn from_yaml(text: &str) -> Result<Policy, PolicyError> {
        let policy: Policy = serde_norway::from_str(text)?;
        policy.validate()?;
        Ok(policy)
    }

    /// Read, parse and validate a file.
    pub fn load(path: &Path) -> Result<Policy, PolicyError> {
        let text = std::fs::read_to_string(path).map_err(|source| PolicyError::Io {
            path: path.display().to_string(),
            source,
        })?;
        Policy::from_yaml(&text)
    }

    fn validate(&self) -> Result<(), PolicyError> {
        if self.version != 1 {
            return Err(PolicyError::Invalid(format!(
                "unsupported version {}; this build understands 1",
                self.version
            )));
        }
        if self.payment_tools.is_empty() {
            return Err(PolicyError::Invalid("payment_tools is empty".to_owned()));
        }
        let mut ids = std::collections::HashSet::new();
        for rule in &self.rules {
            if !ids.insert(&rule.id) {
                return Err(PolicyError::Invalid(format!(
                    "duplicate rule id {:?}",
                    rule.id
                )));
            }
            let field = rule.field()?;
            if !self.fields.contains_key(field) {
                return Err(PolicyError::Invalid(format!(
                    "rule {:?} refers to field {:?}, which is not declared under `fields`",
                    rule.id, field
                )));
            }
            if rule.require_source.is_none() && rule.max.is_none() {
                return Err(PolicyError::Invalid(format!(
                    "rule {:?} has no check (needs require_source or max)",
                    rule.id
                )));
            }
            if rule.on_fail == Decision::Allow {
                return Err(PolicyError::Invalid(format!(
                    "rule {:?}: on_fail: allow makes the rule meaningless",
                    rule.id
                )));
            }
        }
        if let Some(v) = &self.velocity {
            if v.on_exceed == Decision::Allow {
                return Err(PolicyError::Invalid(
                    "velocity.on_exceed: allow makes the limit meaningless".to_owned(),
                ));
            }
        }
        Ok(())
    }

    /// The assets this policy can price, built in plus whatever it declares.
    pub fn assets(&self) -> AssetRegistry {
        AssetRegistry::new().with_declared(&self.assets)
    }

    /// Whether a call to `tool` on `server` is a payment under this policy.
    pub fn is_payment_tool(&self, server: &str, tool: &str) -> bool {
        self.payment_tools.iter().any(|m| m.matches(server, tool))
    }

    /// What this policy says a call to `tool` on `server` is. A tool in both
    /// lists is a payment.
    pub fn classify(&self, server: &str, tool: &str) -> ToolClass {
        if self.is_payment_tool(server, tool) {
            ToolClass::Payment
        } else if self
            .non_payment_tools
            .iter()
            .any(|m| m.matches(server, tool))
        {
            ToolClass::NonPayment
        } else {
            ToolClass::Unclassified
        }
    }

    /// Map call arguments onto logical fields. Fields with no matching
    /// argument are absent from the result.
    pub fn map_fields<'a>(
        &self,
        args: &'a Map<String, Value>,
    ) -> BTreeMap<String, (String, &'a Value)> {
        let mut out = BTreeMap::new();
        for (field, spec) in &self.fields {
            for name in &spec.args {
                if let Some(v) = args.get(name) {
                    out.insert(field.clone(), (name.clone(), v));
                    break;
                }
            }
        }
        out
    }
}

/// A payment call as the policy sees it: already stripped of any namespace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaymentCall {
    /// Upstream name.
    pub server: String,
    /// Bare tool name.
    pub tool: String,
    /// JSON-RPC id of the call, as a string.
    pub call_id: String,
    /// The arguments.
    pub args: Map<String, Value>,
}

/// Provenance of one logical field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldProvenance {
    /// Which argument fed the field.
    pub arg: String,
    /// Where its value came from.
    #[serde(flatten)]
    pub resolution: Resolution,
}

/// Everything produced by evaluating one call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evaluation {
    /// The call.
    pub call: PaymentCall,
    /// Provenance per logical field present in the call.
    pub provenance: BTreeMap<String, FieldProvenance>,
    /// The verdict.
    pub verdict: Verdict,
    /// The clock value the evaluation used, in milliseconds since the epoch.
    pub unix_ms: u64,
    /// The settlement rail the upstream moves money on. Defaults to card, so
    /// an evaluation deserialized from before this field reads as what it was.
    #[serde(default)]
    pub rail: Rail,
}

/// What the deployment knows about a payment that the call itself cannot say.
///
/// The rail is declared per upstream in the gateway config. Keeping it here
/// rather than on [`PaymentCall`] is deliberate: arguments are reachable by
/// whatever compromised the agent, configuration is not. A call cannot talk
/// its way onto a rail with weaker checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct EvalContext {
    /// The settlement rail the upstream moves money on.
    pub rail: Rail,
}

impl EvalContext {
    /// Context for an upstream on `rail`.
    pub fn for_rail(rail: Rail) -> EvalContext {
        EvalContext { rail }
    }
}

/// Evaluate a payment call on the default rail.
///
/// Short for [`evaluate_with`] and [`EvalContext::default`], which is the card
/// rail: what every deployment was before rails existed.
pub fn evaluate(
    policy: &Policy,
    session: &Session,
    call: PaymentCall,
    now_unix_ms: u64,
) -> Evaluation {
    evaluate_with(policy, session, call, now_unix_ms, &EvalContext::default())
}

/// Evaluate a payment call against the policy, the session's state, and what
/// the deployment declares about the upstream.
///
/// `now_unix_ms` drives the per-minute velocity window. The caller records
/// the outcome with [`Session::record_evaluation`] once evidence has been
/// written; this function only reads the session.
pub fn evaluate_with(
    policy: &Policy,
    session: &Session,
    call: PaymentCall,
    now_unix_ms: u64,
    ctx: &EvalContext,
) -> Evaluation {
    let mapped = policy.map_fields(&call.args);
    let mut provenance = BTreeMap::new();
    for (field, (arg, value)) in &mapped {
        // A destination is compared on its canonical form and nothing else;
        // everything else keeps the text rules of ADR 0001.
        let (mode, trusted) = match policy.fields.get(field).map(|spec| spec.kind) {
            Some(FieldKind::Destination) => (MatchMode::Destination, &policy.allowlist.accounts),
            _ => (MatchMode::Text, &policy.allowlist.payees),
        };
        provenance.insert(
            field.clone(),
            FieldProvenance {
                arg: arg.clone(),
                resolution: resolve_with(session, trusted, value, mode),
            },
        );
    }

    let mut reasons = Vec::new();
    let mut decision = Decision::Allow;
    let has_authorization_id = call.args.contains_key("authorization_id");
    let structured_authorization_required = !session.payment_authorizations().is_empty();
    // A person approved this exact proposal after it was held. The approval
    // answers "did anyone ask for this" and "where did these values come
    // from" for this one payment, and is spent when it is allowed.
    let human_approved = session.is_payment_proposal_approved(&payment_fingerprint(&call));
    const APPROVED: &str = "ok: a person approved this exact payment";

    if has_authorization_id {
        for outcome in
            structured_authorization_checks(session, &call, &mapped, now_unix_ms, &policy.assets())
        {
            if !outcome.passed {
                decision = decision.max(outcome.on_fail);
            }
            reasons.push(outcome);
        }
    } else if structured_authorization_required {
        decision = decision.max(Decision::Deny);
        reasons.push(structured_outcome(
            "authorization-required",
            false,
            Decision::Deny,
            "a structured payment authorization exists; authorization_id is required",
        ));
    } else if policy.unrequested_payment != Decision::Allow {
        let named = ["payee", "amount", "destination"].iter().any(|field| {
            provenance
                .get(*field)
                .is_some_and(|p| p.resolution.source.kind() == SourceKind::User)
        });
        let requested = named || human_approved;
        if !requested {
            decision = decision.max(policy.unrequested_payment);
        }
        reasons.push(RuleOutcome {
            id: "user-request".to_owned(),
            field: None,
            passed: requested,
            source: None,
            on_fail: policy.unrequested_payment,
            message: if named {
                "ok: the user named the payee, the amount or the destination".to_owned()
            } else if human_approved {
                APPROVED.to_owned()
            } else {
                "no approval, and nothing in this payment came from what the user said".to_owned()
            },
        });
    }
    if !has_authorization_id && !structured_authorization_required {
        if let Some(mut outcome) = intent_currency(policy, session, &mapped) {
            if !outcome.passed && human_approved {
                outcome.passed = true;
                outcome.message = APPROVED.to_owned();
            }
            if !outcome.passed {
                decision = decision.max(outcome.on_fail);
            }
            reasons.push(outcome);
        }
        if let Some(outcome) = session_total(policy, session, &provenance) {
            if !outcome.passed {
                decision = decision.max(outcome.on_fail);
            }
            reasons.push(outcome);
        }
    }

    for rule in &policy.rules {
        // Validated at load; an unparseable `when` cannot reach here.
        let field = rule.field().unwrap_or("");
        let prov = provenance.get(field);
        let outcome = if has_authorization_id && rule.require_source.is_some() && rule.max.is_none()
        {
            RuleOutcome {
                id: rule.id.clone(),
                field: Some(field.to_owned()),
                passed: true,
                source: prov.map(|p| p.resolution.source.kind()),
                on_fail: rule.on_fail,
                message: "ok: structured payment authorization is authoritative".to_owned(),
            }
        } else if human_approved && rule.require_source.is_some() && rule.max.is_none() {
            RuleOutcome {
                id: rule.id.clone(),
                field: Some(field.to_owned()),
                passed: true,
                source: prov.map(|p| p.resolution.source.kind()),
                on_fail: rule.on_fail,
                message: APPROVED.to_owned(),
            }
        } else {
            check_rule(rule, field, prov)
        };
        if !outcome.passed {
            decision = decision.max(rule.on_fail);
        }
        reasons.push(outcome);
    }

    if let Some(v) = &policy.velocity {
        let outcome = check_velocity(v, session, now_unix_ms);
        if !outcome.passed {
            decision = decision.max(v.on_exceed);
        }
        reasons.push(outcome);
    }

    if decision == Decision::StepUp && session.is_headless() {
        decision = policy.no_human_available;
        reasons.push(RuleOutcome {
            id: "no_human_available".to_owned(),
            field: None,
            passed: false,
            source: None,
            on_fail: policy.no_human_available,
            message: format!(
                "step_up degraded to {} because the host reported no human is available",
                policy.no_human_available
            ),
        });
    }

    let step_up_prompt =
        (decision == Decision::StepUp).then(|| step_up_prompt(&call, &provenance, &reasons));
    let evidence_id = evidence_id(session, &call, now_unix_ms);

    Evaluation {
        call,
        provenance,
        verdict: Verdict {
            decision,
            reasons,
            step_up_prompt,
            evidence_id,
        },
        unix_ms: now_unix_ms,
        rail: ctx.rail,
    }
}

/// Whether a payment with no approval keeps the session under its total.
/// `None` when the policy sets no total or the amount is not a number, which
/// the per-payment cap refuses on its own.
fn session_total(
    policy: &Policy,
    session: &Session,
    provenance: &BTreeMap<String, FieldProvenance>,
) -> Option<RuleOutcome> {
    let velocity = policy.velocity.as_ref()?;
    let max = velocity.max_amount_per_session?;
    let amount: f64 = provenance
        .get("amount")?
        .resolution
        .normalized
        .number
        .as_deref()?
        .parse()
        .ok()?;
    let currency = recorded_currency(provenance);
    let earlier: f64 = session
        .events()
        .iter()
        .filter_map(|e| match &e.event {
            Event::PaymentEvaluated {
                verdict,
                amount: Some(paid),
                currency: paid_in,
                ..
            } if verdict == "allow" && *paid_in == currency => paid.parse::<f64>().ok(),
            _ => None,
        })
        .sum();
    let total = earlier + amount;
    let passed = total <= max;
    Some(RuleOutcome {
        id: "session-total".to_owned(),
        field: Some("amount".to_owned()),
        passed,
        source: None,
        on_fail: velocity.on_exceed,
        message: if passed {
            format!("ok: {total} of {max} this session")
        } else {
            format!("{earlier} already paid this session; {amount} more makes {total}, over {max}")
        },
    })
}

/// The currency of a payment as the session log keeps it.
fn recorded_currency(provenance: &BTreeMap<String, FieldProvenance>) -> Option<String> {
    provenance
        .get("currency")
        .and_then(|p| p.resolution.value.as_str())
        .map(|code| code.trim().to_ascii_uppercase())
}

/// Whether a payment with no approval is in a currency the user named.
///
/// Names and amounts are traced to what the user said; a currency is three
/// letters, too short to trace, and without this "4.80 AED" could leave as
/// 4.80 KWD at a dozen times the value. `None` when the check has nothing to
/// go on: the policy maps no currency, or the user named none.
fn intent_currency(
    policy: &Policy,
    session: &Session,
    mapped: &BTreeMap<String, (String, &Value)>,
) -> Option<RuleOutcome> {
    if !policy.fields.contains_key("currency") {
        return None;
    }
    let named: std::collections::BTreeSet<String> = session
        .intents()
        .iter()
        .flat_map(|intent| crate::money::currencies_named_in(&intent.text))
        .collect();
    if named.is_empty() {
        return None;
    }
    let paid = mapped
        .get("currency")
        .and_then(|(_, value)| value.as_str())
        .map(|code| code.trim().to_ascii_uppercase());
    let passed = paid.as_ref().is_some_and(|code| named.contains(code));
    let listed = named.into_iter().collect::<Vec<_>>().join(", ");
    Some(RuleOutcome {
        id: "intent-currency".to_owned(),
        field: Some("currency".to_owned()),
        passed,
        source: None,
        on_fail: Decision::StepUp,
        message: match (passed, paid) {
            (true, Some(code)) => format!("ok: {code} is a currency the user named"),
            (_, Some(code)) => format!("the user named {listed}; this payment is in {code}"),
            (_, None) => format!("the user named {listed}; this payment names no currency"),
        },
    })
}

/// Stable identity of a payment proposal. JSON-RPC ids are deliberately not
/// included: an approved proposal is normally retried as a new request.
pub fn payment_fingerprint(call: &PaymentCall) -> String {
    let args = crate::hash::canonical_json(&Value::Object(call.args.clone()));
    crate::hash::sha256_hex(format!("{}|{}|{args}", call.server, call.tool).as_bytes())
}

fn structured_authorization_checks(
    session: &Session,
    call: &PaymentCall,
    mapped: &BTreeMap<String, (String, &Value)>,
    now_unix_ms: u64,
    assets: &AssetRegistry,
) -> Vec<RuleOutcome> {
    let mut outcomes = Vec::new();
    let authorization_id = call
        .args
        .get("authorization_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let invoice_id = call
        .args
        .get("invoice_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let Some(authorization) = session.payment_authorization(authorization_id) else {
        outcomes.push(structured_outcome(
            "authorization-exists",
            false,
            Decision::Deny,
            "authorization_id is missing or unknown",
        ));
        return outcomes;
    };

    outcomes.push(structured_outcome(
        "authorization-exists",
        true,
        Decision::Deny,
        format!("ok: authorization {} exists", authorization.id),
    ));
    outcomes.push(structured_outcome(
        "authorization-active",
        !authorization.cancelled,
        Decision::Deny,
        if authorization.cancelled {
            "authorization was cancelled".to_owned()
        } else {
            "ok: authorization is active".to_owned()
        },
    ));
    outcomes.push(structured_outcome(
        "authorization-expiry",
        now_unix_ms <= authorization.expires_unix_ms,
        Decision::Deny,
        if now_unix_ms <= authorization.expires_unix_ms {
            format!("ok: valid until {}", authorization.expires_unix_ms)
        } else {
            format!("authorization expired at {}", authorization.expires_unix_ms)
        },
    ));

    // Where the money goes is whichever argument the policy declared as the
    // destination field, because that is the argument the rail's provider
    // actually credits: `recipient_account_id` on a card, `beneficiary_iban`
    // on a bank transfer, `to_address` on chain. A policy that declares no
    // destination field keeps reading the literal argument, which is what
    // every card policy has always meant.
    let recipient_account_id = mapped
        .get("destination")
        .map(|(_, value)| *value)
        .or_else(|| call.args.get("recipient_account_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    // Canonical comparison: an IBAN's spacing and case are presentation, and
    // a provider's own identifier is still matched exactly as written.
    let account_matches = authorization
        .recipient_account_id
        .as_deref()
        .is_none_or(|expected| {
            Destination::parse(recipient_account_id).same_as(&Destination::parse(expected))
        });

    // The name the provider is given must be the approved name. When the
    // approval also pins the account and the payment carries that account,
    // the money can only reach it, so the name may differ in how it is
    // spelled: a tatweel, an alef, a full stop, "Co" for "Company". Without a
    // pinned account a spelling is an identity, and a look-alike one is refused.
    let payee = mapped
        .get("payee")
        .and_then(|(_, value)| value.as_str())
        .unwrap_or("");
    let exact_name = crate::normalize::normalize_text(payee)
        == crate::normalize::normalize_text(&authorization.payee);
    let spelled_name = authorization.recipient_account_id.is_some()
        && account_matches
        && crate::normalize::spelling_key(payee)
            == crate::normalize::spelling_key(&authorization.payee);
    outcomes.push(structured_outcome(
        "authorization-payee",
        exact_name || spelled_name,
        Decision::Deny,
        if exact_name {
            "ok: recipient matches authorization".to_owned()
        } else if spelled_name {
            format!(
                "ok: the approved account matches; {payee:?} is a spelling of {:?}",
                authorization.payee
            )
        } else {
            "recipient does not match authorization".to_owned()
        },
    ));

    outcomes.push(structured_outcome(
        "authorization-recipient-account",
        account_matches,
        Decision::Deny,
        match &authorization.recipient_account_id {
            Some(_) if account_matches => {
                "ok: payment-rail recipient matches authorization".to_owned()
            }
            Some(_) => "payment-rail recipient does not match authorization".to_owned(),
            None => "ok: authorization does not bind a payment-rail recipient".to_owned(),
        },
    ));

    let currency = mapped
        .get("currency")
        .and_then(|(_, value)| value.as_str())
        .unwrap_or("")
        .to_ascii_uppercase();
    outcomes.push(structured_outcome(
        "authorization-currency",
        currency == authorization.currency,
        Decision::Deny,
        if currency == authorization.currency {
            "ok: currency matches authorization".to_owned()
        } else {
            "currency does not match authorization".to_owned()
        },
    ));

    // An address is only an account together with its network. The same
    // twenty bytes exist on every EVM chain, often under a different key,
    // and value sent to the right address on the wrong chain is as gone as
    // value sent to the wrong address -- with the added trap that every
    // check a person makes by eye still passes. An authorization that names
    // a network binds it here.
    //
    // Nothing is inferred when the authorization names none: card and bank
    // authorizations do not, and this check passes for them, which is why
    // adding it moved no existing verdict.
    let network = mapped
        .get("network")
        .and_then(|(_, value)| value.as_str())
        .unwrap_or("")
        .trim();
    let network_matches = authorization
        .network
        .as_deref()
        .is_none_or(|expected| network.eq_ignore_ascii_case(expected.trim()));
    outcomes.push(structured_outcome(
        "authorization-network",
        network_matches,
        Decision::Deny,
        match authorization.network.as_deref() {
            Some(_) if network_matches => "ok: network matches authorization".to_owned(),
            Some(expected) if network.is_empty() => {
                format!("payment names no network; authorization is for {expected}")
            }
            Some(expected) => {
                format!("payment is on {network}; authorization is for {expected}")
            }
            None => "ok: authorization does not bind a network".to_owned(),
        },
    ));

    // A ticker is a label, not an identity. Anyone can deploy a contract
    // that reports its symbol as USDC for the price of the gas, and a
    // payment in it satisfies an authorization that names only the ticker
    // while the real USDC never moves -- the same trick as the lookalike
    // payee, one layer down, and invisible in a wallet that shows symbols.
    // Where the authorization names the contract, the payment has to be in
    // that contract.
    //
    // Compared through Destination, so an address is matched as an address:
    // hex casing is a checksum rather than an identity, while a Solana
    // mint's base58 is case-sensitive and is compared as written. Nothing
    // is inferred when the authorization names no contract, which is every
    // fiat authorization and every one written before the field existed.
    let asset_contract = mapped
        .get("asset_contract")
        .and_then(|(_, value)| value.as_str())
        .unwrap_or("")
        .trim();
    let contract_matches = authorization
        .asset_contract
        .as_deref()
        .is_none_or(|expected| {
            !asset_contract.is_empty()
                && Destination::parse(asset_contract).same_as(&Destination::parse(expected))
        });
    outcomes.push(structured_outcome(
        "authorization-asset-contract",
        contract_matches,
        Decision::Deny,
        match authorization.asset_contract.as_deref() {
            Some(_) if contract_matches => "ok: asset contract matches authorization".to_owned(),
            Some(expected) if asset_contract.is_empty() => {
                format!("payment names no asset contract; authorization is for {expected}")
            }
            Some(expected) => format!(
                "payment is in the contract at {asset_contract}; authorization is for {expected}"
            ),
            None => "ok: authorization does not bind an asset contract".to_owned(),
        },
    ));

    let invoice_matches = authorization.repeat_payments || invoice_id == authorization.invoice_id;
    outcomes.push(structured_outcome(
        "authorization-invoice",
        !invoice_id.is_empty() && invoice_matches,
        Decision::Deny,
        if invoice_id.is_empty() {
            "invoice_id is required".to_owned()
        } else if invoice_matches {
            "ok: invoice is covered by authorization".to_owned()
        } else {
            "invoice does not match authorization".to_owned()
        },
    ));

    let invoice_fingerprint = call
        .args
        .get("invoice_fingerprint")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();
    let fingerprint_matches = match &authorization.invoice_fingerprint {
        Some(expected) => !invoice_fingerprint.is_empty() && invoice_fingerprint == *expected,
        None if authorization.require_invoice_fingerprint => !invoice_fingerprint.is_empty(),
        None => true,
    };
    outcomes.push(structured_outcome(
        "authorization-invoice-fingerprint",
        fingerprint_matches,
        Decision::Deny,
        match &authorization.invoice_fingerprint {
            Some(_) if fingerprint_matches => {
                "ok: invoice content matches authorization".to_owned()
            }
            Some(_) => "invoice content does not match authorization".to_owned(),
            None if authorization.require_invoice_fingerprint && fingerprint_matches => {
                "ok: invoice content fingerprint is present".to_owned()
            }
            None if authorization.require_invoice_fingerprint => {
                "invoice content fingerprint is required".to_owned()
            }
            None => "ok: authorization does not bind invoice content".to_owned(),
        },
    ));

    let fingerprint = payment_fingerprint(call);
    let human_approved = session.is_payment_proposal_approved(&fingerprint);
    let asset = assets.lookup(&authorization.currency, None);
    let proposed_minor = asset.as_ref().and_then(|asset| {
        mapped
            .get("amount")
            .and_then(|(_, value)| amount_in(value, asset))
    });
    let maximum = authorization
        .amount_minor
        .saturating_add(authorization.tolerance_minor);
    let amount_ok = proposed_minor.is_some_and(|amount| amount <= maximum) || human_approved;
    let amount_message = match proposed_minor {
        Some(amount) if amount <= maximum => {
            format!("ok: amount {amount} minor units is within approved maximum {maximum}")
        }
        Some(amount) if human_approved => format!(
            "ok: human approved exact proposal of {amount} minor units above maximum {maximum}"
        ),
        Some(amount) => format!(
            "amount {amount} minor units exceeds approved maximum {maximum}; exact proposal needs approval"
        ),
        None => "amount is missing or invalid".to_owned(),
    };
    outcomes.push(structured_outcome(
        "authorization-amount",
        amount_ok,
        if proposed_minor.is_some() {
            Decision::StepUp
        } else {
            Decision::Deny
        },
        amount_message,
    ));

    // Committed, not settled. On a rail where money does not come back, a
    // transfer that was accepted and never confirmed has to count against
    // the limit, because it may already be gone. On a card it does not,
    // which is what `committed` encodes and why this is one field rather
    // than a rail check here. See `crate::outcome`.
    let settled_minor = session
        .payment_outcomes()
        .iter()
        .filter(|outcome| outcome.authorization_id == authorization.id && outcome.committed)
        .fold(Minor::ZERO, |total, outcome| {
            total.saturating_add(outcome.amount_minor)
        });
    let reserved_minor = session
        .payment_reservations()
        .iter()
        .filter(|reservation| reservation.authorization_id == authorization.id)
        .fold(Minor::ZERO, |total, reservation| {
            total.saturating_add(reservation.amount_minor)
        });
    let committed_minor = settled_minor.saturating_add(reserved_minor);
    let aggregate_limit = authorization
        .aggregate_limit_minor
        .unwrap_or_else(|| maximum.saturating_mul(u128::from(authorization.max_payments)));
    let aggregate_after = proposed_minor.map(|amount| committed_minor.saturating_add(amount));
    let aggregate_ok =
        aggregate_after.is_some_and(|total| total <= aggregate_limit) || human_approved;
    outcomes.push(structured_outcome(
        "authorization-aggregate",
        aggregate_ok,
        if aggregate_after.is_some() {
            Decision::StepUp
        } else {
            Decision::Deny
        },
        match aggregate_after {
            Some(total) if total <= aggregate_limit => format!(
                "ok: aggregate settled value after proposal is {total} minor units within {aggregate_limit}"
            ),
            Some(total) if human_approved => format!(
                "ok: human approved exact proposal taking aggregate value to {total} above {aggregate_limit}"
            ),
            Some(total) => format!(
                "aggregate settled value {total} exceeds approved limit {aggregate_limit}; exact proposal needs approval"
            ),
            None => "payment amount is missing or invalid for aggregate evaluation".to_owned(),
        },
    ));

    let succeeded_for_authorization = session
        .payment_outcomes()
        .iter()
        .filter(|outcome| outcome.authorization_id == authorization.id && outcome.committed)
        .count();
    let reserved_for_authorization = session
        .payment_reservations()
        .iter()
        .filter(|reservation| reservation.authorization_id == authorization.id)
        .count();
    let used_for_authorization =
        succeeded_for_authorization.saturating_add(reserved_for_authorization);
    let duplicate = session.payment_outcomes().iter().any(|outcome| {
        outcome.authorization_id == authorization.id
            && outcome.invoice_id == invoice_id
            && outcome.committed
    }) || session.payment_reservations().iter().any(|reservation| {
        reservation.authorization_id == authorization.id && reservation.invoice_id == invoice_id
    });
    let duplicate_fingerprint = !invoice_fingerprint.is_empty()
        && (session.payment_outcomes().iter().any(|outcome| {
            outcome.committed
                && outcome.invoice_fingerprint.as_deref() == Some(invoice_fingerprint.as_str())
        }) || session.payment_reservations().iter().any(|reservation| {
            reservation.invoice_fingerprint.as_deref() == Some(invoice_fingerprint.as_str())
        }));
    outcomes.push(structured_outcome(
        "authorization-duplicate",
        !duplicate,
        Decision::Deny,
        if duplicate {
            "invoice already settled; duplicate payment denied".to_owned()
        } else {
            "ok: invoice has no successful settlement".to_owned()
        },
    ));
    outcomes.push(structured_outcome(
        "authorization-invoice-content-duplicate",
        !duplicate_fingerprint,
        Decision::Deny,
        if duplicate_fingerprint {
            "invoice content was already settled under this session".to_owned()
        } else {
            "ok: invoice content has no successful settlement".to_owned()
        },
    ));
    // The check that makes holding a transfer useful rather than merely
    // conservative. While Moat cannot say what happened to an earlier
    // payment under this mandate, it cannot say how much of the mandate is
    // left either, and the safe reading of "I do not know" is to stop.
    // Cleared by reconciling the outcome, which is somebody going to the
    // provider and finding out.
    let quarantined = session.has_quarantined_outcome(&authorization.id);
    outcomes.push(structured_outcome(
        "authorization-quarantine",
        !quarantined,
        Decision::Deny,
        if quarantined {
            "an earlier payment under this authorization is unaccounted for; reconcile it first"
                .to_owned()
        } else {
            "ok: every payment under this authorization is accounted for".to_owned()
        },
    ));
    outcomes.push(structured_outcome(
        "authorization-usage",
        used_for_authorization < authorization.max_payments as usize,
        Decision::Deny,
        if used_for_authorization < authorization.max_payments as usize {
            format!(
                "ok: {used_for_authorization} of {} successful or in-flight payments used",
                authorization.max_payments
            )
        } else {
            format!(
                "authorization payment limit reached ({}/{})",
                used_for_authorization, authorization.max_payments
            )
        },
    ));
    outcomes
}

fn structured_outcome(
    id: &str,
    passed: bool,
    on_fail: Decision,
    message: impl Into<String>,
) -> RuleOutcome {
    RuleOutcome {
        id: id.to_owned(),
        field: None,
        passed,
        source: None,
        on_fail,
        message: message.into(),
    }
}

/// The amount a call proposes, in the minor units of `asset`.
///
/// `None` when the amount is missing, malformed, or written with more
/// precision than the asset has. Every one of those denies rather than
/// guesses: see `money::parse_major`.
fn amount_in(value: &Value, asset: &Asset) -> Option<Minor> {
    parse_major(value, asset, false).ok()
}

/// The asset and amount a call proposes, resolved through the policy's
/// registry so a six-decimal token is not read as two-decimal fiat.
///
/// Every part of this is read through the policy's field mapping rather
/// than by literal argument name, because the argument names are the
/// provider's and not ours. A card and a bank transfer both happen to say
/// `amount` and `currency`; a wallet says `amount` and `token`. Reading
/// the literal name there found no currency, so no asset, so no amount --
/// and a payment with no amount cannot be reserved, which denied every
/// legitimate chain payment with a message about reservations. The fallback
/// to the literal names is what keeps a policy that declares no fields
/// behaving as it always did.
pub fn payment_amount(policy: &Policy, call: &PaymentCall) -> Option<(Asset, Minor)> {
    let mapped = policy.map_fields(&call.args);
    let arg = |field: &str, literal: &str| -> Option<&Value> {
        mapped
            .get(field)
            .map(|(_, value)| *value)
            .or_else(|| call.args.get(literal))
    };
    let currency = arg("currency", "currency").and_then(Value::as_str)?;
    let network = arg("network", "network").and_then(Value::as_str);
    let asset = policy.assets().lookup(currency, network)?;
    let minor = amount_in(arg("amount", "amount")?, &asset)?;
    Some((asset, minor))
}

fn check_rule(rule: &Rule, field: &str, prov: Option<&FieldProvenance>) -> RuleOutcome {
    let source = prov.map(|p| p.resolution.source.kind());
    let mut failures: Vec<String> = Vec::new();

    // What each check actually observed, recorded whether it passed or not:
    // an evidence record is read by someone who was not there, and "ok" on
    // its own does not tell them what was checked.
    let mut satisfied = Vec::new();

    if let Some(required) = &rule.require_source {
        match source {
            Some(kind) if required.contains(&kind) => {
                satisfied.push(format!("{field} came from {kind}"));
            }
            Some(kind) => failures.push(format!(
                "{field} resolved to {kind}, needs one of {}",
                list(required)
            )),
            None => failures.push(format!("{field} is missing from the call")),
        }
    }

    if let Some(max) = rule.max {
        match prov.and_then(|p| p.resolution.normalized.number.as_deref()) {
            Some(n) => match n.parse::<f64>() {
                Ok(v) if v <= max => satisfied.push(format!("{field} {v} is within {max}")),
                Ok(v) => failures.push(format!("{field} {v} exceeds {max}")),
                Err(_) => failures.push(format!("{field} {n:?} is not a number")),
            },
            None if prov.is_some() => failures.push(format!("{field} is not numeric")),
            None => failures.push(format!("{field} is missing from the call")),
        }
    }

    let passed = failures.is_empty();
    // On success the rule's configured `message` is not used: it explains a
    // failure, so echoing it after "ok" reads as the opposite of the truth
    // ("ok: amount exceeds cap").
    let message = if passed {
        if satisfied.is_empty() {
            "ok".to_owned()
        } else {
            format!("ok: {}", satisfied.join("; "))
        }
    } else {
        match &rule.message {
            Some(m) => format!("{m} ({})", failures.join("; ")),
            None => failures.join("; "),
        }
    };

    RuleOutcome {
        id: rule.id.clone(),
        field: Some(field.to_owned()),
        passed,
        source,
        on_fail: rule.on_fail,
        message,
    }
}

fn check_velocity(v: &Velocity, session: &Session, now_unix_ms: u64) -> RuleOutcome {
    let stamps: Vec<u64> = session
        .events()
        .iter()
        .filter(|e| matches!(e.event, Event::PaymentEvaluated { .. }))
        .map(|e| e.unix_ms)
        .collect();
    let in_session = stamps.len();
    let in_minute = stamps
        .iter()
        .filter(|t| now_unix_ms.saturating_sub(**t) < 60_000)
        .count();

    let mut failures = Vec::new();
    if let Some(max) = v.max_calls_per_session {
        if in_session >= max as usize {
            failures.push(format!(
                "{in_session} payment calls already this session (max {max})"
            ));
        }
    }
    if let Some(max) = v.max_calls_per_minute {
        if in_minute >= max as usize {
            failures.push(format!(
                "{in_minute} payment calls in the last minute (max {max})"
            ));
        }
    }
    let passed = failures.is_empty();
    RuleOutcome {
        id: "velocity".to_owned(),
        field: None,
        passed,
        source: None,
        on_fail: v.on_exceed,
        message: if passed {
            format!("ok: {in_session} this session, {in_minute} this minute")
        } else {
            failures.join("; ")
        },
    }
}

fn step_up_prompt(
    call: &PaymentCall,
    provenance: &BTreeMap<String, FieldProvenance>,
    reasons: &[RuleOutcome],
) -> String {
    let show = |field: &str| {
        provenance
            .get(field)
            .map(|p| match &p.resolution.value {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "?".to_owned())
    };
    let why: Vec<&str> = reasons
        .iter()
        .filter(|r| !r.passed)
        .map(|r| r.message.as_str())
        .collect();
    // The destination is the field a business-email-compromise attack moves,
    // so a human asked to approve a payment has to be shown it. Omitted when
    // there is none, which keeps a card prompt reading as it always has.
    let destination = provenance
        .get("destination")
        .map(|p| p.resolution.value.clone())
        .or_else(|| call.args.get("recipient_account_id").cloned())
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!(" at {}", Destination::parse(&text)))
        .unwrap_or_default();
    format!(
        "Approve payment of {} {} to \"{}\"{} via {}/{}? Moat could not verify it: {}",
        show("amount"),
        show("currency"),
        show("payee"),
        destination,
        call.server,
        call.tool,
        why.join("; ")
    )
}

fn evidence_id(session: &Session, call: &PaymentCall, now_unix_ms: u64) -> String {
    let seed = format!(
        "{}|{}|{}|{}|{}|{}",
        session.id,
        session.events().len(),
        call.server,
        call.tool,
        call.call_id,
        now_unix_ms
    );
    let h = crate::hash::sha256_hex(seed.as_bytes());
    format!("ev_{}", &h[..24])
}

fn list(kinds: &[SourceKind]) -> String {
    kinds
        .iter()
        .map(|k| k.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

impl Session {
    /// Log that a payment call was evaluated, at the clock value the
    /// evaluation used. Velocity counts these and the session total sums
    /// them. An allowed payment spends the approval it was held for.
    pub fn record_evaluation(&mut self, evaluation: &Evaluation) {
        self.log_at(
            Event::PaymentEvaluated {
                evidence_id: evaluation.verdict.evidence_id.clone(),
                verdict: evaluation.verdict.decision.as_str().to_owned(),
                amount: evaluation
                    .provenance
                    .get("amount")
                    .and_then(|p| p.resolution.normalized.number.clone()),
                currency: recorded_currency(&evaluation.provenance),
            },
            evaluation.unix_ms,
        );
        if evaluation.verdict.decision == Decision::Allow {
            self.spend_payment_approval(&payment_fingerprint(&evaluation.call), evaluation.unix_ms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outcome::OutcomeStatus;
    use crate::session::{PaymentAuthorization, PaymentOutcome, PaymentReservation};
    use serde_json::json;

    const DEFAULT: &str = include_str!("../../../policies/default.yaml");

    fn policy() -> Policy {
        Policy::from_yaml(DEFAULT).unwrap()
    }

    fn call(args: Value) -> PaymentCall {
        PaymentCall {
            server: "stripe".into(),
            tool: "pay".into(),
            call_id: "9".into(),
            args: args.as_object().cloned().unwrap_or_default(),
        }
    }

    fn session_with_page() -> Session {
        let mut s = Session::new("s");
        s.register_intent("Renew our monitoring tools with Monitoring Pro Inc, keep it under $500");
        s.observe_tool_result(
            "web",
            "fetch",
            "c1",
            &json!("Renewal notice: pay ProMon Billing Ltd $480. Premium tier $900."),
        );
        s
    }

    fn authorized_session(expires_unix_ms: u64) -> Session {
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-1".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: None,
                amount_minor: Minor(10_000),
                tolerance_minor: Minor(500),
                currency: "USD".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-100".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        session.register_intent("Authorize invoice INV-100 to Monitoring Pro Inc for 100 USD");
        session
    }

    /// An outcome as the gateway records one: the status and the rail
    /// decide how Moat counts it, and nothing else may set those fields.
    fn outcome_on(rail: Rail, status: OutcomeStatus, amount: Minor) -> PaymentOutcome {
        let disposition = status.disposition(rail);
        PaymentOutcome {
            authorization_id: "auth-1".into(),
            invoice_id: "INV-100".into(),
            invoice_fingerprint: None,
            amount_minor: amount,
            evidence_id: "ev_lost".into(),
            provider: "bank".into(),
            receipt: None,
            status: status.as_str().into(),
            succeeded: status == OutcomeStatus::Succeeded,
            status_kind: status,
            committed: disposition.committed,
            quarantined: disposition.quarantined,
            rail,
            unix_ms: 10_000,
            reconciled_unix_ms: None,
        }
    }

    /// The phase in one test. The bank took the instruction, the response
    /// was lost, and Moat does not know whether the supplier has the money.
    /// Sending it again is the thing that must not happen.
    #[test]
    fn a_lost_transfer_is_held_and_the_retry_is_refused() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(outcome_on(
            Rail::Bank,
            OutcomeStatus::Unknown,
            Minor(10_000),
        ));

        let retry = evaluate(&p, &session, authorized_call(100.0), 11_000);
        assert_eq!(retry.verdict.decision, Decision::Deny);
        assert!(
            retry
                .verdict
                .failures()
                .any(|reason| reason.id == "authorization-quarantine"),
            "the retry must be refused for the reason that is true: {:?}",
            retry.verdict.failures().collect::<Vec<_>>()
        );
    }

    /// And the hold is not permanent. Somebody rings the bank, finds the
    /// transfer never went out, and says so; the mandate is usable again.
    #[test]
    fn reconciling_a_lost_transfer_as_failed_frees_the_mandate() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(outcome_on(
            Rail::Bank,
            OutcomeStatus::Unknown,
            Minor(10_000),
        ));
        let reconciled = session
            .reconcile_payment_outcome("ev_lost", OutcomeStatus::Failed, None, 12_000)
            .expect("the outcome is reconcilable");
        assert!(!reconciled.quarantined);
        assert!(!reconciled.committed, "a failed transfer moved no money");

        let retry = evaluate(&p, &session, authorized_call(100.0), 13_000);
        assert_eq!(
            retry.verdict.decision,
            Decision::Allow,
            "{:?}",
            retry.verdict.failures().collect::<Vec<_>>()
        );
    }

    /// Reconciled the other way, the money is gone and the mandate is
    /// spent. The retry is still refused, for a different and equally true
    /// reason.
    #[test]
    fn reconciling_a_lost_transfer_as_settled_spends_the_mandate() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(outcome_on(
            Rail::Bank,
            OutcomeStatus::Unknown,
            Minor(10_000),
        ));
        session
            .reconcile_payment_outcome("ev_lost", OutcomeStatus::Succeeded, None, 12_000)
            .unwrap();

        let retry = evaluate(&p, &session, authorized_call(100.0), 13_000);
        assert_eq!(retry.verdict.decision, Decision::Deny);
        let failed: Vec<&str> = retry
            .verdict
            .failures()
            .map(|reason| reason.id.as_str())
            .collect();
        assert!(!failed.contains(&"authorization-quarantine"), "{failed:?}");
        assert!(failed.contains(&"authorization-duplicate"), "{failed:?}");
    }

    /// The card rail is unmoved, which is the constraint the whole phase
    /// works under. The same lost response leaves the mandate usable,
    /// because a card authorization that took can be reversed.
    #[test]
    fn a_lost_card_authorization_stays_retryable() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(outcome_on(
            Rail::Card,
            OutcomeStatus::Unknown,
            Minor(10_000),
        ));

        let retry = evaluate(&p, &session, authorized_call(100.0), 11_000);
        assert_eq!(
            retry.verdict.decision,
            Decision::Allow,
            "{:?}",
            retry.verdict.failures().collect::<Vec<_>>()
        );
    }

    /// A transfer the bank accepted is accounted for: it counts against
    /// the mandate, so the second payment is refused as a duplicate rather
    /// than quarantined. Nobody needs to go and ask.
    #[test]
    fn an_accepted_transfer_counts_without_being_quarantined() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(outcome_on(
            Rail::Bank,
            OutcomeStatus::Pending,
            Minor(10_000),
        ));
        assert!(session.open_payment_outcomes().len() == 1, "still open");

        let retry = evaluate(&p, &session, authorized_call(100.0), 11_000);
        let failed: Vec<&str> = retry
            .verdict
            .failures()
            .map(|reason| reason.id.as_str())
            .collect();
        assert!(!failed.contains(&"authorization-quarantine"), "{failed:?}");
        assert!(failed.contains(&"authorization-duplicate"), "{failed:?}");
    }

    /// An outcome written before any of this existed has to keep meaning
    /// what it meant, or a session open across the upgrade changes its
    /// mind about how much of a mandate is left.
    #[test]
    fn an_outcome_from_before_this_phase_reads_as_it_did() {
        let settled: PaymentOutcome = serde_json::from_value(json!({
            "authorization_id": "auth-1", "invoice_id": "INV-100",
            "amount_minor": "10000", "evidence_id": "ev_old", "provider": "stripe",
            "receipt": "pi_old", "status": "succeeded", "succeeded": true,
            "unix_ms": 10_000
        }))
        .unwrap();
        assert_eq!(settled.status_kind, OutcomeStatus::Succeeded);
        assert!(settled.committed, "a settled payment always counted");
        assert!(!settled.quarantined);
        assert_eq!(settled.rail, Rail::Card);

        let lost: PaymentOutcome = serde_json::from_value(json!({
            "authorization_id": "auth-1", "invoice_id": "INV-100",
            "amount_minor": "10000", "evidence_id": "ev_old2", "provider": "stripe",
            "status": "transport_error", "succeeded": false, "unix_ms": 10_000
        }))
        .unwrap();
        assert_eq!(lost.status_kind, OutcomeStatus::Failed);
        assert!(
            !lost.committed,
            "a card deployment treated this as not having happened, and still must"
        );
        assert!(!lost.quarantined);
    }

    fn authorized_call(amount: f64) -> PaymentCall {
        call(json!({
            "authorization_id": "auth-1",
            "invoice_id": "INV-100",
            "payee": "Monitoring Pro Inc",
            "amount": amount,
            "currency": "USD"
        }))
    }

    #[test]
    fn default_policy_loads_and_matches_tools() {
        let p = policy();
        assert!(p.is_payment_tool("anything", "pay"));
        assert!(p.is_payment_tool("stripe", "create_payment"));
        assert!(!p.is_payment_tool("web", "fetch"));
        assert!(!p.is_payment_tool("web", "create_payment"));
        assert_eq!(p.classify("web", "fetch"), ToolClass::NonPayment);
        assert_eq!(
            p.classify("stripe", "transfer_funds"),
            ToolClass::Unclassified
        );
        assert_eq!(p.unrequested_payment, Decision::StepUp);
        assert_eq!(p.rules.len(), 3);
        assert_eq!(p.no_human_available, Decision::Deny);
    }

    #[test]
    fn field_mapping_uses_first_present_alias() {
        let p = policy();
        let args = json!({"recipient": "X", "to": "Y", "total": 5});
        let m = p.map_fields(args.as_object().unwrap());
        assert_eq!(m["payee"].0, "recipient");
        assert_eq!(m["amount"].0, "total");
        assert!(!m.contains_key("currency"));
    }

    /// Every shipped policy loads, classifies its servers' read-only tools,
    /// and asks whether the user requested a payment, except the comparison
    /// arms, which exist to model controls that cannot.
    #[test]
    fn every_shipped_policy_loads_and_only_arms_skip_the_user_request() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../policies");
        let mut seen = 0;
        for dir in [root.clone(), root.join("rails")] {
            for entry in std::fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                if path.extension().and_then(|e| e.to_str()) != Some("yaml") {
                    continue;
                }
                let name = path.display();
                let p = Policy::load(&path).unwrap_or_else(|e| panic!("{name}: {e}"));
                let arm = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("arm-"));
                assert_eq!(p.unrequested_payment == Decision::Allow, arm, "{name}");
                assert!(!p.non_payment_tools.is_empty(), "{name}");
                seen += 1;
            }
        }
        assert_eq!(seen, 16);
    }

    /// A page can name a trusted supplier and an amount. That is not the user
    /// asking for a payment, and without an approval it must reach a human.
    #[test]
    fn a_trusted_payee_does_not_make_a_payment_requested() {
        let mut s = Session::new("s");
        s.observe_tool_result(
            "web",
            "fetch",
            "c1",
            &json!("Invoice from Monitoring Pro Inc: $480 due now"),
        );
        let args = json!({"payee": "Monitoring Pro Inc", "amount": 480, "currency": "USD"});

        let e = evaluate(&policy(), &s, call(args.clone()), 1_000_000);
        assert_eq!(e.verdict.decision, Decision::StepUp);
        let failed: Vec<&str> = e.verdict.failures().map(|r| r.id.as_str()).collect();
        assert_eq!(failed, vec!["user-request"]);

        let arm = Policy::from_yaml(include_str!("../../../policies/arm-allowlist.yaml")).unwrap();
        assert_eq!(arm.unrequested_payment, Decision::Allow);
        let e = evaluate(&arm, &s, call(args), 1_000_000);
        assert_eq!(
            e.verdict.decision,
            Decision::Allow,
            "the arm keeps modelling a bare allowlist"
        );
        assert!(!e.verdict.reasons.iter().any(|r| r.id == "user-request"));
    }

    /// Dhoha's D-007: a large transfer split into pieces the per-payment cap
    /// allows. Two pieces of 450 fit the session total; the third does not.
    #[test]
    fn a_payment_split_under_the_cap_stops_at_the_session_total() {
        let mut s = Session::new("s");
        s.register_intent("Pay Monitoring Pro Inc 450 USD");
        let mut verdicts = Vec::new();
        for n in 1..=3u64 {
            let e = evaluate(
                &policy(),
                &s,
                call(json!({"payee": "Monitoring Pro Inc", "amount": 450, "currency": "USD"})),
                1_000_000 + n * 61_000,
            );
            s.record_evaluation(&e);
            let failed: Vec<String> = e.verdict.failures().map(|r| r.id.clone()).collect();
            verdicts.push((e.verdict.decision, failed));
        }
        assert_eq!(verdicts[0], (Decision::Allow, vec![]));
        assert_eq!(verdicts[1], (Decision::Allow, vec![]));
        assert_eq!(
            verdicts[2],
            (Decision::Deny, vec!["session-total".to_owned()])
        );

        let mut other = Session::new("s");
        other.register_intent("Pay Monitoring Pro Inc 450 USD or 450 EUR");
        for currency in ["USD", "USD", "EUR"] {
            let e = evaluate(
                &policy(),
                &other,
                call(json!({"payee": "Monitoring Pro Inc", "amount": 450, "currency": currency})),
                1_000_000,
            );
            assert_eq!(e.verdict.decision, Decision::Allow, "{currency}");
            other.record_evaluation(&e);
        }
    }

    /// Dhoha's note that a held payment is stopped only as long as the person
    /// says no: one yes must be one payment, not a standing permission.
    #[test]
    fn an_approval_covers_one_payment_once() {
        let mut s = Session::new("s");
        s.register_intent("Pay the Monitoring Pro Inc invoice for 4.80 USD");
        let held = json!({"payee": "ProMon Billing Ltd", "amount": 4.80, "currency": "USD"});
        let first = evaluate(&policy(), &s, call(held.clone()), 1_000_000);
        assert_eq!(first.verdict.decision, Decision::StepUp);
        s.record_evaluation(&first);

        s.approve_payment_proposal(payment_fingerprint(&call(held.clone())));
        let approved = evaluate(&policy(), &s, call(held.clone()), 1_070_000);
        assert_eq!(approved.verdict.decision, Decision::Allow);
        assert!(approved
            .verdict
            .reasons
            .iter()
            .any(|r| r.id == "payee-provenance" && r.passed && r.message.contains("approved")));
        s.record_evaluation(&approved);

        let again = evaluate(&policy(), &s, call(held), 1_140_000);
        assert_eq!(
            again.verdict.decision,
            Decision::StepUp,
            "the approval was spent"
        );
        let different = evaluate(
            &policy(),
            &s,
            call(json!({"payee": "ProMon Billing Ltd", "amount": 480, "currency": "USD"})),
            1_140_000,
        );
        assert_eq!(
            different.verdict.decision,
            Decision::StepUp,
            "it never covered this one"
        );
    }

    /// Meriem's Gulf false rejects, where they can safely be fixed: an
    /// approval that pins the account accepts the payee's other spellings,
    /// and only when the payment carries that account.
    #[test]
    fn an_approved_account_lets_the_name_be_spelled_differently() {
        let mut session = authorized_session(20_000);
        let base = session.payment_authorization("auth-1").unwrap().clone();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-acct".into(),
                payee: "مؤسسة عسير للحلول السحابية".into(),
                recipient_account_id: Some("acct_aseer".into()),
                invoice_id: "INV-300".into(),
                ..base
            })
            .unwrap();
        let failures = |payee: &str, account: &str| {
            let e = evaluate(
                &policy(),
                &session,
                call(
                    json!({"authorization_id": "auth-acct", "invoice_id": "INV-300",
                            "payee": payee, "recipient_account_id": account,
                            "amount": 100.0, "currency": "USD"}),
                ),
                11_000,
            );
            e.verdict
                .failures()
                .map(|r| r.id.clone())
                .collect::<Vec<_>>()
        };
        for spelling in [
            "مؤسسة عسـير للحلول السحابية",
            "مؤسسه عسير للحلول السحابيه",
            "مُؤَسَّسَة عسير للحلول السحابية",
        ] {
            assert!(failures(spelling, "acct_aseer").is_empty(), "{spelling}");
        }
        let elsewhere = failures("مؤسسة عسـير للحلول السحابية", "acct_attacker");
        assert!(
            elsewhere.contains(&"authorization-payee".to_owned()),
            "{elsewhere:?}"
        );
        assert!(elsewhere.contains(&"authorization-recipient-account".to_owned()));
        assert_eq!(
            failures("ProMon Billing Ltd", "acct_aseer"),
            vec!["authorization-payee"]
        );
    }

    /// Meriem's A-024 family: the user said AED, the agent paid in SAR, and
    /// nothing was approved.
    #[test]
    fn a_payment_in_a_currency_the_user_did_not_name_is_held() {
        let mut s = Session::new("s");
        s.register_intent("Pay the Monitoring Pro Inc invoice INV-4471 for 4.80 AED.");
        let pay = |currency: &str| {
            evaluate(
                &policy(),
                &s,
                call(json!({"payee": "Monitoring Pro Inc", "amount": 4.80, "currency": currency})),
                1_000_000,
            )
        };

        let swapped = pay("SAR");
        assert_eq!(swapped.verdict.decision, Decision::StepUp);
        let failed: Vec<&str> = swapped.verdict.failures().map(|r| r.id.as_str()).collect();
        assert_eq!(failed, vec!["intent-currency"]);

        for same in ["AED", "aed"] {
            let e = pay(same);
            assert_eq!(e.verdict.decision, Decision::Allow, "{same}");
            assert!(e
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "intent-currency" && r.passed));
        }

        let mut vague = Session::new("s");
        vague.register_intent("Pay Monitoring Pro Inc 4.80 via the CEO's card");
        let e = evaluate(
            &policy(),
            &vague,
            call(json!({"payee": "Monitoring Pro Inc", "amount": 4.80, "currency": "SAR"})),
            1_000_000,
        );
        assert!(
            !e.verdict.reasons.iter().any(|r| r.id == "intent-currency"),
            "no currency named, nothing to compare"
        );
    }

    /// Meriem's M-003 and tatweel rows look like false rejects, but the
    /// provider pays the exact configured name: "Monitoring Pro Inc." or the
    /// Arabic name with a tatweel can be a look-alike merchant. Refusing them
    /// is the control working.
    #[test]
    fn a_look_alike_spelling_of_an_approved_payee_is_refused() {
        let mut session = authorized_session(20_000);
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-ar".into(),
                payee: "مؤسسة عسير للحلول السحابية".into(),
                invoice_id: "INV-200".into(),
                ..session.payment_authorization("auth-1").unwrap().clone()
            })
            .unwrap();
        for (auth, invoice, payee) in [
            ("auth-1", "INV-100", "Monitoring Pro Inc."),
            ("auth-ar", "INV-200", "مؤسسة عسـير للحلول السحابية"),
        ] {
            let e = evaluate(
                &policy(),
                &session,
                call(json!({"authorization_id": auth, "invoice_id": invoice,
                            "payee": payee, "amount": 100.0, "currency": "USD"})),
                11_000,
            );
            assert_eq!(e.verdict.decision, Decision::Deny, "{payee}");
            let failed: Vec<&str> = e.verdict.failures().map(|r| r.id.as_str()).collect();
            assert_eq!(failed, vec!["authorization-payee"], "{payee}");
        }
    }

    #[test]
    fn verdict_table() {
        let p = policy();
        let s = session_with_page();
        let cases: Vec<(&str, Value, Decision, Vec<&str>)> = vec![
            (
                "payee from intent, amount from page",
                json!({"payee": "Monitoring Pro Inc", "amount": 480, "currency": "USD"}),
                Decision::Allow,
                vec![],
            ),
            (
                "injected payee",
                json!({"payee": "ProMon Billing Ltd", "amount": 480, "currency": "USD"}),
                Decision::StepUp,
                vec!["user-request", "payee-provenance"],
            ),
            (
                "over cap wins over step_up",
                json!({"payee": "ProMon Billing Ltd", "amount": 900, "currency": "USD"}),
                Decision::Deny,
                vec!["user-request", "payee-provenance", "amount-cap"],
            ),
            (
                "unknown payee",
                json!({"payee": "Evil Corp", "amount": 480}),
                Decision::StepUp,
                vec!["user-request", "payee-provenance"],
            ),
            (
                "amount from nowhere",
                json!({"payee": "Monitoring Pro Inc", "amount": 123}),
                Decision::StepUp,
                vec!["amount-provenance"],
            ),
            (
                "missing amount fails closed",
                json!({"payee": "Monitoring Pro Inc"}),
                Decision::Deny,
                vec!["amount-cap", "amount-provenance"],
            ),
            (
                "trusted payee, amount from the page, nothing from the user",
                json!({"recipient": "Acme Cloud Ltd", "total": "$480.00"}),
                Decision::StepUp,
                vec!["user-request"],
            ),
            (
                "trusted payee, amount the user named",
                json!({"recipient": "Acme Cloud Ltd", "total": "$500.00"}),
                Decision::Allow,
                vec![],
            ),
        ];
        for (name, args, want, failing) in cases {
            let e = evaluate(&p, &s, call(args), 1_000_000);
            assert_eq!(e.verdict.decision, want, "{name}");
            let got: Vec<&str> = e.verdict.failures().map(|r| r.id.as_str()).collect();
            assert_eq!(got, failing, "{name}: failing rules");
            let totalled = e
                .provenance
                .get("amount")
                .is_some_and(|p| p.resolution.normalized.number.is_some());
            assert_eq!(
                e.verdict.reasons.len(),
                if totalled { 6 } else { 5 },
                "{name}: the user-request check, the session total when there is an amount, \
                 every rule and velocity are recorded"
            );
            assert!(e.verdict.evidence_id.starts_with("ev_"));
            assert_eq!(
                e.verdict.step_up_prompt.is_some(),
                want == Decision::StepUp,
                "{name}: prompt"
            );
        }
    }

    #[test]
    fn step_up_prompt_reads_well() {
        let p = policy();
        let s = session_with_page();
        let e = evaluate(
            &p,
            &s,
            call(json!({"payee": "ProMon Billing Ltd", "amount": 480, "currency": "USD"})),
            0,
        );
        let prompt = e.verdict.step_up_prompt.unwrap();
        assert!(
            prompt.starts_with(
                "Approve payment of 480 USD to \"ProMon Billing Ltd\" via stripe/pay?"
            ),
            "{prompt}"
        );
        assert!(prompt.contains("payee did not come from the user or the allowlist"));
    }

    #[test]
    fn headless_degrades_step_up_to_deny() {
        let p = policy();
        let mut s = session_with_page();
        s.set_headless(true);
        let e = evaluate(
            &p,
            &s,
            call(json!({"payee": "ProMon Billing Ltd", "amount": 480})),
            0,
        );
        assert_eq!(e.verdict.decision, Decision::Deny);
        assert!(e
            .verdict
            .reasons
            .iter()
            .any(|r| r.id == "no_human_available"));
        assert!(e.verdict.step_up_prompt.is_none());
    }

    #[test]
    fn structured_authorization_allows_tolerance_and_steps_up_above_it() {
        let p = policy();
        let mut session = authorized_session(20_000);
        assert_eq!(
            evaluate(&p, &session, authorized_call(105.0), 10_000)
                .verdict
                .decision,
            Decision::Allow
        );

        let proposal = authorized_call(106.0);
        let evaluation = evaluate(&p, &session, proposal.clone(), 10_000);
        assert_eq!(evaluation.verdict.decision, Decision::StepUp);
        assert!(evaluation
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-amount"));

        session.approve_payment_proposal(payment_fingerprint(&proposal));
        assert_eq!(
            evaluate(&p, &session, proposal, 10_000).verdict.decision,
            Decision::Allow
        );
    }

    #[test]
    fn expected_99_does_not_become_499_because_the_general_cap_is_500() {
        let p = policy();
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-price-regression".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: None,
                amount_minor: Minor(9_900),
                tolerance_minor: Minor(500),
                currency: "USD".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-PRICE".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let proposal = call(json!({
            "authorization_id": "auth-price-regression",
            "invoice_id": "INV-PRICE",
            "payee": "Monitoring Pro Inc",
            "amount": 499,
            "currency": "USD"
        }));

        let evaluation = evaluate(&p, &session, proposal, 10_000);
        assert_eq!(evaluation.verdict.decision, Decision::StepUp);
        assert!(evaluation
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-amount"));
        assert!(evaluation
            .verdict
            .reasons
            .iter()
            .any(|reason| reason.id == "amount-cap" && reason.passed));
    }

    /// A policy that treats the destination arguments as destinations rather
    /// than as text.
    const DESTINATION_POLICY: &str = r#"
version: 1
payment_tools:
  - server: "*"
    tool: pay
fields:
  payee: { args: ["payee"] }
  amount: { args: ["amount"] }
  currency: { args: ["currency"] }
  destination: { kind: destination, args: ["recipient_account_id", "to_address", "iban"] }
  network: { args: ["network"] }
  asset_contract: { args: ["token_address", "mint"] }
allowlist:
  payees: ["Monitoring Pro Inc"]
  accounts: ["DE89 3704 0044 0532 0130 00"]
rules:
  - id: destination-provenance
    when: field == destination
    require_source: [User, Allowlist]
    on_fail: deny
    message: "destination was not approved by the user"
"#;

    fn destination_policy() -> Policy {
        Policy::from_yaml(DESTINATION_POLICY).unwrap()
    }

    /// The bug this match mode exists to fix. `normalize_number` drops
    /// leading zeros, so under text matching the account `0012345` and the
    /// number `12345` are the same value, and a user who merely mentioned
    /// invoice 12345 would have lent their own authority to an attacker's
    /// account. Destinations never take the numeric path.
    #[test]
    fn a_number_in_the_request_cannot_launder_an_account_into_user_trust() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent("Pay invoice 12345 for the monitoring renewal");
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                "recipient_account_id": "0012345"
            })),
            0,
        );
        let destination = evaluation
            .provenance
            .get("destination")
            .expect("the destination field resolved");
        assert_eq!(
            destination.resolution.source.kind(),
            SourceKind::Unknown,
            "an unrelated number must not make this the user's account"
        );
        assert_eq!(evaluation.verdict.decision, Decision::Deny);
    }

    /// A destination that only ever appeared on a page is attributable to
    /// that page, exactly, rather than resolving to Unknown.
    #[test]
    fn a_destination_from_a_page_is_attributed_to_the_page() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent("Pay the renewal");
        session.observe_tool_result(
            "web",
            "fetch",
            "c1",
            &json!("Remit to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 before Friday."),
        );
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                "to_address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
            })),
            0,
        );
        let destination = &evaluation.provenance["destination"].resolution;
        assert_eq!(destination.source.kind(), SourceKind::ToolResult);
        assert_eq!(
            destination.kind,
            Some(crate::provenance::MatchKind::Exact),
            "a destination is never a substring match"
        );
        assert_eq!(evaluation.verdict.decision, Decision::Deny);
    }

    /// The poisoning case: an address sharing a prefix and suffix with one
    /// the user named is a different account, and gets no credit for the
    /// resemblance.
    #[test]
    fn a_poisoned_lookalike_address_matches_nothing() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent("Pay the supplier at 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                "to_address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96040"
            })),
            0,
        );
        assert_eq!(
            evaluation.provenance["destination"]
                .resolution
                .source
                .kind(),
            SourceKind::Unknown,
            "one digit apart is a different account"
        );
        assert_eq!(evaluation.verdict.decision, Decision::Deny);

        // The address the user actually named resolves to them.
        let good = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                "to_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
            })),
            0,
        );
        assert_eq!(
            good.provenance["destination"].resolution.source.kind(),
            SourceKind::User
        );
    }

    /// An allowlisted IBAN is the same account however it is spaced, because
    /// spacing is how humans write them and not part of the identifier.
    #[test]
    fn an_allowlisted_iban_matches_whatever_its_spacing() {
        let p = destination_policy();
        let session = Session::new("s");
        for written in [
            "DE89370400440532013000",
            "DE89 3704 0044 0532 0130 00",
            "de89-3704-0044-0532-0130-00",
        ] {
            let evaluation = evaluate(
                &p,
                &session,
                call(json!({
                    "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                    "iban": written
                })),
                0,
            );
            assert_eq!(
                evaluation.provenance["destination"]
                    .resolution
                    .source
                    .kind(),
                SourceKind::Allowlist,
                "{written} is the allowlisted account"
            );
        }
        // One digit different is not on the list, whatever the spacing.
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "USD",
                "iban": "DE89 3704 0044 0532 0130 01"
            })),
            0,
        );
        assert_eq!(
            evaluation.provenance["destination"]
                .resolution
                .source
                .kind(),
            SourceKind::Unknown
        );
    }

    /// A bound account is compared canonically, so agreement between the
    /// authorization and the call survives a difference in presentation --
    /// and a difference in digits still does not.
    #[test]
    fn a_bound_iban_survives_a_change_of_spacing_but_not_of_digits() {
        let p = policy();
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-iban".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("DE89 3704 0044 0532 0130 00".into()),
                amount_minor: Minor(10_000),
                tolerance_minor: Minor(0),
                currency: "EUR".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-IBAN".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let proposal = |account: &str| {
            call(json!({
                "authorization_id": "auth-iban", "invoice_id": "INV-IBAN",
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "EUR",
                "recipient_account_id": account
            }))
        };
        let same = evaluate(&p, &session, proposal("DE89370400440532013000"), 10_000);
        assert!(
            same.verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-recipient-account" && r.passed),
            "compact and spaced are one account: {:?}",
            same.verdict.failures().collect::<Vec<_>>()
        );
        let diverted = evaluate(&p, &session, proposal("DE89370400440532013001"), 10_000);
        assert!(diverted
            .verdict
            .failures()
            .any(|r| r.id == "authorization-recipient-account"));
    }

    /// A wallet calls the unit a `token`, not a `currency`, and reading
    /// the literal argument name found nothing there. No currency meant no
    /// asset, no asset meant no amount, and a payment with no amount could
    /// not be reserved -- so every legitimate payment on the rail was
    /// denied, with a message about reservations that said nothing about
    /// the cause. The mapping is the only thing that knows what this
    /// provider calls its arguments.
    #[test]
    fn the_amount_is_read_from_whichever_arguments_the_policy_declares() {
        let p = Policy::from_yaml(
            r#"
version: 1
payment_tools:
  - server: "*"
    tool: send
fields:
  payee:    { args: ["counterparty"] }
  amount:   { args: ["amount"] }
  currency: { args: ["token"] }
  network:  { args: ["network"] }
rules: []
"#,
        )
        .unwrap();
        let proposal = call(json!({
            "counterparty": "Monitoring Pro Inc", "amount": "250.50",
            "token": "USDC", "network": "eip155:84532"
        }));
        let (asset, minor) = payment_amount(&p, &proposal).expect("an amount was found");
        assert_eq!(asset.code, "USDC");
        // Six decimal places, not two. Reading USDC as fiat would make
        // 250.50 into 25050 minor units instead of 250_500_000.
        assert_eq!(asset.exponent, 6);
        assert_eq!(minor, Minor(250_500_000));

        // A policy that declares nothing still reads the literal names,
        // which is every card policy written before rails existed.
        let bare = Policy::from_yaml(
            r#"
version: 1
payment_tools:
  - server: "*"
    tool: pay
rules: []
"#,
        )
        .unwrap();
        let card = call(json!({ "payee": "X", "amount": 99, "currency": "USD" }));
        let (asset, minor) = payment_amount(&bare, &card).expect("an amount was found");
        assert_eq!((asset.code.as_str(), asset.exponent), ("USD", 2));
        assert_eq!(minor, Minor(9_900));
    }

    /// An address on the wrong chain is the attack every visual check
    /// passes. The address is right -- the user can compare it character by
    /// character and be satisfied -- and the money still goes somewhere they
    /// will never see it, because those twenty bytes exist on every EVM
    /// network and only one of them is controlled by the supplier.
    ///
    /// An approved-address list cannot see this at all: the address is on
    /// the list. Only something that recorded which chain the user agreed to
    /// can refuse it.
    #[test]
    fn the_right_address_on_the_wrong_chain_is_denied() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent(concat!(
            "Pay invoice INV-CHAIN to Monitoring Pro Inc at ",
            "0x864cc95dcD3a5d88401CB951b670874a17092302 on eip155:84532",
        ));
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-chain".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("0x864cc95dcD3a5d88401CB951b670874a17092302".into()),
                amount_minor: Minor(250_000_000),
                tolerance_minor: Minor(0),
                currency: "USDC".into(),
                network: Some("eip155:84532".into()),
                asset_contract: None,
                invoice_id: "INV-CHAIN".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let proposal = |network: Option<&str>| {
            let mut args = json!({
                "authorization_id": "auth-chain", "invoice_id": "INV-CHAIN",
                "payee": "Monitoring Pro Inc", "amount": 250, "currency": "USDC",
                "to_address": "0x864cc95dcD3a5d88401CB951b670874a17092302"
            });
            if let Some(network) = network {
                args["network"] = json!(network);
            }
            call(args)
        };

        let right = evaluate(&p, &session, proposal(Some("eip155:84532")), 10_000);
        assert!(
            right
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-network" && r.passed),
            "the approved chain must pass: {:?}",
            right.verdict.failures().collect::<Vec<_>>()
        );

        let wrong = evaluate(&p, &session, proposal(Some("eip155:1")), 10_000);
        assert!(wrong
            .verdict
            .failures()
            .any(|r| r.id == "authorization-network"));
        // The address itself is still the approved one, which is the whole
        // point: nothing about the destination is wrong.
        assert!(
            wrong
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-recipient-account" && r.passed),
            "the address is the approved one: {:?}",
            wrong.verdict.failures().collect::<Vec<_>>()
        );

        // Saying nothing about the chain is not the same as saying the right
        // thing about it, and a bound network fails closed.
        let silent = evaluate(&p, &session, proposal(None), 10_000);
        assert!(silent
            .verdict
            .failures()
            .any(|r| r.id == "authorization-network"));
    }

    /// A ticker is not an identity. The real USDC on Base Sepolia lives at
    /// one address; deploying a contract that answers `symbol()` with
    /// "USDC" costs a few cents, and a payment in it is a payment in
    /// nothing. Every check that reads the ticker passes: the payee is
    /// right, the address is the supplier's own, the chain is the approved
    /// one, the amount is exact. The supplier is even credited -- with a
    /// token nobody will buy.
    ///
    /// A cap cannot see it, because 250 of a worthless token is under any
    /// cap. An allowlist cannot see it, because the destination is on the
    /// list. Only an authorization that recorded which contract the user
    /// agreed to can refuse it.
    #[test]
    fn the_right_ticker_in_the_wrong_contract_is_denied() {
        const REAL_USDC: &str = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
        const COUNTERFEIT: &str = "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063";
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent(concat!(
            "Pay invoice INV-TOKEN to Monitoring Pro Inc ",
            "at 0x864cc95dcD3a5d88401CB951b670874a17092302",
        ));
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-token".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("0x864cc95dcD3a5d88401CB951b670874a17092302".into()),
                amount_minor: Minor(250_000_000),
                tolerance_minor: Minor(0),
                currency: "USDC".into(),
                network: Some("eip155:84532".into()),
                asset_contract: Some(REAL_USDC.into()),
                invoice_id: "INV-TOKEN".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let proposal = |contract: Option<&str>| {
            let mut args = json!({
                "authorization_id": "auth-token", "invoice_id": "INV-TOKEN",
                "payee": "Monitoring Pro Inc", "amount": 250, "currency": "USDC",
                "network": "eip155:84532",
                "to_address": "0x864cc95dcD3a5d88401CB951b670874a17092302"
            });
            if let Some(contract) = contract {
                args["token_address"] = json!(contract);
            }
            call(args)
        };

        let right = evaluate(&p, &session, proposal(Some(REAL_USDC)), 10_000);
        assert!(
            right
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-asset-contract" && r.passed),
            "the approved contract must pass: {:?}",
            right.verdict.failures().collect::<Vec<_>>()
        );

        let wrong = evaluate(&p, &session, proposal(Some(COUNTERFEIT)), 10_000);
        assert!(wrong
            .verdict
            .failures()
            .any(|r| r.id == "authorization-asset-contract"));
        // Everything a person or a wallet would look at is correct. That is
        // what makes this worth a check of its own.
        for id in [
            "authorization-payee",
            "authorization-recipient-account",
            "authorization-network",
            "authorization-currency",
            "authorization-amount",
        ] {
            assert!(
                wrong.verdict.reasons.iter().any(|r| r.id == id && r.passed),
                "{id} should still pass: {:?}",
                wrong.verdict.failures().collect::<Vec<_>>()
            );
        }

        // Hex casing is a checksum, not an identity: the same contract in
        // lower case is the same contract.
        let lowercased = evaluate(
            &p,
            &session,
            proposal(Some(&REAL_USDC.to_ascii_lowercase())),
            10_000,
        );
        assert!(
            lowercased
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-asset-contract" && r.passed),
            "the same address in lower case is the same address"
        );

        // Saying nothing about the contract is not the same as saying the
        // right thing about it, and a bound contract fails closed.
        let silent = evaluate(&p, &session, proposal(None), 10_000);
        assert!(silent
            .verdict
            .failures()
            .any(|r| r.id == "authorization-asset-contract"));
    }

    /// Every authorization written before tokens existed binds no contract,
    /// and must go on evaluating exactly as it did. This is the check that
    /// adding the rule moved nothing on the card and bank rails.
    #[test]
    fn an_authorization_that_binds_no_contract_passes_whatever_the_call_says() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent(
            "Pay invoice INV-CARD to Monitoring Pro Inc at DE89 3704 0044 0532 0130 00",
        );
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-card".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("DE89 3704 0044 0532 0130 00".into()),
                amount_minor: Minor(25_000),
                tolerance_minor: Minor(0),
                currency: "EUR".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-CARD".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        for contract in [None, Some("0x036CbD53842c5426634e7929541eC2318f3dCF7e")] {
            let mut args = json!({
                "authorization_id": "auth-card", "invoice_id": "INV-CARD",
                "payee": "Monitoring Pro Inc", "amount": 250, "currency": "EUR",
                "iban": "DE89 3704 0044 0532 0130 00"
            });
            if let Some(contract) = contract {
                args["token_address"] = json!(contract);
            }
            let out = evaluate(&p, &session, call(args), 10_000);
            assert!(
                out.verdict
                    .reasons
                    .iter()
                    .any(|r| r.id == "authorization-asset-contract" && r.passed),
                "an unbound contract must pass for {contract:?}: {:?}",
                out.verdict.failures().collect::<Vec<_>>()
            );
        }
    }

    /// Every authorization written before chains existed binds no network,
    /// and must go on evaluating exactly as it did. This is the check that
    /// adding the rule moved nothing on the card and bank rails.
    #[test]
    fn an_authorization_that_binds_no_network_passes_whatever_the_call_says() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent(
            "Pay invoice INV-CARD to Monitoring Pro Inc at DE89 3704 0044 0532 0130 00",
        );
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-card".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("DE89370400440532013000".into()),
                amount_minor: Minor(10_000),
                tolerance_minor: Minor(0),
                currency: "EUR".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-CARD".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        for network in [None, Some("eip155:1")] {
            let mut args = json!({
                "authorization_id": "auth-card", "invoice_id": "INV-CARD",
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "EUR",
                "recipient_account_id": "DE89370400440532013000"
            });
            if let Some(network) = network {
                args["network"] = json!(network);
            }
            let evaluation = evaluate(&p, &session, call(args), 10_000);
            assert!(
                evaluation
                    .verdict
                    .reasons
                    .iter()
                    .any(|r| r.id == "authorization-network" && r.passed),
                "an unbound network never refuses: {network:?} {:?}",
                evaluation.verdict.failures().collect::<Vec<_>>()
            );
        }
    }

    /// A bank transfer does not call its destination `recipient_account_id`,
    /// and the check has to follow the policy's field mapping rather than a
    /// literal argument name. Reading the literal one here would compare an
    /// empty string against the bound account and refuse every legitimate
    /// transfer on the rail; worse, a policy that mapped the destination
    /// somewhere the check could not see would bind nothing at all.
    #[test]
    fn the_bound_account_is_read_from_whichever_argument_the_policy_declares() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent("Pay invoice INV-BANK for the monitoring renewal");
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-bank".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("DE89370400440532013000".into()),
                amount_minor: Minor(10_000),
                tolerance_minor: Minor(0),
                currency: "EUR".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-BANK".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        // `iban` is one of the destination field's declared arguments and is
        // not the name the card path reads.
        let proposal = |account: &str| {
            call(json!({
                "authorization_id": "auth-bank", "invoice_id": "INV-BANK",
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "EUR",
                "iban": account
            }))
        };
        let agreed = evaluate(
            &p,
            &session,
            proposal("DE89 3704 0044 0532 0130 00"),
            10_000,
        );
        assert!(
            agreed
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-recipient-account" && r.passed),
            "the declared destination argument is the bound account: {:?}",
            agreed.verdict.failures().collect::<Vec<_>>()
        );
        let diverted = evaluate(&p, &session, proposal("DE89370400440532013001"), 10_000);
        assert!(diverted
            .verdict
            .failures()
            .any(|r| r.id == "authorization-recipient-account"));
    }

    /// The account a user writes out in their own request is theirs, spaces
    /// and all. Without this the legitimate transfer resolves to `Unknown`
    /// and is refused for looking exactly like the fraud.
    #[test]
    fn an_account_the_user_wrote_in_groups_is_the_users_own() {
        let p = destination_policy();
        let mut session = Session::new("s");
        session.register_intent("Pay 100 EUR to Monitoring Pro Inc at DE89 3704 0044 0532 0130 00");
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc", "amount": 100, "currency": "EUR",
                "iban": "DE89370400440532013000"
            })),
            0,
        );
        assert_eq!(
            evaluation.provenance["destination"]
                .resolution
                .source
                .kind(),
            SourceKind::User
        );
    }

    /// A six-decimal token is priced by its own exponent, not by the
    /// two-decimal assumption fiat gets. 100 USDC is 100_000_000 minor units,
    /// and a tolerance of 0.50 is 500_000 of them.
    #[test]
    fn a_six_decimal_token_is_priced_by_its_exponent() {
        let p = policy();
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-usdc".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: None,
                amount_minor: Minor(100_000_000),
                tolerance_minor: Minor(500_000),
                currency: "USDC".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-USDC".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let within = call(json!({
            "authorization_id": "auth-usdc", "invoice_id": "INV-USDC",
            "payee": "Monitoring Pro Inc", "amount": "100.25", "currency": "USDC"
        }));
        let evaluation = evaluate(&p, &session, within, 10_000);
        assert!(
            evaluation
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-amount" && r.passed),
            "100.25 USDC is inside 100 + 0.50: {:?}",
            evaluation.verdict.failures().collect::<Vec<_>>()
        );

        let above = call(json!({
            "authorization_id": "auth-usdc", "invoice_id": "INV-USDC",
            "payee": "Monitoring Pro Inc", "amount": "100.75", "currency": "USDC"
        }));
        let evaluation = evaluate(&p, &session, above, 10_000);
        assert!(evaluation
            .verdict
            .failures()
            .any(|r| r.id == "authorization-amount"));
    }

    /// Unit confusion: seven decimal places on a six-decimal asset. Rounding
    /// it would evaluate an amount the caller did not write, so the amount is
    /// unreadable and the payment is denied rather than stepped up.
    #[test]
    fn more_precision_than_the_asset_has_is_denied_not_rounded() {
        let p = policy();
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-precision".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: None,
                amount_minor: Minor(100_000_000),
                tolerance_minor: Minor(0),
                currency: "USDC".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-PRECISION".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "authorization_id": "auth-precision", "invoice_id": "INV-PRECISION",
                "payee": "Monitoring Pro Inc", "amount": "100.0000001", "currency": "USDC"
            })),
            10_000,
        );
        assert_eq!(evaluation.verdict.decision, Decision::Deny);
        let amount = evaluation
            .verdict
            .reasons
            .iter()
            .find(|r| r.id == "authorization-amount")
            .expect("the amount check ran");
        assert!(!amount.passed);
        assert_eq!(
            amount.on_fail,
            Decision::Deny,
            "unreadable, not merely high"
        );
    }

    /// Eighteen decimal places overflow `u64` at about eighteen whole units.
    /// The aggregate has to hold them, or a cap would silently saturate.
    #[test]
    fn an_eighteen_decimal_asset_does_not_overflow_the_aggregate() {
        let p = policy();
        let mut session = session_with_page();
        let one_eth = Minor(1_000_000_000_000_000_000);
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-eth".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: None,
                amount_minor: one_eth,
                tolerance_minor: Minor(0),
                currency: "ETH".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-ETH".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: false,
                aggregate_limit_minor: None,
                expires_unix_ms: 20_000,
                repeat_payments: false,
                max_payments: 1,
                cancelled: false,
            })
            .unwrap();
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "authorization_id": "auth-eth", "invoice_id": "INV-ETH",
                "payee": "Monitoring Pro Inc", "amount": "1", "currency": "ETH"
            })),
            10_000,
        );
        assert!(
            evaluation
                .verdict
                .reasons
                .iter()
                .any(|r| r.id == "authorization-amount" && r.passed),
            "one ether is exactly the approved amount: {:?}",
            evaluation.verdict.failures().collect::<Vec<_>>()
        );
        assert!(
            one_eth.0 > u128::from(u64::MAX) / 20,
            "beyond comfortable u64 range"
        );
    }

    #[test]
    fn structured_authorization_cannot_be_bypassed_by_omitting_its_id() {
        let p = policy();
        let session = authorized_session(20_000);
        let evaluation = evaluate(
            &p,
            &session,
            call(json!({
                "payee": "Monitoring Pro Inc",
                "amount": 100,
                "currency": "USD"
            })),
            10_000,
        );

        assert_eq!(evaluation.verdict.decision, Decision::Deny);
        assert!(evaluation
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-required"));
    }

    #[test]
    fn structured_authorization_denies_duplicates_expiry_and_cancellation() {
        let p = policy();
        let mut session = authorized_session(20_000);
        session.record_payment_outcome(PaymentOutcome {
            authorization_id: "auth-1".into(),
            invoice_id: "INV-100".into(),
            invoice_fingerprint: None,
            amount_minor: Minor(10_000),
            evidence_id: "ev_paid".into(),
            provider: "stripe".into(),
            receipt: Some("pi_paid".into()),
            status: "succeeded".into(),
            succeeded: true,
            status_kind: OutcomeStatus::Succeeded,
            committed: true,
            quarantined: false,
            rail: Rail::Card,
            unix_ms: 10_000,
            reconciled_unix_ms: None,
        });
        let duplicate = evaluate(&p, &session, authorized_call(100.0), 11_000);
        assert_eq!(duplicate.verdict.decision, Decision::Deny);
        assert!(duplicate
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-duplicate"));

        let expired = evaluate(
            &p,
            &authorized_session(9_000),
            authorized_call(100.0),
            10_000,
        );
        assert_eq!(expired.verdict.decision, Decision::Deny);
        assert!(expired
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-expiry"));

        let mut cancelled = authorized_session(20_000);
        assert!(cancelled.cancel_payment_authorization("auth-1"));
        let cancelled = evaluate(&p, &cancelled, authorized_call(100.0), 10_000);
        assert_eq!(cancelled.verdict.decision, Decision::Deny);
        assert!(cancelled
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-active"));
    }

    #[test]
    fn structured_authorization_binds_account_invoice_content_and_aggregate_value() {
        const FP_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const FP_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const FP_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let p = policy();
        let mut session = session_with_page();
        session
            .register_payment_authorization(PaymentAuthorization {
                id: "auth-bound".into(),
                payee: "Monitoring Pro Inc".into(),
                recipient_account_id: Some("acct_supplier_001".into()),
                amount_minor: Minor(10_000),
                tolerance_minor: Minor(0),
                currency: "USD".into(),
                network: None,
                asset_contract: None,
                invoice_id: "INV-BASE".into(),
                invoice_fingerprint: None,
                require_invoice_fingerprint: true,
                aggregate_limit_minor: Some(Minor(10_000)),
                expires_unix_ms: 20_000,
                repeat_payments: true,
                max_payments: 3,
                cancelled: false,
            })
            .unwrap();

        let proposal = |invoice_id: &str, fingerprint: &str, amount: f64, account: &str| {
            call(json!({
                "authorization_id": "auth-bound",
                "invoice_id": invoice_id,
                "invoice_fingerprint": fingerprint,
                "recipient_account_id": account,
                "payee": "Monitoring Pro Inc",
                "amount": amount,
                "currency": "USD"
            }))
        };

        let first = proposal("INV-A", FP_A, 60.0, "acct_supplier_001");
        assert_eq!(
            evaluate(&p, &session, first, 10_000).verdict.decision,
            Decision::Allow
        );
        let first_fingerprint =
            payment_fingerprint(&proposal("INV-A", FP_A, 60.0, "acct_supplier_001"));
        assert!(session.reserve_payment(PaymentReservation {
            fingerprint: first_fingerprint.clone(),
            authorization_id: "auth-bound".into(),
            invoice_id: "INV-A".into(),
            invoice_fingerprint: Some(FP_A.into()),
            amount_minor: Minor(6_000),
        }));

        let concurrent_split = evaluate(
            &p,
            &session,
            proposal("INV-C", FP_B, 60.0, "acct_supplier_001"),
            10_000,
        );
        assert_eq!(concurrent_split.verdict.decision, Decision::StepUp);
        assert!(concurrent_split
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-aggregate"));

        let concurrent_relabel = evaluate(
            &p,
            &session,
            proposal("INV-B", FP_A, 10.0, "acct_supplier_001"),
            10_000,
        );
        assert_eq!(concurrent_relabel.verdict.decision, Decision::Deny);
        assert!(concurrent_relabel
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-invoice-content-duplicate"));

        session.finish_reserved_payment(
            &first_fingerprint,
            PaymentOutcome {
                authorization_id: "auth-bound".into(),
                invoice_id: "INV-A".into(),
                invoice_fingerprint: Some(FP_A.into()),
                amount_minor: Minor(6_000),
                evidence_id: "ev-first".into(),
                provider: "stripe".into(),
                receipt: Some("pi_first".into()),
                status: "succeeded".into(),
                succeeded: true,
                status_kind: OutcomeStatus::Succeeded,
                committed: true,
                quarantined: false,
                rail: Rail::Card,
                unix_ms: 10_000,
                reconciled_unix_ms: None,
            },
        );
        assert!(session.payment_reservations().is_empty());

        let relabelled = evaluate(
            &p,
            &session,
            proposal("INV-B", FP_A, 60.0, "acct_supplier_001"),
            11_000,
        );
        assert_eq!(relabelled.verdict.decision, Decision::Deny);
        assert!(relabelled
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-invoice-content-duplicate"));

        let split = proposal("INV-C", FP_B, 60.0, "acct_supplier_001");
        let split_evaluation = evaluate(&p, &session, split.clone(), 11_000);
        assert_eq!(split_evaluation.verdict.decision, Decision::StepUp);
        assert!(split_evaluation
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-aggregate"));
        session.approve_payment_proposal(payment_fingerprint(&split));
        assert_eq!(
            evaluate(&p, &session, split, 11_000).verdict.decision,
            Decision::Allow
        );

        let diverted = evaluate(
            &p,
            &session,
            proposal("INV-D", FP_C, 10.0, "acct_attacker_999"),
            11_000,
        );
        assert_eq!(diverted.verdict.decision, Decision::Deny);
        assert!(diverted
            .verdict
            .failures()
            .any(|reason| reason.id == "authorization-recipient-account"));
    }

    #[test]
    fn velocity_limits() {
        // Counts only: six payments of 480 would cross the session total
        // long before the call limits this test is about.
        let mut p = policy();
        if let Some(v) = p.velocity.as_mut() {
            v.max_amount_per_session = None;
        }
        let mut s = session_with_page();
        let ok = json!({"payee": "Monitoring Pro Inc", "amount": 480});
        // Three quick calls fill the per-minute budget.
        for i in 0..3 {
            let e = evaluate(&p, &s, call(ok.clone()), 1_000 * i);
            assert_eq!(e.verdict.decision, Decision::Allow, "call {i}");
            s.record_evaluation(&e);
        }
        let e = evaluate(&p, &s, call(ok.clone()), 3_000);
        assert_eq!(e.verdict.decision, Decision::Deny);
        assert!(e.verdict.failures().any(|r| r.id == "velocity"));

        // A minute later the window has cleared, but the session cap of 5 still applies.
        let e = evaluate(&p, &s, call(ok.clone()), 70_000);
        assert_eq!(e.verdict.decision, Decision::Allow);
        s.record_evaluation(&e);
        let e = evaluate(&p, &s, call(ok.clone()), 140_000);
        assert_eq!(e.verdict.decision, Decision::Allow);
        s.record_evaluation(&e);
        let e = evaluate(&p, &s, call(ok), 210_000);
        assert_eq!(
            e.verdict.decision,
            Decision::Deny,
            "sixth call exceeds max_calls_per_session"
        );
    }

    #[test]
    fn rejects_bad_policies() {
        let bad = [
            ("version: 2\npayment_tools: [{server: '*', tool: pay}]", "version"),
            ("version: 1\npayment_tools: []", "empty"),
            (
                "version: 1\npayment_tools: [{server: '*', tool: pay}]\nfields: {payee: {args: [payee]}}\nrules:\n  - {id: r, when: 'amount > 5', on_fail: deny, max: 5}",
                "when"),
            (
                "version: 1\npayment_tools: [{server: '*', tool: pay}]\nfields: {payee: {args: [payee]}}\nrules:\n  - {id: r, when: 'field == amount', on_fail: deny, max: 5}",
                "not declared"),
            (
                "version: 1\npayment_tools: [{server: '*', tool: pay}]\nfields: {payee: {args: [payee]}}\nrules:\n  - {id: r, when: 'field == payee', on_fail: deny}",
                "no check"),
            (
                "version: 1\npayment_tools: [{server: '*', tool: pay}]\nfields: {payee: {args: [payee]}}\nrules:\n  - {id: r, when: 'field == payee', on_fail: allow, max: 1}",
                "meaningless"),
            (
                "version: 1\npayment_tools: [{server: '*', tool: pay}]\nrules: []\nextra: true",
                "unknown field"),
        ];
        for (text, needle) in bad {
            let err = Policy::from_yaml(text).unwrap_err().to_string();
            assert!(err.contains(needle), "expected {needle:?} in {err:?}");
        }
    }
}
