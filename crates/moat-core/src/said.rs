//! Reading what the user typed: which names and amounts it actually asks for.
//!
//! Provenance traces a payment's values back to the user's words (ADR 0001).
//! Matching those words as one long string over-reads them: any four
//! characters of a name, a payee the user said not to pay, or an invoice
//! number all counted as the user asking. This module reads a sentence well
//! enough to refuse those, and no further. A value it declines resolves to
//! another source or to `Unknown`, which costs a step-up, never a payment.

use crate::money::is_currency_code;
use crate::normalize::{ascii_digits, normalize_number, normalize_text};

/// Characters that wrap a word without being part of it.
const WRAPPING: &[char] = &[
    '.', ',', ';', ':', '!', '?', '"', '\'', '(', ')', '[', ']', '«', '»', '“', '”', '‘', '’', '،',
    '؛', '؟',
];

/// Characters that end a clause when a word ends with them.
const CLAUSE_END: &[char] = &['.', ',', ';', ':', '!', '?', '،', '؛', '؟'];

/// Characters that end a sentence when a word ends with them.
const SENTENCE_END: &[char] = &['.', '!', '?', '؟'];

/// Symbols that make a number an amount of money.
const CURRENCY_SYMBOLS: &[char] = &['$', '€', '£', '¥', '₹', '₩', '₽'];

/// Words that name a currency without being its code.
const CURRENCY_WORDS: &[&str] = &[
    "dollar",
    "dollars",
    "euro",
    "euros",
    "pound",
    "pounds",
    "riyal",
    "riyals",
    "rial",
    "rials",
    "dirham",
    "dirhams",
    "dinar",
    "dinars",
    "ريال",
    "ريالا",
    "ريالات",
    "درهم",
    "دراهم",
    "دينار",
    "دنانير",
    "ر.س",
    "د.إ",
    "د.ك",
    "د.ب",
    "ر.ع",
    "ر.ق",
];

/// Words that turn what follows into something the user does not want paid.
const NEGATIONS: &[&str] = &[
    "not",
    "no",
    "never",
    "instead",
    "rather",
    "except",
    "without",
    "stop",
    "cancel",
    "avoid",
    "refuse",
    "refused",
    "reject",
    "decline",
    "block",
    "forbid",
    "لا",
    "لن",
    "لم",
    "ليس",
    "بدل",
    "بدلا",
    "بدلاً",
    "عدا",
    "باستثناء",
    "غير",
    "ماعدا",
];

/// Words that make the number after them a reference, not a price: "order
/// 450", "ticket 88", "my user ID is 42", "room 101".
const REFERENCES: &[&str] = &[
    "order",
    "ticket",
    "id",
    "room",
    "invoice",
    "inv",
    "ref",
    "reference",
    "account",
    "acct",
    "extension",
    "ext",
    "number",
    "no",
    "po",
    "case",
    "unit",
    "flat",
    "apartment",
    "building",
    "floor",
    "version",
    "year",
    "phone",
    "tel",
    "code",
    "pin",
    "رقم",
    "فاتورة",
    "طلب",
    "غرفة",
    "حساب",
];

/// One-letter Arabic prefixes written joined to the next word: "لمؤسسة" is
/// "to" plus "مؤسسة".
const PROCLITICS: &[char] = &['و', 'ف', 'ب', 'ل', 'ك'];

/// How many words back a negation can reach within its clause.
const NEGATION_REACH: usize = 6;

struct Token {
    /// Case-folded, as a payment argument is normalized.
    lower: String,
    /// `lower` without wrapping punctuation or a possessive `'s`.
    bare: String,
    /// The first letter is a capital.
    capital: bool,
    /// Contains a digit, so it is an identifier or an amount, not a name.
    digit: bool,
    /// First word of a sentence, capitalized for that reason alone.
    sentence_start: bool,
    /// Ends with punctuation that closes a clause.
    ends_clause: bool,
}

impl Token {
    /// A capitalized word that is capitalized because it is part of a name.
    fn name_word(&self) -> bool {
        self.capital
            && !self.digit
            && !self.sentence_start
            && self.bare != "i"
            && !is_currency_code(&self.bare)
    }

    fn negation(&self) -> bool {
        NEGATIONS.contains(&self.bare.as_str())
            || self.bare.ends_with("n't")
            || self.bare.ends_with("n’t")
    }

    /// Whether this word is the argument's word `word`, allowing an Arabic
    /// prefix on the first word of a name.
    fn is(&self, word: &str, first: bool) -> bool {
        if self.lower == word || self.bare == word {
            return true;
        }
        // "Co.," is the word "Co." and a comma: the full stop belongs to an
        // abbreviation the user wrote, so a payee ending "Co." still matches.
        let abbreviated = self
            .lower
            .trim_start_matches(WRAPPING)
            .trim_end_matches(|c: char| c != '.' && WRAPPING.contains(&c));
        if abbreviated == word {
            return true;
        }
        first
            && self
                .bare
                .strip_prefix(PROCLITICS)
                .is_some_and(|rest| rest == word)
    }
}

fn tokens(text: &str) -> Vec<Token> {
    let mut out: Vec<Token> = Vec::new();
    for raw in text.split_whitespace() {
        let lower = normalize_text(raw);
        let trimmed = lower.trim_matches(WRAPPING);
        let bare = trimmed
            .strip_suffix("'s")
            .or_else(|| trimmed.strip_suffix("’s"))
            .unwrap_or(trimmed)
            .to_owned();
        let sentence_start = out
            .last()
            .is_none_or(|previous| previous.lower.ends_with(SENTENCE_END));
        out.push(Token {
            capital: raw
                .trim_start_matches(WRAPPING)
                .chars()
                .find(|c| c.is_alphabetic())
                .is_some_and(char::is_uppercase),
            digit: ascii_digits(raw).chars().any(|c| c.is_ascii_digit()),
            ends_clause: raw.ends_with(CLAUSE_END),
            sentence_start,
            lower,
            bare,
        });
    }
    out
}

/// Whether a negation earlier in the same clause governs the word at `at`.
fn negated(tokens: &[Token], at: usize) -> bool {
    for token in tokens[..at].iter().rev().take(NEGATION_REACH) {
        if token.ends_clause {
            return false;
        }
        if token.negation() {
            return true;
        }
    }
    false
}

/// Whether `text` asks for a payee whose normalized name is `name`.
///
/// The name must be whole words of the sentence, not negated in its clause,
/// and, when the writer capitalizes names at all, a whole capitalized name:
/// "Pro Inc" is not the user naming anyone when they wrote "Monitoring Pro
/// Inc", and neither is "cloud hosting".
pub fn names(text: &str, name: &str) -> bool {
    let words: Vec<&str> = name.split(' ').filter(|w| !w.is_empty()).collect();
    if words.is_empty() {
        return false;
    }
    let tokens = tokens(text);
    let cased = tokens.iter().any(Token::name_word);
    let last = tokens.len();
    (0..last)
        .filter(|&start| start + words.len() <= last)
        .any(|start| {
            let end = start + words.len();
            let span = &tokens[start..end];
            if !span
                .iter()
                .zip(&words)
                .enumerate()
                .all(|(k, (t, w))| t.is(w, k == 0))
            {
                return false;
            }
            if cased {
                if !span.iter().any(|t| t.capital && !t.digit) {
                    return false;
                }
                let joined_left =
                    start > 0 && tokens[start - 1].name_word() && !tokens[start - 1].ends_clause;
                let joined_right =
                    end < last && tokens[end].name_word() && !tokens[end - 1].ends_clause;
                if joined_left || joined_right {
                    return false;
                }
            }
            !negated(&tokens, start)
        })
}

/// The amounts `text` asks for, canonicalized.
///
/// A number glued to letters or symbols is an identifier ("INV-120", "15th",
/// "#3") and never an amount. A number beside a currency, or written with a
/// decimal point, is an amount; when the sentence has any of those, a bare
/// number elsewhere in it is a quantity, a day or a reference, not the price.
/// A number the user said not to pay is not asked for.
pub fn amounts(text: &str) -> Vec<String> {
    let tokens = tokens(&ascii_digits(text));
    let currency_word =
        |t: &Token| is_currency_code(&t.bare) || CURRENCY_WORDS.contains(&t.bare.as_str());
    let mut strong = Vec::new();
    let mut bare = Vec::new();
    for (at, token) in tokens.iter().enumerate() {
        let core = token.lower.trim_matches(WRAPPING);
        let symbol = core.starts_with(CURRENCY_SYMBOLS) || core.ends_with(CURRENCY_SYMBOLS);
        let core = core.trim_matches(CURRENCY_SYMBOLS);
        if core.is_empty()
            || !core
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
        {
            continue;
        }
        let Some(number) = normalize_number(core) else {
            continue;
        };
        if negated(&tokens, at) {
            continue;
        }
        let beside_currency = (at > 0 && currency_word(&tokens[at - 1]))
            || tokens.get(at + 1).is_some_and(currency_word);
        // "order 450", "my user ID is 42": a reference within two words back.
        let reference = tokens[at.saturating_sub(2)..at]
            .iter()
            .any(|t| REFERENCES.contains(&t.bare.as_str()));
        // "3 licences", "15 days": a count of something that is not money.
        let counted = tokens.get(at + 1).is_some_and(|next| {
            next.bare.chars().count() > 2
                && next.bare.chars().all(char::is_alphabetic)
                && next.bare.ends_with('s')
                && !currency_word(next)
        });
        if !symbol && !beside_currency && (reference || counted) {
            continue;
        }
        if symbol || beside_currency || core.contains('.') {
            strong.push(number);
        } else {
            bare.push(number);
        }
    }
    if strong.is_empty() {
        bare
    } else {
        strong
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_whole_words_of_a_whole_name() {
        let said = "Pay the Monitoring Pro Inc invoice INV-4471 for 4.80 USD.";
        assert!(names(said, "monitoring pro inc"));
        for fragment in ["pro inc", "monitoring", "monitoring pro", "invoice", "onit"] {
            assert!(!names(said, fragment), "{fragment}");
        }
        assert!(!names(
            "Pay the cloud hosting invoice from Monitoring Pro Inc",
            "cloud hosting"
        ));
        assert!(names(
            "Renew our monitoring tools with Monitoring Pro Inc, keep it under $500",
            "monitoring pro inc"
        ));
        assert!(names(
            "Pay Monitoring Pro Inc 4.80 USD",
            "monitoring pro inc"
        ));
        assert!(names("Pay Acme Cloud Ltd's invoice", "acme cloud ltd"));
    }

    /// Dhoha's L-011: the user wrote "Oman Freight Co., OF-884" and the agent
    /// paid "Oman Freight Co.", which was held because the comma took the
    /// full stop with it. Both spellings the user's words support now match;
    /// one the words do not support still does not.
    #[test]
    fn an_abbreviation_keeps_its_full_stop_before_a_comma() {
        let said = "Pay the logistics invoice from Oman Freight Co., OF-884, 75.750 OMR.";
        assert!(names(said, "oman freight co."));
        assert!(names(said, "oman freight co"));
        assert!(names("Pay Oman Freight Co. 75.750 OMR", "oman freight co."));
        assert!(!names(said, "freight co."));
        assert!(!names(said, "oman freight co.."));
    }

    #[test]
    fn a_name_the_user_said_not_to_pay_is_not_asked_for() {
        let said = "Don't pay ProMon Billing Ltd, that is a scam. Pay Monitoring Pro Inc 4.80 USD.";
        assert!(!names(said, "promon billing ltd"));
        assert!(names(said, "monitoring pro inc"));
        assert!(!names(
            "Pay Monitoring Pro Inc instead of ProMon Billing Ltd",
            "promon billing ltd"
        ));
        assert!(!names("لا تدفع لشركة بروبيل", "شركة بروبيل"));
        assert!(!names(
            "I refuse to pay Scammy Ltd, please pay Monitoring Pro Inc 4.80 USD.",
            "scammy ltd"
        ));
    }

    #[test]
    fn arabic_names_with_a_joined_prefix() {
        let said = "ادفع لمؤسسة عسير للحلول السحابية ٤٫٨٠ ريال";
        assert!(names(said, "مؤسسة عسير للحلول السحابية"));
        assert!(!names("لا تدفع لمؤسسة عسير", "مؤسسة عسير"));
    }

    #[test]
    fn writers_who_do_not_capitalize_are_read_by_words_only() {
        let said = "pay monitoring pro inc 4.80 usd";
        assert!(names(said, "monitoring pro inc"));
        assert!(!names(said, "onitoring pro"));
    }

    #[test]
    fn amounts_are_prices_not_references() {
        let cases: Vec<(&str, Vec<&str>)> = vec![
            (
                "Pay invoice INV-120 for Monitoring Pro Inc, 4.80 USD",
                vec!["4.8"],
            ),
            ("Pay Monitoring Pro Inc 480", vec!["480"]),
            ("Pay the 3 licences for 4.80 USD on the 15th", vec!["4.8"]),
            ("Don't pay 480, pay 4.80 USD", vec!["4.8"]),
            (
                "Renew our monitoring tools, keep it under $500",
                vec!["500"],
            ),
            ("Pay 480 SAR", vec!["480"]),
            ("ادفع ٤٫٨٠ ريال", vec!["4.8"]),
            ("Pay room 12 for 45 USD", vec!["45"]),
            // Redwan's stray numbers, from sentences with no price at all.
            ("Pay Monitoring Pro Inc for order 450", vec![]),
            ("Buy 3 licences from Monitoring Pro Inc", vec![]),
            ("Pay Monitoring Pro Inc, my user ID is 42", vec![]),
            ("Pay Monitoring Pro Inc, room 101", vec![]),
            ("Monitoring Pro Inc, reference ticket 88", vec![]),
            ("Pay Monitoring Pro Inc 480 today", vec!["480"]),
        ];
        for (said, want) in cases {
            assert_eq!(amounts(said), want, "{said}");
        }
    }
}
