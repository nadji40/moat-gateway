//! Canonical forms for matching.
//!
//! Provenance is resolved by comparing normalized forms (ADR 0001), so this
//! module is part of the security boundary: the same functions run on the
//! ingest path (tool results, intents) and the resolution path (payment
//! arguments). Keep them boring.

/// A value in both its original and canonical forms.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Normalized {
    /// Exactly what was seen.
    pub original: String,
    /// Trimmed, case-folded, whitespace-collapsed.
    pub text: String,
    /// Canonical numeric form, if the value reads as a number.
    pub number: Option<String>,
}

impl Normalized {
    /// Normalize a string value.
    pub fn from_text(original: &str) -> Normalized {
        Normalized {
            original: original.to_owned(),
            text: normalize_text(original),
            number: normalize_number(original),
        }
    }

    /// Normalize a JSON number, which is already canonical apart from its
    /// representation.
    pub fn from_number(n: &serde_json::Number) -> Normalized {
        let original = n.to_string();
        Normalized {
            text: original.clone(),
            number: normalize_number(&original),
            original,
        }
    }
}

/// Trim, case-fold, collapse runs of whitespace to one space.
pub fn normalize_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            pending_space = true;
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        for lower in ch.to_lowercase() {
            out.push(lower);
        }
    }
    out
}

/// Currency markers stripped before numeric parsing.
const CURRENCY_CHARS: &[char] = &['$', '€', '£', '¥', '₹', '₩', '₽'];

/// Parse a money-like string into a canonical numeric string, or `None`.
///
/// Accepts an optional leading sign, currency symbols anywhere, thousands
/// separators (`,`), a decimal point, and surrounding whitespace. Rejects
/// anything with other characters: this is a number parser, not a search.
/// The canonical form has no thousands separators, no trailing zeros and no
/// exponent for the magnitudes money uses.
pub fn normalize_number(s: &str) -> Option<String> {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && !CURRENCY_CHARS.contains(c) && *c != ',')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let (neg, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, cleaned.strip_prefix('+').unwrap_or(&cleaned)),
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    if digits.matches('.').count() > 1 || !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (int_part, frac_part) = match digits.split_once('.') {
        Some((i, f)) => (i, f.trim_end_matches('0')),
        None => (digits, ""),
    };
    let int_part = int_part.trim_start_matches('0');
    let int_part = if int_part.is_empty() { "0" } else { int_part };
    let mut out = String::new();
    if neg && !(int_part == "0" && frac_part.is_empty()) {
        out.push('-');
    }
    out.push_str(int_part);
    if !frac_part.is_empty() {
        out.push('.');
        out.push_str(frac_part);
    }
    Some(out)
}

/// Pull every number-looking token out of free text, canonicalized.
///
/// This is what lets an amount that appeared inside a sentence in a tool
/// result ("Pay ProMon Billing Ltd $480 today") be attributed to that result.
pub fn numbers_in_text(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit() || chars[i] == ',' || chars[i] == '.')
            {
                i += 1;
            }
            let token: String = chars[start..i].iter().collect();
            let token = token.trim_end_matches(['.', ',']);
            if let Some(n) = normalize_number(token) {
                out.push(n);
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Minimum length, in characters, of a normalized string before substring
/// matching is attempted. Shorter strings match too easily to mean anything.
pub const MIN_SUBSTRING_LEN: usize = 4;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_cases() {
        let cases = [
            ("ProMon Billing Ltd", "promon billing ltd"),
            ("  ProMon   Billing\tLtd \n", "promon billing ltd"),
            ("ACME", "acme"),
            ("", ""),
            ("   ", ""),
            ("Straße", "straße"),
            ("İstanbul", "i̇stanbul"),
            ("a\u{00A0}b", "a b"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_text(input), want, "input {input:?}");
        }
    }

    #[test]
    fn number_cases() {
        let cases = [
            ("480", Some("480")),
            ("480.00", Some("480")),
            ("$480", Some("480")),
            ("$ 480.50", Some("480.5")),
            ("1,250.00", Some("1250")),
            ("€1.234", Some("1.234")),
            ("-12", Some("-12")),
            ("+12", Some("12")),
            ("0.5", Some("0.5")),
            (".5", Some("0.5")),
            ("007", Some("7")),
            ("0", Some("0")),
            ("-0", Some("0")),
            ("£", None),
            ("", None),
            ("abc", None),
            ("480 USD", None),
            ("1.2.3", None),
            ("1e3", None),
            ("ProMon Billing Ltd", None),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_number(input).as_deref(), want, "input {input:?}");
        }
    }

    #[test]
    fn numbers_in_text_cases() {
        let cases: Vec<(&str, Vec<&str>)> = vec![
            ("Pay ProMon Billing Ltd $480 today", vec!["480"]),
            ("Total: 1,250.00 (was 1,300)", vec!["1250", "1300"]),
            ("no numbers here", vec![]),
            ("v2 costs 19.99.", vec!["2", "19.99"]),
            ("ids 007 and 42", vec!["7", "42"]),
        ];
        for (input, want) in cases {
            assert_eq!(numbers_in_text(input), want, "input {input:?}");
        }
    }

    #[test]
    fn normalized_from_number_keeps_canonical_form() {
        let n = Normalized::from_number(&serde_json::Number::from(480));
        assert_eq!(n.number.as_deref(), Some("480"));
        let f: serde_json::Number = serde_json::from_str("480.50").unwrap();
        let n = Normalized::from_number(&f);
        assert_eq!(n.number.as_deref(), Some("480.5"));
    }
}
