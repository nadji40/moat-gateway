//! What the model is not shown, and what is not kept.
//!
//! Account numbers, chain addresses and email addresses are replaced by
//! placeholders before the model reads the message. The model only has to
//! say which of them the user is paying, and a placeholder says that as well
//! as the number would. The originals come back afterwards from the map.
//!
//! Card numbers are removed outright, from the model's copy and from the copy
//! the gateway keeps. Nothing about paying anybody needs a card number in a
//! chat message, and one that is kept is one that has to be protected.

use moat_core::destination::destinations_in_text;

/// A message prepared for the model and for the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    /// What the model reads: placeholders in place of accounts, addresses
    /// and emails, and no card numbers.
    pub for_model: String,
    /// What the gateway keeps: the message as typed, without card numbers.
    pub for_record: String,
    /// Each placeholder and the text it stands for.
    pub placeholders: Vec<(String, String)>,
    /// How many card numbers were removed.
    pub cards_removed: usize,
}

impl Redacted {
    /// The original text behind a placeholder, if `value` is one.
    pub fn original(&self, value: &str) -> Option<&str> {
        let value = value.trim();
        self.placeholders
            .iter()
            .find(|(placeholder, _)| placeholder == value)
            .map(|(_, original)| original.as_str())
    }

    /// Whether `value` is a placeholder of any kind, known or not.
    pub fn looks_like_placeholder(value: &str) -> bool {
        let value = value.trim();
        ["DEST_", "EMAIL_"].iter().any(|prefix| {
            value
                .strip_prefix(prefix)
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
    }
}

/// What replaces a card number.
pub const CARD_REMOVED: &str = "[card number removed]";

/// Prepare `text` for the model and for the record.
pub fn redact(text: &str) -> Redacted {
    let (for_record, cards_removed) = remove_cards(text);
    let mut for_model = for_record.clone();
    let mut placeholders = Vec::new();

    // Numbered in the order they appear, which is how the model will read
    // them; replaced longest first, so one inside a longer one is not split.
    let mut found: Vec<(usize, String)> = destinations_in_text(&for_record)
        .into_iter()
        .filter_map(|d| {
            for_record
                .find(d.display.as_str())
                .map(|at| (at, d.display))
        })
        .collect();
    found.sort();
    found.dedup_by(|a, b| a.1 == b.1);
    let mut numbered: Vec<(String, String)> = found
        .into_iter()
        .enumerate()
        .map(|(k, (_, display))| (format!("DEST_{}", k + 1), display))
        .collect();
    numbered.sort_by_key(|(_, display)| std::cmp::Reverse(display.len()));
    for (placeholder, display) in &numbered {
        for_model = for_model.replace(display.as_str(), placeholder);
    }
    numbered.sort_by_key(|(placeholder, _)| placeholder[5..].parse::<usize>().unwrap_or(0));
    placeholders.extend(numbered);

    let mut emails = 0;
    let words: Vec<String> = for_model.split_whitespace().map(str::to_owned).collect();
    for word in words {
        let email = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '@');
        if is_email(email) && for_model.contains(email) {
            emails += 1;
            let placeholder = format!("EMAIL_{emails}");
            for_model = for_model.replace(email, &placeholder);
            placeholders.push((placeholder, email.to_owned()));
        }
    }

    Redacted {
        for_model,
        for_record,
        placeholders,
        cards_removed,
    }
}

fn is_email(word: &str) -> bool {
    let Some((local, domain)) = word.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains('@')
}

/// Remove every run of 13 to 19 digits, optionally separated by single
/// spaces or hyphens, that passes the Luhn check.
fn remove_cards(text: &str) -> (String, usize) {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut removed = 0;
    let mut i = 0;
    while i < chars.len() {
        let starts_run = chars[i].is_ascii_digit() && (i == 0 || !(chars[i - 1].is_alphanumeric()));
        if starts_run {
            // Extend over digits and single separators between digits.
            let mut j = i;
            let mut digits = String::new();
            let mut end = i;
            while j < chars.len() {
                if chars[j].is_ascii_digit() {
                    digits.push(chars[j]);
                    j += 1;
                    end = j;
                } else if (chars[j] == ' ' || chars[j] == '-')
                    && j + 1 < chars.len()
                    && chars[j + 1].is_ascii_digit()
                {
                    j += 1;
                } else {
                    break;
                }
            }
            let bounded = end >= chars.len() || !chars[end].is_alphanumeric();
            if bounded && (13..=19).contains(&digits.len()) && luhn(&digits) {
                out.push_str(CARD_REMOVED);
                removed += 1;
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, removed)
}

fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (k, b) in digits.bytes().rev().enumerate() {
        let mut d = u32::from(b - b'0');
        if k % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    sum % 10 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_number_is_removed_from_both_copies() {
        let r = redact("Pay Orbit Labs 480 USD with card 4111 1111 1111 1111 please");
        assert_eq!(r.cards_removed, 1);
        assert!(!r.for_record.contains("4111"));
        assert!(!r.for_model.contains("4111"));
        assert!(r.for_record.contains(CARD_REMOVED));
    }

    #[test]
    fn an_amount_or_an_order_number_is_not_a_card() {
        for text in [
            "Pay 1,250.00 USD for order 4471",
            "Pay 1234567890123 USD",
            "Call +39 06 1234 5678",
        ] {
            assert_eq!(redact(text).cards_removed, 0, "{text}");
        }
    }

    #[test]
    fn accounts_and_emails_become_placeholders_the_model_can_name() {
        let text = concat!(
            "Pay Monitoring Pro Inc at DE89 3704 0044 0532 0130 00, not ",
            "0x864cc95dcD3a5d88401CB951b670874a17092302. Receipt to ap@example.com"
        );
        let r = redact(text);
        assert!(!r.for_model.contains("DE89"));
        assert!(!r.for_model.contains("0x864c"));
        assert!(!r.for_model.contains("ap@example.com"));
        assert_eq!(r.original("DEST_1"), Some("DE89 3704 0044 0532 0130 00"));
        assert_eq!(
            r.original("DEST_2"),
            Some("0x864cc95dcD3a5d88401CB951b670874a17092302")
        );
        assert_eq!(r.original("EMAIL_1"), Some("ap@example.com"));
        // The record keeps what the user typed.
        assert_eq!(r.for_record, text);
        assert!(Redacted::looks_like_placeholder("DEST_7"));
        assert!(!Redacted::looks_like_placeholder("DEST_"));
    }
}
