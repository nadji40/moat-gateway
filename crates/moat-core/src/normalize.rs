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
///
/// Nothing else is folded. A provider pays the merchant whose configured
/// name is exactly the one it was given, so "Monitoring Pro Inc." and an
/// Arabic name written with a tatweel can each be a different, look-alike
/// merchant; folding them here would hand the look-alike the real one's
/// provenance. Spelling variation is solved by approving an account, not by
/// matching names more loosely.
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

/// Arabic-Indic and Persian digits as ASCII digits, and the Arabic decimal
/// and thousands marks as `.` and `,`. A digit is a digit in any script;
/// everything else passes through for the caller to judge.
pub fn ascii_digits(s: &str) -> String {
    s.chars()
        .map(|ch| match ch {
            '\u{0660}'..='\u{0669}' => char::from(b'0' + (ch as u32 - 0x0660) as u8),
            '\u{06F0}'..='\u{06F9}' => char::from(b'0' + (ch as u32 - 0x06F0) as u8),
            '\u{066B}' => '.',
            '\u{066C}' => ',',
            other => other,
        })
        .collect()
}

/// An integer part with its thousands separators removed, or `None` when a
/// comma is anything but a separator between groups of three. "4,80" is not
/// 480: read that way, a payment written in a comma-decimal locale would be
/// judged at a hundred times what the provider pays.
fn ungroup(int_part: &str) -> Option<String> {
    if !int_part.contains(',') {
        return Some(int_part.to_owned());
    }
    let mut groups = int_part.split(',');
    let first = groups.next()?;
    if first.is_empty() || first.len() > 3 {
        return None;
    }
    let mut out = first.to_owned();
    for group in groups {
        if group.len() != 3 {
            return None;
        }
        out.push_str(group);
    }
    Some(out)
}

/// A name as a person reads it, for comparing two spellings of one payee.
///
/// Folds what [`normalize_text`] deliberately keeps: punctuation and hyphens,
/// the Arabic tatweel and diacritics, the forms of alef, teh marbuta and heh,
/// alef maksura and yeh, the Persian yeh and keheh a different keyboard types,
/// and the long and short forms of common legal suffixes. Only safe where the
/// money's destination is pinned some other way: the policy uses it for an
/// approved payee only when the approved account also matches, because a
/// look-alike merchant has its own account.
pub fn spelling_key(s: &str) -> String {
    let folded: String = s
        .chars()
        .filter_map(|ch| match ch {
            '.' | '\u{0640}' | '\u{064B}'..='\u{065F}' | '\u{0670}' => None,
            ',' | '\u{060C}' | '-' | '_' => Some(' '),
            '\u{0622}' | '\u{0623}' | '\u{0625}' | '\u{0671}' => Some('\u{0627}'),
            '\u{0629}' => Some('\u{0647}'),
            '\u{0649}' | '\u{06CC}' => Some('\u{064A}'),
            '\u{06A9}' => Some('\u{0643}'),
            other => Some(other),
        })
        .collect();
    normalize_text(&folded)
        .split(' ')
        .map(|word| match word {
            "co" => "company",
            "est" => "establishment",
            "ltd" => "limited",
            "corp" => "corporation",
            "inc" => "incorporated",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Currency markers stripped before numeric parsing.
const CURRENCY_CHARS: &[char] = &['$', '€', '£', '¥', '₹', '₩', '₽'];

/// Parse a money-like string into a canonical numeric string, or `None`.
///
/// Accepts an optional leading sign, currency symbols anywhere, thousands
/// separators (`,` between groups of three), a decimal point, digits in
/// Arabic-Indic script, and surrounding whitespace. Rejects anything with
/// other characters: this is a number parser, not a search. The canonical
/// form has no thousands separators, no trailing zeros and no exponent for
/// the magnitudes money uses.
pub fn normalize_number(s: &str) -> Option<String> {
    let cleaned: String = ascii_digits(s)
        .chars()
        .filter(|c| !c.is_whitespace() && !CURRENCY_CHARS.contains(c))
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let (neg, digits) = match cleaned.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, cleaned.strip_prefix('+').unwrap_or(&cleaned)),
    };
    if digits.is_empty()
        || !digits
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
    {
        return None;
    }
    if digits.matches('.').count() > 1 || !digits.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let (int_part, frac_part) = match digits.split_once('.') {
        Some((i, f)) => (i, f),
        None => (digits, ""),
    };
    if frac_part.contains(',') {
        return None;
    }
    let frac_part = frac_part.trim_end_matches('0');
    let int_part = ungroup(int_part)?;
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
    let chars: Vec<char> = ascii_digits(s).chars().collect();
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
    fn spellings_of_one_name_share_a_key() {
        let same = [
            ("Monitoring Pro Inc.", "Monitoring Pro Inc"),
            (
                "Al Noor General Trading L.L.C.",
                "Al Noor General Trading LLC",
            ),
            ("Al-Noor Trading Co", "Al Noor Trading Company"),
            ("Qassim Trading Est.", "Qassim Trading Establishment"),
            ("مؤسسة عسـير", "مؤسسه عسير"),
            ("أحمد", "احمد"),
            ("علی", "علي"),
        ];
        for (a, b) in same {
            assert_eq!(spelling_key(a), spelling_key(b), "{a} / {b}");
        }
        assert_ne!(
            spelling_key("Al Noor Holding"),
            spelling_key("Al Noor Trading")
        );
        assert_ne!(spelling_key("Qassim"), spelling_key("Qasim"));
    }

    /// A provider pays the exact configured name, so each of these can be a
    /// separately registered look-alike merchant and must stay a different
    /// name. The arena's spoof-lookalike-name attack is the first of them.
    #[test]
    fn look_alike_names_stay_different() {
        let pairs = [
            (
                "Monitoring Pro Inc.",
                "Monitoring Pro Inc",
                "trailing full stop",
            ),
            ("Al Noor L.L.C.", "Al Noor LLC", "dotted legal form"),
            ("عسـير", "عسير", "tatweel"),
            ("أحمد", "احمد", "alef with hamza"),
            ("علی", "علي", "Persian yeh"),
            ("کمال", "كمال", "Persian keheh"),
            (
                "M\u{043E}nitoring Pro Inc",
                "Monitoring Pro Inc",
                "Cyrillic o",
            ),
        ];
        for (a, b, what) in pairs {
            assert_ne!(normalize_text(a), normalize_text(b), "{what}");
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
            ("٤٫٨٠", Some("4.8")),
            ("٤.٨٠", Some("4.8")),
            ("4٫80", Some("4.8")),
            ("۴.۸۰", Some("4.8")),
            ("١٬٢٥٠", Some("1250")),
            ("12,345,678", Some("12345678")),
            ("4,80", None),
            ("4.800,00", None),
            ("1,2,3", None),
            ("12,34,567", None),
            ("1234,567", None),
            (",5", None),
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
            ("المبلغ ٤٫٨٠ ريال", vec!["4.8"]),
            ("items 3,4 and 5", vec!["5"]),
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
