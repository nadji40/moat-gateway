//! Checking what the model said against what the user wrote.
//!
//! The model is trusted to judge, not to report. It decides which name in the
//! message is the payee and which one the user refused, which it does well in
//! every language tried. It is not trusted to copy: every value it returns is
//! looked up in the message, and one that is not there is dropped.
//!
//! Every rule here removes something the user would otherwise be asking for.
//! None of them adds anything. A reader that is wrong in this direction costs
//! the user a confirmation and never costs them a payment.

use moat_core::money::is_currency_code;
use moat_core::normalize::{ascii_digits, normalize_number, spelling_key};
use moat_core::session::IntentFields;
use serde::{Deserialize, Serialize};

use crate::redact::Redacted;

/// What the model returns, before any of it is believed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelOutput {
    /// Payees the user asks to pay now.
    pub pay: Vec<String>,
    /// Payees the user refuses, cancels or calls a scam.
    pub refused: Vec<String>,
    /// The amount, as written.
    pub amount: Option<String>,
    /// The ISO 4217 code of the currency the user named.
    pub currency: Option<String>,
    /// Placeholders of the accounts or addresses the user asks to pay to.
    pub destinations: Vec<String>,
    /// Reference numbers: invoices, orders, tickets.
    pub references: Vec<String>,
    /// The user withdraws what they asked for before.
    pub cancels_previous: bool,
}

/// The fields that survived, and what did not with the reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grounded {
    /// What will be registered.
    pub fields: IntentFields,
    /// Every value dropped, with why.
    pub dropped: Vec<String>,
}

/// Currencies with three decimal places. In them "4,800" could be four
/// dinars and eight hundred fils or four thousand eight hundred dinars, and
/// the message does not say which.
const THREE_DECIMAL: &[&str] = &["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// Keep what the message supports.
pub fn ground(out: ModelOutput, message: &Redacted) -> Grounded {
    let text = message.for_model.as_str();
    let mut dropped = Vec::new();

    let refused: Vec<String> = out
        .refused
        .into_iter()
        .map(|r| restore(message, &r))
        .filter(|r| !r.trim().is_empty())
        .collect();

    let mut pay = Vec::new();
    for name in out.pay {
        let name = name.trim().to_owned();
        if name.is_empty() {
            continue;
        }
        if Redacted::looks_like_placeholder(&name) || name.chars().all(|c| !c.is_alphabetic()) {
            dropped.push(format!("pay {name:?}: not a name"));
        } else if !text.contains(name.as_str()) {
            dropped.push(format!("pay {name:?}: not written in the message"));
        } else if refused.iter().any(|r| covers(r, &name)) {
            dropped.push(format!("pay {name:?}: the user also refused it"));
        } else if !pay.contains(&name) {
            pay.push(name);
        }
    }

    let currency = out
        .currency
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| !c.is_empty());
    let currencies: Vec<String> = match currency {
        Some(code) if is_currency_code(&code) => vec![code],
        Some(code) => {
            dropped.push(format!("currency {code:?}: not a code the core knows"));
            Vec::new()
        }
        None => Vec::new(),
    };

    let mut amounts = Vec::new();
    if let Some(amount) = out
        .amount
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty())
    {
        let written = numbers_written(text);
        let three_decimal = currencies
            .iter()
            .any(|c| THREE_DECIMAL.contains(&c.as_str()));
        let value = match read_number(&amount) {
            None => Err("not a number"),
            Some(Reading::DotThree) => Err(
                "fifteen hundred in some places and one and a half in others; the number does not say which",
            ),
            Some(Reading::CommaThree(_)) if three_decimal => {
                Err("ambiguous in a currency with three decimal places")
            }
            Some(Reading::CommaThree(v) | Reading::Value(v)) => Ok(v),
        };
        match value {
            Ok(v) if written.contains(&v) => amounts.push(v),
            Ok(_) => dropped.push(format!(
                "amount {amount:?}: not a number the message contains"
            )),
            Err(why) => dropped.push(format!("amount {amount:?}: {why}")),
        }
    }

    // A reference can only narrow what is paid: a payment that names an
    // invoice must name one of these. Grounded like a name, all the same,
    // because a reference the user never wrote would hold the one they did.
    let mut references = Vec::new();
    for reference in out.references {
        let reference = reference.trim().to_owned();
        if reference.is_empty() || references.contains(&reference) {
            continue;
        }
        if text.contains(reference.as_str()) && !Redacted::looks_like_placeholder(&reference) {
            references.push(reference);
        } else {
            dropped.push(format!(
                "reference {reference:?}: not written in the message"
            ));
        }
    }

    let mut destinations = Vec::new();
    for value in out.destinations {
        let value = value.trim();
        match message.original(value) {
            Some(original) if !original.contains('@') => destinations.push(original.to_owned()),
            Some(_) => dropped.push(format!("destination {value:?}: an email is not an account")),
            // A literal substring can be a payee name or an ignored account.
            // The redactor already mapped supported accounts to placeholders;
            // only that map can supply a destination, never arbitrary text.
            None => dropped.push(format!(
                "destination {value:?}: not a known destination placeholder"
            )),
        }
    }

    // Nothing is asked for without somebody to pay: a name, or an account
    // the user asks to pay to. "Send 50 USDC to 0x864c..." names nobody and
    // is a request; an amount on its own is a question, a budget or a
    // quotation.
    if pay.is_empty() && destinations.is_empty() {
        for amount in amounts.drain(..) {
            dropped.push(format!("amount {amount:?}: nobody was asked to be paid"));
        }
    }

    Grounded {
        fields: IntentFields {
            pay,
            refused,
            amounts,
            currencies,
            destinations,
            references,
            cancels_previous: out.cancels_previous,
            reader: None,
        },
        dropped,
    }
}

/// The original text behind a placeholder, or the value itself.
fn restore(message: &Redacted, value: &str) -> String {
    message.original(value).unwrap_or(value).trim().to_owned()
}

/// Whether refusing `refused` covers `name`: the same name, or one inside
/// the other as whole words. The same rule the core applies across turns.
fn covers(refused: &str, name: &str) -> bool {
    let r = format!(" {} ", spelling_key(refused));
    let n = format!(" {} ", spelling_key(name));
    !r.trim().is_empty() && (r == n || r.contains(&n) || n.contains(&r))
}

/// How a written number reads.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Reading {
    /// One value.
    Value(String),
    /// "4,800": four thousand eight hundred in most of the world, and 4.8
    /// in a currency with three decimal places. Carries the thousands.
    CommaThree(String),
    /// "1.500": fifteen hundred where the point groups thousands, one and a
    /// half where it is the decimal point. Nothing in the number says which.
    DotThree,
}

/// Read a number with the conventions people write money in: "480",
/// "480,00", "1.500,00", "1,250.00", "1'500", "1,50,000" and Arabic-Indic
/// digits.
fn read_number(written: &str) -> Option<Reading> {
    let digits: String = ascii_digits(written)
        .chars()
        .filter(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '\''))
        .collect();
    let digits = digits.trim_matches(|c: char| !c.is_ascii_digit());
    if digits.is_empty() {
        return None;
    }
    let groups = |s: &str, sep: char, size: usize| {
        let mut parts = s.split(sep);
        let head = parts.next().unwrap_or("");
        !head.is_empty()
            && head.len() <= size
            && parts.all(|p| p.len() == size && p.bytes().all(|b| b.is_ascii_digit()))
    };
    let plain = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let value = |int: &str, frac: &str| {
        let text = if frac.is_empty() {
            int.to_owned()
        } else {
            format!("{int}.{frac}")
        };
        normalize_number(&text)
    };
    // One separator and exactly three digits after it, and nothing else.
    for sep in [',', '.'] {
        if let Some((int, frac)) = digits.split_once(sep) {
            if !int.is_empty() && plain(int) && int.len() <= 3 && frac.len() == 3 && plain(frac) {
                return Some(if sep == ',' {
                    Reading::CommaThree(value(&format!("{int}{frac}"), "")?)
                } else {
                    Reading::DotThree
                });
            }
        }
    }
    let (int, frac) = if let Some((int, frac)) = digits.rsplit_once(',') {
        // Comma decimal: "480,00", "1.500,00", "1'500,50".
        if frac.len() <= 2 && plain(frac) {
            (int.replace(['.', '\''], ""), frac.to_owned())
        } else {
            (String::new(), String::new())
        }
    } else {
        (String::new(), String::new())
    };
    if !int.is_empty() && plain(&int) {
        return value(&int, &frac).map(Reading::Value);
    }
    // Point decimal, with comma, apostrophe or Indian grouping.
    let (int, frac) = match digits.rsplit_once('.') {
        Some((int, frac)) if plain(frac) && !int.contains('.') => (int, frac),
        Some(_) => {
            // "1.500" or "1.500.000": dots as thousands.
            return groups(digits, '.', 3)
                .then(|| value(&digits.replace('.', ""), ""))
                .flatten()
                .map(Reading::Value);
        }
        None => (digits, ""),
    };
    let int_ok = plain(int) || groups(int, ',', 3) || groups(int, '\'', 3) || indian(int);
    if !int_ok {
        return None;
    }
    value(&int.replace([',', '\''], ""), frac).map(Reading::Value)
}

/// "1,50,000": the last group of three, the rest in twos.
fn indian(int: &str) -> bool {
    let parts: Vec<&str> = int.split(',').collect();
    parts.len() >= 3
        && parts.last().is_some_and(|p| p.len() == 3)
        && parts[1..parts.len() - 1].iter().all(|p| p.len() == 2)
        && (1..=2).contains(&parts[0].len())
        && parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
}

/// Every value a written number could be.
fn values_of(written: &str) -> Vec<String> {
    match read_number(written) {
        Some(Reading::Value(v) | Reading::CommaThree(v)) => vec![v],
        Some(Reading::DotThree) => {
            let digits: String = ascii_digits(written)
                .chars()
                .filter(char::is_ascii_digit)
                .collect();
            [
                normalize_number(&digits),
                normalize_number(&ascii_digits(written)),
            ]
            .into_iter()
            .flatten()
            .collect()
        }
        None => Vec::new(),
    }
}

/// Every value any number written in the message could be.
fn numbers_written(text: &str) -> Vec<String> {
    let text = ascii_digits(text);
    let mut out = Vec::new();
    let mut token = String::new();
    let flush = |token: &mut String, out: &mut Vec<String>| {
        let t = token.trim_end_matches(['.', ',', '\'']).to_owned();
        if t.chars().any(|c| c.is_ascii_digit()) {
            out.extend(values_of(&t));
        }
        token.clear();
    };
    let chars: Vec<char> = text.chars().collect();
    for (k, &c) in chars.iter().enumerate() {
        let joins = matches!(c, '.' | ',' | '\'')
            && !token.is_empty()
            && chars.get(k + 1).is_some_and(char::is_ascii_digit);
        if c.is_ascii_digit() || joins {
            token.push(c);
        } else {
            flush(&mut token, &mut out);
        }
    }
    flush(&mut token, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::redact;
    use moat_core::normalize::normalize_text;

    fn out(
        pay: &[&str],
        refused: &[&str],
        amount: Option<&str>,
        currency: Option<&str>,
    ) -> ModelOutput {
        ModelOutput {
            pay: pay.iter().map(|s| (*s).to_owned()).collect(),
            refused: refused.iter().map(|s| (*s).to_owned()).collect(),
            amount: amount.map(str::to_owned),
            currency: currency.map(str::to_owned),
            ..Default::default()
        }
    }

    #[test]
    fn numbers_read_the_way_they_are_written() {
        for (written, value) in [
            ("480", "480"),
            ("480,00", "480"),
            ("4,80", "4.8"),
            ("1.500,00", "1500"),
            ("1,250.00", "1250"),
            ("1'500", "1500"),
            ("1,50,000", "150000"),
            ("٤٨٠", "480"),
            ("٢٥٠٠", "2500"),
            ("1.500.000", "1500000"),
            ("12.5", "12.5"),
        ] {
            assert_eq!(values_of(written), vec![value], "{written}");
        }
        assert_eq!(
            read_number("4,800"),
            Some(Reading::CommaThree("4800".into()))
        );
        assert_eq!(read_number("1.500"), Some(Reading::DotThree));
        assert_eq!(read_number("abc"), None);
    }

    #[test]
    fn a_payee_must_be_written_in_the_message() {
        let m = redact("Pay Orbit Labs Srl 480 USD");
        let g = ground(
            out(
                &["Orbit Labs Srl", "Orbit Labs Inc"],
                &[],
                Some("480"),
                Some("USD"),
            ),
            &m,
        );
        assert_eq!(g.fields.pay, vec!["Orbit Labs Srl"]);
        assert_eq!(g.dropped.len(), 1);
        assert_eq!(g.fields.amounts, vec!["480"]);
        assert_eq!(g.fields.currencies, vec!["USD"]);
    }

    #[test]
    fn a_payee_the_user_also_refused_is_not_paid() {
        let m = redact("No pagues a Orbit Labs SL, paga 480 USD a Vega Cloud SL");
        // The mistake Qwen3.5 2B made: both companies under "pay".
        let g = ground(
            out(
                &["Orbit Labs SL", "Vega Cloud SL"],
                &["Orbit Labs SL"],
                Some("480"),
                Some("USD"),
            ),
            &m,
        );
        assert_eq!(g.fields.pay, vec!["Vega Cloud SL"]);
        assert_eq!(g.fields.refused, vec!["Orbit Labs SL"]);
    }

    #[test]
    fn an_amount_must_be_a_number_the_message_contains() {
        let m = redact("Paga 1.500,00 euro a Marco Rossi");
        let g = ground(out(&["Marco Rossi"], &[], Some("1500"), Some("EUR")), &m);
        assert_eq!(g.fields.amounts, vec!["1500"], "{:?}", g.dropped);
        let g = ground(out(&["Marco Rossi"], &[], Some("15000"), Some("EUR")), &m);
        assert!(g.fields.amounts.is_empty());
        // A reference number is in the message but is not what the model
        // said; the model said 900, which is not there at all.
        let m = redact("Pay Orbit Labs Srl for order 480");
        let g = ground(out(&["Orbit Labs Srl"], &[], Some("900"), None), &m);
        assert!(g.fields.amounts.is_empty());
    }

    #[test]
    fn a_three_decimal_amount_that_could_mean_two_things_is_dropped() {
        let m = redact("Pay Gulf Supplies 4,800 KWD");
        let g = ground(out(&["Gulf Supplies"], &[], Some("4,800"), Some("KWD")), &m);
        assert!(g.fields.amounts.is_empty(), "{:?}", g.fields);
        let m = redact("Pay Northwind 4,800 USD");
        let g = ground(out(&["Northwind"], &[], Some("4,800"), Some("USD")), &m);
        assert_eq!(g.fields.amounts, vec!["4800"]);
        // "1.500" could be 1500 or 1.5 whatever the currency.
        let m = redact("Paga 1.500 euro a Marco Rossi");
        let g = ground(out(&["Marco Rossi"], &[], Some("1.500"), Some("EUR")), &m);
        assert!(g.fields.amounts.is_empty(), "{:?}", g.fields);
    }

    #[test]
    fn nothing_is_asked_for_without_a_payee() {
        let m = redact("Did we already pay Orbit Labs Srl the 480 USD last week?");
        let g = ground(out(&[], &[], Some("480"), Some("USD")), &m);
        assert!(g.fields.pay.is_empty() && g.fields.amounts.is_empty());
    }

    /// On a chain nobody names the payee; the address is the payee.
    #[test]
    fn an_address_without_a_name_is_still_a_request() {
        let m = redact("Send 50 USDC to 0x864cc95dcD3a5d88401CB951b670874a17092302 on Base");
        let mut o = out(&[], &[], Some("50"), Some("USDC"));
        o.destinations = vec!["DEST_1".into()];
        let g = ground(o, &m);
        assert!(g.fields.pay.is_empty());
        assert_eq!(g.fields.amounts, vec!["50"]);
        assert_eq!(
            g.fields.destinations,
            vec!["0x864cc95dcD3a5d88401CB951b670874a17092302"]
        );
    }

    #[test]
    fn a_reference_must_be_written_in_the_message() {
        let m = redact("Pay Orbit Labs Srl 480 USD for invoice INV-100");
        let mut o = out(&["Orbit Labs Srl"], &[], Some("480"), Some("USD"));
        o.references = vec!["INV-100".into(), "INV-999".into()];
        let g = ground(o, &m);
        assert_eq!(g.fields.references, vec!["INV-100"]);
        assert_eq!(g.dropped.len(), 1);
        assert!(g.fields.validate().is_ok());
    }

    #[test]
    fn a_name_cannot_supply_an_account_or_keep_an_unasked_amount() {
        let message = redact("Do not pay Cedar Studio 72 USD");
        let out = ModelOutput {
            amount: Some("72".into()),
            currency: Some("USD".into()),
            destinations: vec!["Cedar Studio".into()],
            ..Default::default()
        };
        let grounded = ground(out, &message);
        assert!(grounded.fields.destinations.is_empty());
        assert!(grounded.fields.amounts.is_empty());
        assert_eq!(grounded.dropped.len(), 2);
    }

    #[test]
    fn a_destination_comes_back_from_its_placeholder() {
        let m = redact("Pay Monitoring Pro Inc 100 EUR to DE89 3704 0044 0532 0130 00");
        let mut o = out(&["Monitoring Pro Inc"], &[], Some("100"), Some("EUR"));
        o.destinations = vec!["DEST_1".into(), "DEST_9".into()];
        let g = ground(o, &m);
        assert_eq!(g.fields.destinations, vec!["DE89 3704 0044 0532 0130 00"]);
        assert_eq!(g.dropped.len(), 1);
    }

    #[test]
    fn a_currency_must_be_a_code() {
        let m = redact("Paga 480 euro a Orbit Labs Srl");
        let g = ground(out(&["Orbit Labs Srl"], &[], Some("480"), Some("euro")), &m);
        assert!(g.fields.currencies.is_empty());
        let g = ground(out(&["Orbit Labs Srl"], &[], Some("480"), Some("eur")), &m);
        assert_eq!(g.fields.currencies, vec!["EUR"]);
    }

    #[test]
    fn the_fields_that_survive_are_ones_the_core_accepts() {
        let m = redact("ادفع لمؤسسة عسير للحلول السحابية ٤٨٠ ريال");
        let g = ground(
            out(
                &["مؤسسة عسير للحلول السحابية"],
                &["شركة الأفق الرقمي"],
                Some("٤٨٠"),
                Some("SAR"),
            ),
            &m,
        );
        assert_eq!(g.fields.amounts, vec!["480"]);
        assert!(g.fields.validate().is_ok());
        assert_eq!(
            normalize_text(&g.fields.pay[0]),
            "مؤسسة عسير للحلول السحابية"
        );
    }
}
