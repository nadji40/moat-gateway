//! Where the money goes, in a form that can be compared safely.
//!
//! A payee is a name a human recognises. A *destination* is the thing the
//! rail actually credits: an IBAN, an account number, an address. On a card
//! rail the name carries most of the risk, because the network knows who the
//! merchant is. On a bank or on-chain rail the destination **is** the
//! payment, and the name beside it is decoration the rail may never check.
//!
//! Destinations cannot be compared the way names are, and the reasons are
//! specific rather than stylistic:
//!
//! - **Substring matching is wrong for an identifier.** `Acme` being part of
//!   `Acme Cloud Ltd` is at worst a coincidence; a fragment of an address
//!   matching a different address is how address poisoning works.
//! - **The numeric path launders trust.** `crate::normalize` canonicalizes a
//!   digits-only string by dropping leading zeros, so the account `0012345`
//!   and the number `12345` become the same value. If the user's request
//!   happens to mention invoice 12345, that account resolves to
//!   [`Source::User`](crate::source::Source::User) — an unrelated number
//!   would have granted an attacker's account the user's own authority.
//! - **Case folding is not free.** Lowercasing lets an IBAN match whatever
//!   its spacing, but base58 is case-sensitive, so two genuinely different
//!   Solana addresses can fold onto the same string. And lowercasing an
//!   EIP-55 address discards the one integrity check it carries.
//!
//! So each kind gets a canonical form of its own, and destinations are
//! matched **exactly** against it — never by substring, never numerically.
//! Anything unrecognised stays [`DestinationKind::Opaque`] and is compared as
//! the trimmed text it arrived as, which is what a provider-specific account
//! identifier such as `acct_supplier_001` has always been.

use std::fmt;

use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

/// What sort of identifier a destination is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DestinationKind {
    /// An IBAN that passes its mod-97 check digits.
    Iban,
    /// A 20-byte Ethereum-style address. Mixed case must pass EIP-55.
    EvmAddress,
    /// A 32-byte Solana address in base58.
    SolanaAddress,
    /// Anything else: a provider account id, a handle, a reference. Compared
    /// as the trimmed text it arrived as, because nothing here can validate
    /// a format it does not know.
    Opaque,
}

impl DestinationKind {
    /// The prefix that keeps keys of different kinds from ever colliding.
    fn prefix(self) -> &'static str {
        match self {
            DestinationKind::Iban => "iban",
            DestinationKind::EvmAddress => "evm",
            DestinationKind::SolanaAddress => "sol",
            DestinationKind::Opaque => "opaque",
        }
    }
}

/// A destination, in both the form a human was shown and the form Moat
/// compares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Destination {
    /// Which kind of identifier this is.
    pub kind: DestinationKind,
    /// The comparison form. Two destinations are the same account exactly
    /// when their canonical forms are equal.
    pub canonical: String,
    /// As written by whoever supplied it, for prompts and evidence. A human
    /// approving a payment should see the string they will recognise.
    pub display: String,
}

impl Destination {
    /// Read a destination, inferring its kind.
    ///
    /// Never fails: an identifier this build cannot classify is
    /// [`DestinationKind::Opaque`], which compares as trimmed text. That is
    /// what keeps a provider's own account ids working unchanged.
    ///
    /// A mixed-case Ethereum address whose EIP-55 checksum does not verify is
    /// deliberately *not* classified as an address. It is a typo or a forgery,
    /// and leaving it opaque means it cannot match a real one.
    pub fn parse(raw: &str) -> Destination {
        let display = raw.trim().to_owned();
        if let Some(canonical) = canonical_iban(&display) {
            return Destination {
                kind: DestinationKind::Iban,
                canonical,
                display,
            };
        }
        if let Some(canonical) = canonical_evm(&display) {
            return Destination {
                kind: DestinationKind::EvmAddress,
                canonical,
                display,
            };
        }
        if let Some(canonical) = canonical_solana(&display) {
            return Destination {
                kind: DestinationKind::SolanaAddress,
                canonical,
                display,
            };
        }
        Destination {
            kind: DestinationKind::Opaque,
            canonical: display.clone(),
            display,
        }
    }

    /// The single string two destinations are compared on. Kind-prefixed, so
    /// an opaque identifier can never be mistaken for a validated one.
    pub fn key(&self) -> String {
        format!("{}:{}", self.kind.prefix(), self.canonical)
    }

    /// Whether this is the same account as `other`.
    pub fn same_as(&self, other: &Destination) -> bool {
        self.kind == other.kind && self.canonical == other.canonical
    }
}

impl fmt::Display for Destination {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.display)
    }
}

/// Strip the separators people write identifiers with.
fn compact(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect()
}

/// An IBAN, uppercased and compacted, if it passes mod-97.
///
/// The check digits are what make this safe to detect in free text: a random
/// run of letters and digits fails them 96 times out of 97.
fn canonical_iban(raw: &str) -> Option<String> {
    let compacted = compact(raw).to_ascii_uppercase();
    if !(15..=34).contains(&compacted.len()) {
        return None;
    }
    let bytes = compacted.as_bytes();
    if !bytes[0].is_ascii_alphabetic()
        || !bytes[1].is_ascii_alphabetic()
        || !bytes[2].is_ascii_digit()
        || !bytes[3].is_ascii_digit()
        || !bytes.iter().all(|b| b.is_ascii_alphanumeric())
    {
        return None;
    }
    // Move the country code and check digits to the end, map letters to
    // numbers, and take the whole thing mod 97 in chunks so it fits a u32.
    let rearranged: String = compacted[4..]
        .chars()
        .chain(compacted[..4].chars())
        .collect();
    let mut remainder: u32 = 0;
    for c in rearranged.chars() {
        let value = if c.is_ascii_digit() {
            u32::from(c as u8 - b'0')
        } else {
            u32::from(c as u8 - b'A') + 10
        };
        remainder = if value >= 10 {
            (remainder * 100 + value) % 97
        } else {
            (remainder * 10 + value) % 97
        };
    }
    (remainder == 1).then_some(compacted)
}

/// A 20-byte Ethereum-style address, lowercased.
///
/// All-lowercase and all-uppercase forms are accepted as written. A mixed
/// case form must be a valid EIP-55 checksum, so a mistyped address is
/// rejected here rather than compared against a real one.
fn canonical_evm(raw: &str) -> Option<String> {
    let s = raw.trim();
    let hex = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let lower = hex.to_ascii_lowercase();
    let has_upper = hex.bytes().any(|b| b.is_ascii_uppercase());
    let has_lower = hex.bytes().any(|b| b.is_ascii_lowercase());
    if has_upper && has_lower && eip55(&lower) != hex {
        return None;
    }
    Some(format!("0x{lower}"))
}

/// The EIP-55 mixed-case form of a lowercase hex address body.
fn eip55(lower: &str) -> String {
    let digest = Keccak256::digest(lower.as_bytes());
    let hash = hex::encode(digest);
    lower
        .chars()
        .zip(hash.chars())
        .map(|(c, h)| {
            if c.is_ascii_digit() || h < '8' {
                c
            } else {
                c.to_ascii_uppercase()
            }
        })
        .collect()
}

/// A 32-byte base58 address, re-encoded from its bytes.
///
/// Re-encoding rather than trusting the text means any form that decodes to
/// the same key compares equal, and nothing that is not exactly 32 bytes is
/// treated as an address at all.
fn canonical_solana(raw: &str) -> Option<String> {
    let s = raw.trim();
    if !(32..=44).contains(&s.len()) {
        return None;
    }
    let bytes = base58_decode(s)?;
    (bytes.len() == 32).then(|| base58_encode(&bytes))
}

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58_decode(s: &str) -> Option<Vec<u8>> {
    if s.is_empty() {
        return None;
    }
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    for c in s.bytes() {
        let mut carry = u32::try_from(B58.iter().position(|&b| b == c)?).ok()?;
        for byte in out.iter_mut() {
            let x = u32::from(*byte) * 58 + carry;
            *byte = (x & 0xff) as u8;
            carry = x >> 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // A leading '1' is a leading zero byte, which the arithmetic above drops.
    let leading_zeros = s.bytes().take_while(|&b| b == b'1').count();
    out.resize(out.len() + leading_zeros, 0);
    out.reverse();
    Some(out)
}

fn base58_encode(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        let mut carry = u32::from(b);
        for d in digits.iter_mut() {
            let x = u32::from(*d) * 256 + carry;
            *d = (x % 58) as u8;
            carry = x / 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::with_capacity(digits.len() + 1);
    for _ in bytes.iter().take_while(|&&b| b == 0) {
        out.push('1');
    }
    for &d in digits.iter().rev() {
        out.push(char::from(B58[usize::from(d)]));
    }
    out
}

/// Every destination that can be recognised inside free text.
///
/// Used on the content an agent reads, so that a destination taken from a
/// page is attributable to that page rather than resolving to `Unknown`.
/// Detection is strict on purpose: an IBAN must pass mod-97, an address must
/// be exactly the right length and shape. A loose scanner here would put
/// spurious destinations into the provenance record, which is the opposite of
/// what the record is for.
pub fn destinations_in_text(text: &str) -> Vec<Destination> {
    let mut out: Vec<Destination> = Vec::new();
    let mut push = |d: Destination| {
        if !out.iter().any(|existing| existing.key() == d.key()) {
            out.push(d);
        }
    };
    // Candidate runs: identifiers never contain whitespace, and the usual
    // surrounding punctuation is not part of one.
    for raw in text.split(|c: char| {
        c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '<' | '>' | '"' | '\'')
    }) {
        let token = raw.trim_matches(|c: char| matches!(c, '.' | ':' | '!' | '?' | '[' | ']'));
        if token.len() < 15 {
            continue;
        }
        if let Some(canonical) = canonical_evm(token) {
            push(Destination {
                kind: DestinationKind::EvmAddress,
                canonical,
                display: token.to_owned(),
            });
            continue;
        }
        if let Some(canonical) = canonical_iban(token) {
            push(Destination {
                kind: DestinationKind::Iban,
                canonical,
                display: token.to_owned(),
            });
            continue;
        }
        if let Some(canonical) = canonical_solana(token) {
            push(Destination {
                kind: DestinationKind::SolanaAddress,
                canonical,
                display: token.to_owned(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real-shaped IBAN and its spaced presentation.
    const IBAN: &str = "DE89370400440532013000";
    const IBAN_SPACED: &str = "DE89 3704 0044 0532 0130 00";
    // Vitalik's well-known address, in its EIP-55 form.
    const EVM_CHECKSUMMED: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const EVM_LOWER: &str = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    // The SPL memo program, a 32-byte address.
    const SOL: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

    #[test]
    fn an_iban_compares_the_same_however_it_is_written() {
        let a = Destination::parse(IBAN);
        let b = Destination::parse(IBAN_SPACED);
        let c = Destination::parse("de89-3704-0044-0532-0130-00");
        assert_eq!(a.kind, DestinationKind::Iban);
        assert!(
            a.same_as(&b) && a.same_as(&c),
            "spacing and case are presentation"
        );
        assert_eq!(a.key(), format!("iban:{IBAN}"));
        // The display form keeps what the human was shown.
        assert_eq!(b.display, IBAN_SPACED);
    }

    #[test]
    fn a_string_that_fails_the_check_digits_is_not_an_iban() {
        // One digit changed: mod-97 no longer holds.
        let bad = Destination::parse("DE89370400440532013001");
        assert_eq!(bad.kind, DestinationKind::Opaque);
        assert!(!bad.same_as(&Destination::parse(IBAN)));
    }

    #[test]
    fn an_evm_address_is_case_insensitive_but_the_checksum_must_hold() {
        let checksummed = Destination::parse(EVM_CHECKSUMMED);
        let lower = Destination::parse(EVM_LOWER);
        assert_eq!(checksummed.kind, DestinationKind::EvmAddress);
        assert!(checksummed.same_as(&lower));
        assert_eq!(checksummed.canonical, EVM_LOWER);
        assert_eq!(checksummed.display, EVM_CHECKSUMMED, "shown as written");

        // A mixed-case address with one letter's case flipped no longer
        // checksums. It is a typo or a forgery, so it is not an address, and
        // it cannot match the real one.
        let tampered = "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
        let parsed = Destination::parse(tampered);
        assert_eq!(parsed.kind, DestinationKind::Opaque, "{tampered}");
        assert!(!parsed.same_as(&checksummed));
    }

    #[test]
    fn base58_round_trips_and_only_32_bytes_is_an_address() {
        let sol = Destination::parse(SOL);
        assert_eq!(sol.kind, DestinationKind::SolanaAddress);
        assert_eq!(sol.canonical, SOL, "re-encoding is the identity here");
        // All-ones is 32 zero bytes: the system program.
        let zeros = Destination::parse("11111111111111111111111111111111");
        assert_eq!(zeros.kind, DestinationKind::SolanaAddress);
        assert_eq!(
            base58_decode("11111111111111111111111111111111").unwrap(),
            vec![0u8; 32]
        );
        // Base58 excludes 0, O, I and l, so a string using them is not one.
        assert_eq!(
            Destination::parse("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl").kind,
            DestinationKind::Opaque
        );
    }

    /// The reason this module exists. Under name matching, an argument that
    /// is a fragment of a real address, or a digits-only account that shares
    /// a number with the user's request, could be credited to the wrong
    /// source. Canonical keys make every one of those a non-match.
    #[test]
    fn near_misses_are_not_matches() {
        let real = Destination::parse(EVM_LOWER);
        for near in [
            // A poisoned lookalike sharing the first and last characters.
            "0xd8da6bf26964af9d7eed9e03e53415d37aa96040",
            "0xd8da0000000000000000000000000000aa96045",
            // A truncated display form, of the sort a page would show.
            "0xd8da6b...a96045",
            "d8da6bf26964af9d7eed9e03e53415d37aa96045",
        ] {
            assert!(
                !Destination::parse(near).same_as(&real),
                "{near} must not be the same account"
            );
        }
        // Leading zeros are part of an account number, not noise to strip.
        assert!(!Destination::parse("0012345").same_as(&Destination::parse("12345")));
        // And an opaque identifier can never collide with a validated one.
        assert_ne!(
            Destination::parse("acct_supplier_001").key(),
            Destination::parse(IBAN).key()
        );
    }

    #[test]
    fn a_provider_account_id_is_opaque_and_compares_as_written() {
        let a = Destination::parse("acct_supplier_001");
        assert_eq!(a.kind, DestinationKind::Opaque);
        assert!(
            a.same_as(&Destination::parse("  acct_supplier_001  ")),
            "trimmed"
        );
        assert!(!a.same_as(&Destination::parse("acct_attacker_999")));
        assert!(
            !a.same_as(&Destination::parse("ACCT_SUPPLIER_001")),
            "an unknown format cannot be assumed case-insensitive"
        );
    }

    #[test]
    fn destinations_are_found_in_page_text() {
        let text = format!(
            "Please remit to {IBAN_SPACED} or on-chain to {EVM_CHECKSUMMED}. \
             Memo program: {SOL}."
        );
        let found = destinations_in_text(&text);
        let kinds: Vec<_> = found.iter().map(|d| d.kind).collect();
        assert!(kinds.contains(&DestinationKind::EvmAddress), "{found:?}");
        assert!(kinds.contains(&DestinationKind::SolanaAddress), "{found:?}");
        // The spaced IBAN is several tokens in prose, so it is not detected
        // there; the compact form is.
        let compact_found = destinations_in_text(&format!("remit to {IBAN} today"));
        assert_eq!(compact_found.len(), 1);
        assert_eq!(compact_found[0].kind, DestinationKind::Iban);
    }

    /// Scanning must not invent destinations out of ordinary prose, or the
    /// provenance record fills with things that were never identifiers. In
    /// particular the evidence golden's text must yield nothing.
    #[test]
    fn ordinary_text_yields_no_destinations() {
        for text in [
            "Pay ProMon Billing Ltd $480 today",
            "Renew our monitoring tools, keep it under $500",
            "Invoice INV-1001 from Monitoring Pro Inc for 99 USD",
            "",
            "0012345 12345 000",
        ] {
            assert!(
                destinations_in_text(text).is_empty(),
                "{text:?} produced {:?}",
                destinations_in_text(text)
            );
        }
    }
}
