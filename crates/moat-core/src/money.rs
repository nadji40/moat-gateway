//! Assets, and amounts denominated in them.
//!
//! An amount is only meaningful next to the thing it counts. "100" is a
//! hundred dollars, a hundred yen, or a hundred millionths of a USDC,
//! depending on an exponent that lives with the asset and nowhere else. This
//! module is the one place that knows those exponents.
//!
//! Three properties matter, and each of them is a defence:
//!
//! - **Minor units are `u128`.** One ether is 10^18 wei, and `u64` overflows
//!   at about eighteen of them. A cap that silently saturates is not a cap.
//! - **Amounts cross the wire as decimal strings.** JSON numbers are `f64`
//!   here, which stops being exact above 2^53; `serde_json` would render a
//!   large wei value as something that is not the value. Numbers are still
//!   accepted, because the card path has always sent them and they are exact
//!   for the magnitudes it uses.
//! - **Too much precision is an error, never a rounding.** `100.0000001`
//!   USDC has seven decimal places for a six-decimal asset. Rounding it to
//!   `100.000000` would let a caller write an amount that is not the amount
//!   evaluated, which is the "unit confusion" attack. It is refused instead.
//!
//! An unknown three-letter code still means fiat with two decimal places, so
//! a deployment paying in a currency this table has never heard of keeps
//! working exactly as it did. Tokens are different: nothing about `USDC`
//! reveals that it has six decimals, so a token must be known here or
//! declared by the policy before it can be used.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

/// Whether an asset is issued by a state or by a contract on a network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    /// A national currency, identified by its ISO 4217 code.
    Fiat,
    /// A token or native coin on a network.
    Token,
}

/// An asset and, the part that matters, how many decimal places it has.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    /// `USD`, `USDC`, `ETH`. Compared case-insensitively, stored uppercase.
    pub code: String,
    /// Decimal places: 2 for USD, 0 for JPY, 6 for USDC, 18 for ETH.
    pub exponent: u8,
    /// Whether a state or a contract issues it.
    pub kind: AssetKind,
    /// The network a token lives on, when the same code differs between
    /// networks. Absent for fiat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<String>,
}

impl Asset {
    /// A fiat currency with the given number of decimal places.
    pub fn fiat(code: &str, exponent: u8) -> Asset {
        Asset {
            code: code.to_ascii_uppercase(),
            exponent,
            kind: AssetKind::Fiat,
            network: None,
        }
    }
}

/// Fiat currencies whose smallest unit is the currency itself.
const ZERO_DECIMAL: &[&str] = &[
    "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV",
    "XAF", "XOF", "XPF",
];

/// Fiat currencies with three decimal places.
const THREE_DECIMAL: &[&str] = &["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

/// Fiat currencies with four decimal places.
const FOUR_DECIMAL: &[&str] = &["CLF", "UYW"];

/// Tokens and native coins this build knows without being told.
const TOKENS: &[(&str, u8)] = &[
    ("USDC", 6),
    ("USDT", 6),
    ("DAI", 18),
    ("ETH", 18),
    ("WETH", 18),
    ("SOL", 9),
    ("BTC", 8),
];

/// Active ISO 4217 codes. [`AssetRegistry::lookup`] accepts any three
/// letters as a currency so an unlisted one keeps working; reading a currency
/// out of what a user typed cannot, or "LLC" and "INV" would be currencies.
const ISO_4217: &[&str] = &[
    "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT",
    "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD",
    "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD",
    "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ",
    "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD",
    "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
    "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR",
    "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN",
    "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR",
    "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
    "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "UYU", "UZS",
    "VES", "VND", "VUV", "WST", "XAF", "XCD", "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWL",
];

/// The currency and token codes written in capitals in `text`.
///
/// Only capitals count: "pay all invoices" does not name the Albanian lek,
/// while "4.80 SAR" names the riyal.
pub fn currencies_named_in(text: &str) -> std::collections::BTreeSet<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| {
            (3..=5).contains(&word.len()) && word.bytes().all(|b| b.is_ascii_uppercase())
        })
        .filter(|word| ISO_4217.contains(word) || TOKENS.iter().any(|(code, _)| code == word))
        .map(str::to_owned)
        .collect()
}

/// The assets a deployment can name, built in plus whatever its policy adds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AssetRegistry {
    extra: BTreeMap<String, Asset>,
}

fn key(code: &str, network: Option<&str>) -> String {
    match network {
        Some(n) if !n.is_empty() => format!("{}@{}", code.to_ascii_uppercase(), n),
        _ => code.to_ascii_uppercase(),
    }
}

impl AssetRegistry {
    /// A registry holding only the built-in assets.
    pub fn new() -> AssetRegistry {
        AssetRegistry::default()
    }

    /// Add the assets a policy declares. A declared asset shadows a built-in
    /// one with the same key, which is how a deployment corrects an exponent
    /// this build has wrong for its network.
    pub fn with_declared(mut self, assets: &[Asset]) -> AssetRegistry {
        for asset in assets {
            self.extra
                .insert(key(&asset.code, asset.network.as_deref()), asset.clone());
        }
        self
    }

    /// Resolve an asset code, optionally qualified by network.
    ///
    /// Looks for the network-qualified entry, then the bare code, then falls
    /// back to fiat with two decimal places for anything shaped like an
    /// ISO 4217 code. That fallback is what keeps a currency nobody has
    /// enumerated working the way it always has.
    pub fn lookup(&self, code: &str, network: Option<&str>) -> Option<Asset> {
        let code = code.trim();
        if code.is_empty() {
            return None;
        }
        let upper = code.to_ascii_uppercase();
        if let Some(found) = self
            .extra
            .get(&key(&upper, network))
            .or_else(|| self.extra.get(&upper))
        {
            return Some(found.clone());
        }
        if let Some((_, exponent)) = TOKENS.iter().find(|(c, _)| *c == upper) {
            return Some(Asset {
                code: upper,
                exponent: *exponent,
                kind: AssetKind::Token,
                network: network.map(str::to_owned),
            });
        }
        if ZERO_DECIMAL.contains(&upper.as_str()) {
            return Some(Asset::fiat(&upper, 0));
        }
        if THREE_DECIMAL.contains(&upper.as_str()) {
            return Some(Asset::fiat(&upper, 3));
        }
        if FOUR_DECIMAL.contains(&upper.as_str()) {
            return Some(Asset::fiat(&upper, 4));
        }
        // An unenumerated ISO 4217 code is fiat with two decimal places,
        // which is what this code did before assets had exponents.
        if upper.len() == 3 && upper.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Some(Asset::fiat(&upper, 2));
        }
        None
    }
}

/// Why an amount could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AmountError {
    /// Not a number, or written in a form this parser refuses.
    #[error("{0:?} is not a plain decimal amount")]
    Malformed(String),
    /// Negative amounts are never payments.
    #[error("amount must be positive")]
    NotPositive,
    /// More decimal places than the asset has.
    #[error("{value} has {digits} decimal places but {asset} has {exponent}")]
    TooPrecise {
        /// The amount as written.
        value: String,
        /// The asset's code.
        asset: String,
        /// The asset's decimal places.
        exponent: u8,
        /// How many the caller wrote.
        digits: usize,
    },
    /// Larger than the minor-unit type can hold.
    #[error("amount is too large to represent in minor units")]
    Overflow,
}

/// An amount in an asset's smallest indivisible unit.
///
/// Serializes as a decimal string so that a value beyond `f64`'s exact range
/// survives a JSON round trip; deserializes from a string or a number, so
/// state written before amounts were strings still loads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Minor(pub u128);

impl Minor {
    /// Zero.
    pub const ZERO: Minor = Minor(0);

    /// Sum, saturating rather than wrapping.
    pub fn saturating_add(self, other: Minor) -> Minor {
        Minor(self.0.saturating_add(other.0))
    }

    /// Product with a count, saturating rather than wrapping.
    pub fn saturating_mul(self, factor: u128) -> Minor {
        Minor(self.0.saturating_mul(factor))
    }
}

impl fmt::Display for Minor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl Serialize for Minor {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Minor {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Minor, D::Error> {
        struct V;
        impl Visitor<'_> for V {
            type Value = Minor;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("minor units as a decimal string or a non-negative integer")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Minor, E> {
                v.trim()
                    .parse::<u128>()
                    .map(Minor)
                    .map_err(|_| E::custom(format!("{v:?} is not minor units")))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Minor, E> {
                Ok(Minor(u128::from(v)))
            }
            fn visit_u128<E: de::Error>(self, v: u128) -> Result<Minor, E> {
                Ok(Minor(v))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Minor, E> {
                u128::try_from(v)
                    .map(Minor)
                    .map_err(|_| E::custom("minor units cannot be negative"))
            }
        }
        d.deserialize_any(V)
    }
}

/// Read an amount written in major units into the asset's minor units.
///
/// Accepts a JSON string (`"480.50"`) or a JSON number (`480.5`). Refuses a
/// sign, exponent notation, and — deliberately — any amount written with more
/// decimal places than the asset has, because rounding there would evaluate a
/// different amount from the one the caller wrote.
pub fn parse_major(value: &Value, asset: &Asset, allow_zero: bool) -> Result<Minor, AmountError> {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        // `to_string` on a JSON number is exact for integers and gives the
        // shortest representation that round-trips for floats.
        Value::Number(n) => n.to_string(),
        other => return Err(AmountError::Malformed(other.to_string())),
    };
    parse_major_str(&text, asset, allow_zero)
}

/// [`parse_major`] for an amount already in hand as text.
pub fn parse_major_str(text: &str, asset: &Asset, allow_zero: bool) -> Result<Minor, AmountError> {
    let text = crate::normalize::ascii_digits(text);
    let text = text.trim();
    if text.starts_with('-') {
        return Err(AmountError::NotPositive);
    }
    let (whole, fraction) = match text.split_once('.') {
        Some((w, f)) => (w, f),
        None => (text, ""),
    };
    let digits_only = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits_only(whole) || (!fraction.is_empty() && !digits_only(fraction)) {
        return Err(AmountError::Malformed(text.to_owned()));
    }
    if fraction.len() > usize::from(asset.exponent) {
        return Err(AmountError::TooPrecise {
            value: text.to_owned(),
            asset: asset.code.clone(),
            exponent: asset.exponent,
            digits: fraction.len(),
        });
    }
    // Pad the fraction out to the asset's exponent and read the two parts as
    // one integer. No floating point touches the value at any point.
    let mut digits = String::with_capacity(whole.len() + usize::from(asset.exponent));
    digits.push_str(whole);
    digits.push_str(fraction);
    for _ in fraction.len()..usize::from(asset.exponent) {
        digits.push('0');
    }
    let minor: u128 = digits.parse().map_err(|_| AmountError::Overflow)?;
    if minor == 0 && !allow_zero {
        return Err(AmountError::NotPositive);
    }
    Ok(Minor(minor))
}

/// Render minor units back into major units, for prompts and messages.
pub fn format_major(minor: Minor, asset: &Asset) -> String {
    let exponent = usize::from(asset.exponent);
    if exponent == 0 {
        return minor.0.to_string();
    }
    let digits = format!("{:0>width$}", minor.0, width = exponent + 1);
    let split = digits.len() - exponent;
    format!("{}.{}", &digits[..split], &digits[split..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn currencies_are_read_only_from_real_codes_in_capitals() {
        let named = |t: &str| currencies_named_in(t).into_iter().collect::<Vec<_>>();
        assert_eq!(
            named("Pay the Aseer Cloud Co invoice INV-4471 for 4.80 SAR."),
            ["SAR"]
        );
        assert_eq!(
            named("Send 5 USDC, or 4.80 EUR if that fails"),
            ["EUR", "USDC"]
        );
        assert!(named("Pay Al Noor LLC 4.80 via the CEO").is_empty());
        assert!(named("pay all invoices, 4.80 sar").is_empty());
        assert!(named("Pay Monitoring Pro Inc $480").is_empty());
    }

    #[test]
    fn arabic_indic_digits_are_digits() {
        let sar = Asset::fiat("SAR", 2);
        assert_eq!(parse_major_str("٤٫٨٠", &sar, false), Ok(Minor(480)));
        assert_eq!(parse_major_str("٤.٨٠", &sar, false), Ok(Minor(480)));
        assert_eq!(parse_major_str("4٫80", &sar, false), Ok(Minor(480)));
    }

    fn usd() -> Asset {
        AssetRegistry::new().lookup("USD", None).unwrap()
    }
    fn usdc() -> Asset {
        AssetRegistry::new().lookup("USDC", None).unwrap()
    }
    fn eth() -> Asset {
        AssetRegistry::new().lookup("ETH", None).unwrap()
    }

    #[test]
    fn exponents_come_from_the_asset() {
        let r = AssetRegistry::new();
        assert_eq!(r.lookup("USD", None).unwrap().exponent, 2);
        assert_eq!(
            r.lookup("usd", None).unwrap().exponent,
            2,
            "case-insensitive"
        );
        assert_eq!(r.lookup("JPY", None).unwrap().exponent, 0);
        assert_eq!(r.lookup("BHD", None).unwrap().exponent, 3);
        assert_eq!(r.lookup("CLF", None).unwrap().exponent, 4);
        assert_eq!(r.lookup("USDC", None).unwrap().exponent, 6);
        assert_eq!(r.lookup("ETH", None).unwrap().exponent, 18);
        assert_eq!(r.lookup("SOL", None).unwrap().exponent, 9);
    }

    /// The card path has always accepted any three-letter code as two-decimal
    /// fiat. It still does, or a deployment paying in an unenumerated
    /// currency would break on upgrade.
    #[test]
    fn an_unenumerated_three_letter_code_is_still_two_decimal_fiat() {
        let sgd = AssetRegistry::new().lookup("SGD", None).unwrap();
        assert_eq!((sgd.exponent, sgd.kind), (2, AssetKind::Fiat));
    }

    /// A token's exponent cannot be guessed from its name, so an unknown one
    /// is refused rather than assumed.
    #[test]
    fn an_unknown_token_must_be_declared() {
        let r = AssetRegistry::new();
        assert_eq!(r.lookup("WOTSIT", None), None);
        let declared = r.with_declared(&[Asset {
            code: "WOTSIT".into(),
            exponent: 12,
            kind: AssetKind::Token,
            network: None,
        }]);
        assert_eq!(declared.lookup("WOTSIT", None).unwrap().exponent, 12);
    }

    #[test]
    fn a_network_qualified_asset_shadows_the_bare_code() {
        let r = AssetRegistry::new().with_declared(&[Asset {
            code: "USDC".into(),
            exponent: 18,
            kind: AssetKind::Token,
            network: Some("eip155:56".into()),
        }]);
        // The same symbol really does have different exponents per network.
        assert_eq!(r.lookup("USDC", Some("eip155:56")).unwrap().exponent, 18);
        assert_eq!(r.lookup("USDC", Some("eip155:84532")).unwrap().exponent, 6);
        assert_eq!(r.lookup("USDC", None).unwrap().exponent, 6);
    }

    #[test]
    fn major_to_minor_by_asset() {
        assert_eq!(
            parse_major(&json!(480), &usd(), false).unwrap(),
            Minor(48_000)
        );
        assert_eq!(
            parse_major(&json!("480.50"), &usd(), false).unwrap(),
            Minor(48_050)
        );
        assert_eq!(
            parse_major(&json!("480.5"), &usd(), false).unwrap(),
            Minor(48_050)
        );
        assert_eq!(
            parse_major(&json!(480.5), &usd(), false).unwrap(),
            Minor(48_050)
        );
        assert_eq!(
            parse_major(&json!("0.000021"), &usdc(), false).unwrap(),
            Minor(21)
        );
        assert_eq!(
            parse_major(&json!("100"), &usdc(), false).unwrap(),
            Minor(100_000_000)
        );
    }

    /// The reason minor units are not `u64`: one ether does not fit.
    #[test]
    fn eighteen_decimal_amounts_survive() {
        let one_eth = parse_major(&json!("1"), &eth(), false).unwrap();
        assert_eq!(one_eth, Minor(1_000_000_000_000_000_000));
        let many = parse_major(&json!("1234567.123456789012345678"), &eth(), false).unwrap();
        assert_eq!(many, Minor(1_234_567_123_456_789_012_345_678));
        assert!(many.0 > u128::from(u64::MAX), "beyond u64");
        assert_eq!(format_major(many, &eth()), "1234567.123456789012345678");
    }

    /// Unit confusion: a caller writes more precision than the asset has. The
    /// amount evaluated must never differ from the amount written, so this is
    /// refused rather than rounded.
    #[test]
    fn too_much_precision_is_refused_not_rounded() {
        let err = parse_major(&json!("100.0000001"), &usdc(), false).unwrap_err();
        assert!(
            matches!(
                err,
                AmountError::TooPrecise {
                    digits: 7,
                    exponent: 6,
                    ..
                }
            ),
            "{err:?}"
        );
        assert!(parse_major(&json!("1.234"), &usd(), false).is_err());
        assert!(parse_major(
            &json!("1.5"),
            &AssetRegistry::new().lookup("JPY", None).unwrap(),
            false
        )
        .is_err());
    }

    #[test]
    fn refuses_signs_exponents_and_junk() {
        for bad in [
            "-1", "1e3", "1E3", "+1", "", " ", "1.2.3", "abc", "1,000", "0x10",
        ] {
            assert!(
                parse_major(&json!(bad), &usd(), false).is_err(),
                "{bad:?} should not parse"
            );
        }
        assert!(parse_major(&json!(true), &usd(), false).is_err());
    }

    #[test]
    fn zero_is_refused_unless_allowed() {
        assert!(parse_major(&json!("0"), &usd(), false).is_err());
        assert_eq!(parse_major(&json!("0"), &usd(), true).unwrap(), Minor::ZERO);
        assert_eq!(
            parse_major(&json!("0.00"), &usd(), true).unwrap(),
            Minor::ZERO
        );
    }

    #[test]
    fn formatting_round_trips() {
        for (text, asset) in [
            ("480.50", usd()),
            ("0.000021", usdc()),
            ("1.000000000000000001", eth()),
        ] {
            let minor = parse_major_str(text, &asset, false).unwrap();
            assert_eq!(format_major(minor, &asset), text);
        }
        assert_eq!(
            format_major(Minor(7), &AssetRegistry::new().lookup("JPY", None).unwrap()),
            "7"
        );
        assert_eq!(format_major(Minor(5), &usd()), "0.05");
    }

    /// Minor units go out as strings because a JSON number is an `f64` here
    /// and would not survive; they come back from either, so state written
    /// before this change still loads.
    #[test]
    fn minor_serializes_as_a_string_and_reads_either() {
        let big = Minor(1_234_567_123_456_789_012_345_678);
        assert_eq!(
            serde_json::to_string(&big).unwrap(),
            "\"1234567123456789012345678\""
        );
        assert_eq!(
            serde_json::from_str::<Minor>("\"48000\"").unwrap(),
            Minor(48_000)
        );
        assert_eq!(
            serde_json::from_str::<Minor>("48000").unwrap(),
            Minor(48_000)
        );
        assert_eq!(
            serde_json::from_value::<Minor>(serde_json::to_value(big).unwrap()).unwrap(),
            big,
            "round trip keeps every digit"
        );
        assert!(serde_json::from_str::<Minor>("-1").is_err());
    }
}
