//! The signature a chain can require before money moves.
//!
//! Moat's verdict is advisory as long as the only thing acting on it is the
//! proxy the agent chose to call. This module makes it something a contract
//! can check: a secp256k1 signature over an EIP-712 `MoatVerdict`, which the
//! guarded wallet on the other end will not execute a payment without. ADR
//! 0010 has the reasoning and the threat model.
//!
//! Two things here are load-bearing and easy to get wrong.
//!
//! **The key is not the evidence key.** Evidence is ed25519 and proves what
//! Moat decided (ADR 0005). This key is secp256k1 because that is what the
//! EVM recovers, and it *causes* money to move. Different consequence,
//! different key, separate file, and a compromise of one is not a compromise
//! of the other.
//!
//! **Every field in the struct is there because leaving it out is an
//! attack.** The wallet address and the chain id stop a signature being
//! replayed against another deployment or another chain; the token stops a
//! signature for 250 USDC authorizing 250 of something else; the evidence id
//! binds the signature to the verdict that produced it and doubles as the
//! contract's replay key; the expiry stops a verdict becoming a standing
//! grant. A signature over the amount alone would be all of those attacks at
//! once.

use std::path::Path;

use k256::ecdsa::{RecoveryId, Signature, SigningKey};
use sha3::{Digest, Keccak256};

use crate::keys::KeyError;

/// Secret key file name. Sits beside `moat_ed25519` and is not it.
pub const COSIGN_SECRET_FILE: &str = "moat_secp256k1";
/// Address file name, for reading off and putting in a constructor.
pub const COSIGN_ADDRESS_FILE: &str = "moat_secp256k1.address";

/// The EIP-712 type string, hashed to give the type hash.
const VERDICT_TYPE: &[u8] = b"MoatVerdict(address wallet,address to,address token,uint256 value,bytes32 evidenceId,uint256 expiry)";
/// The EIP-712 domain type string.
const DOMAIN_TYPE: &[u8] =
    b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
/// Domain name. Changing this invalidates every signature ever issued.
const DOMAIN_NAME: &[u8] = b"Moat";
/// Domain version.
const DOMAIN_VERSION: &[u8] = b"1";

/// What a guarded wallet is being asked to execute.
///
/// Addresses are 20 bytes and the evidence id is 32, in the forms the EVM
/// uses, so that nothing about hex casing or 0x prefixes can change what is
/// signed. Parsing from strings happens at the edge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// The guarded wallet this signature is valid for.
    pub wallet: [u8; 20],
    /// Who gets paid.
    pub to: [u8; 20],
    /// The ERC-20 contract, or all zeroes for native value.
    pub token: [u8; 20],
    /// Amount in the token's base units, big-endian.
    pub value: [u8; 32],
    /// The Moat evidence record that allowed this payment.
    pub evidence_id: [u8; 32],
    /// Unix seconds after which the signature is worthless.
    pub expiry: u64,
}

impl Verdict {
    /// The EIP-712 `hashStruct` of this verdict.
    fn struct_hash(&self) -> [u8; 32] {
        let mut hasher = Keccak256::new();
        hasher.update(keccak(VERDICT_TYPE));
        hasher.update(left_pad20(&self.wallet));
        hasher.update(left_pad20(&self.to));
        hasher.update(left_pad20(&self.token));
        hasher.update(self.value);
        hasher.update(self.evidence_id);
        hasher.update(u256(self.expiry));
        hasher.finalize().into()
    }

    /// The 32 bytes actually signed: `keccak256(0x1901 ‖ domain ‖ struct)`.
    ///
    /// `verifying_contract` is the guarded wallet, which is also carried
    /// inside the struct. Both, deliberately: the domain binds the signature
    /// to the contract that checks it, and the field lets a reader see which
    /// wallet a signature is for without reconstructing the domain.
    pub fn digest(&self, chain_id: u64, verifying_contract: &[u8; 20]) -> [u8; 32] {
        let mut domain = Keccak256::new();
        domain.update(keccak(DOMAIN_TYPE));
        domain.update(keccak(DOMAIN_NAME));
        domain.update(keccak(DOMAIN_VERSION));
        domain.update(u256(chain_id));
        domain.update(left_pad20(verifying_contract));
        let domain_separator: [u8; 32] = domain.finalize().into();

        let mut hasher = Keccak256::new();
        hasher.update([0x19, 0x01]);
        hasher.update(domain_separator);
        hasher.update(self.struct_hash());
        hasher.finalize().into()
    }
}

/// Moat's co-signing key.
#[derive(Clone)]
pub struct CosignKey {
    signing: SigningKey,
}

impl std::fmt::Debug for CosignKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the secret, and not by accident: this type is put in
        // structs that get logged.
        f.debug_struct("CosignKey")
            .field("address", &self.address_hex())
            .finish_non_exhaustive()
    }
}

impl CosignKey {
    /// A fresh random key.
    pub fn generate() -> Result<CosignKey, KeyError> {
        let mut seed = [0u8; 32];
        loop {
            getrandom::fill(&mut seed).map_err(|e| KeyError::Random(e.to_string()))?;
            // Not every 32-byte string is a valid scalar. Draw again rather
            // than reduce, which would bias the key.
            if let Ok(signing) = SigningKey::from_slice(&seed) {
                return Ok(CosignKey { signing });
            }
        }
    }

    /// A key from fixed bytes. Deterministic; for tests.
    pub fn from_bytes(bytes: &[u8; 32]) -> Result<CosignKey, KeyError> {
        let signing = SigningKey::from_slice(bytes)
            .map_err(|e| KeyError::InvalidPublic(format!("not a valid secp256k1 scalar: {e}")))?;
        Ok(CosignKey { signing })
    }

    /// The Ethereum address of this key: the last 20 bytes of the keccak of
    /// the uncompressed public key without its `0x04` tag.
    pub fn address(&self) -> [u8; 20] {
        let point = self.signing.verifying_key().to_encoded_point(false);
        let hash = keccak(&point.as_bytes()[1..]);
        let mut out = [0u8; 20];
        out.copy_from_slice(&hash[12..]);
        out
    }

    /// The address as EIP-55 mixed-case hex with an `0x` prefix.
    pub fn address_hex(&self) -> String {
        eip55(&self.address())
    }

    /// Sign a verdict for a contract on a chain.
    ///
    /// Returns the 65-byte `r ‖ s ‖ v` hex string Solidity's `ecrecover`
    /// expects, with `v` in {27, 28}. Signatures are produced with a low
    /// `s`, which is what k256 does and what any contract checking
    /// malleability will insist on.
    pub fn sign_verdict(
        &self,
        verdict: &Verdict,
        chain_id: u64,
        verifying_contract: &[u8; 20],
    ) -> String {
        let digest = verdict.digest(chain_id, verifying_contract);
        // Signing a fixed-length prehash with a valid key has no failure
        // mode, but a panic here would take the gateway down, so the
        // impossible case returns an unusable signature instead and the
        // contract refuses it.
        let Ok((signature, recovery)) = self
            .signing
            .sign_prehash_recoverable(&digest)
            .map(|(s, r): (Signature, RecoveryId)| (s, r))
        else {
            return String::new();
        };
        let mut out = Vec::with_capacity(65);
        out.extend_from_slice(&signature.to_bytes());
        out.push(27 + recovery.to_byte());
        format!("0x{}", hex::encode(out))
    }

    /// Load from `dir`, or generate and write a new key if absent. Returns
    /// the key and whether it was freshly created.
    pub fn load_or_create(dir: &Path) -> Result<(CosignKey, bool), KeyError> {
        let path = dir.join(COSIGN_SECRET_FILE);
        if path.exists() {
            return CosignKey::load(dir).map(|k| (k, false));
        }
        let key = CosignKey::generate()?;
        key.save(dir)?;
        Ok((key, true))
    }

    /// Load from `dir`.
    pub fn load(dir: &Path) -> Result<CosignKey, KeyError> {
        let path = dir.join(COSIGN_SECRET_FILE);
        let text = std::fs::read_to_string(&path).map_err(|source| KeyError::Io {
            action: "reading",
            path: path.clone(),
            source,
        })?;
        let trimmed = text.trim().trim_start_matches("0x");
        let bytes = hex::decode(trimmed).map_err(|e| KeyError::Format {
            path: path.clone(),
            detail: e.to_string(),
        })?;
        let bytes: [u8; 32] = bytes.try_into().map_err(|_| KeyError::Format {
            path,
            detail: "expected 32 bytes".to_owned(),
        })?;
        CosignKey::from_bytes(&bytes)
    }

    /// Write the key and its address into `dir`. Refuses to overwrite.
    pub fn save(&self, dir: &Path) -> Result<(), KeyError> {
        std::fs::create_dir_all(dir).map_err(|source| KeyError::Io {
            action: "creating",
            path: dir.to_path_buf(),
            source,
        })?;
        let path = dir.join(COSIGN_SECRET_FILE);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).map_err(|source| KeyError::Io {
            action: "creating",
            path: path.clone(),
            source,
        })?;
        use std::io::Write;
        writeln!(f, "{}", hex::encode(self.signing.to_bytes())).map_err(|source| KeyError::Io {
            action: "writing",
            path,
            source,
        })?;
        let address_path = dir.join(COSIGN_ADDRESS_FILE);
        std::fs::write(&address_path, format!("{}\n", self.address_hex())).map_err(|source| {
            KeyError::Io {
                action: "writing",
                path: address_path,
                source,
            }
        })?;
        Ok(())
    }
}

/// Parse `0x`-prefixed hex into 20 bytes.
pub fn address_from_hex(text: &str) -> Result<[u8; 20], String> {
    let trimmed = text
        .trim()
        .trim_start_matches("0x")
        .trim_start_matches("0X");
    let bytes = hex::decode(trimmed).map_err(|e| e.to_string())?;
    bytes
        .try_into()
        .map_err(|_| format!("expected 20 bytes, got {}", trimmed.len() / 2))
}

/// Parse a 32-byte hash from hex, or hash the text if it is not one.
///
/// Evidence ids are `ev_` plus hex and are not 32 bytes, so they are hashed
/// to reach the chain. Either way one evidence record maps to exactly one
/// `bytes32`, which is all the contract's replay key needs.
pub fn evidence_id_to_bytes32(id: &str) -> [u8; 32] {
    let trimmed = id.trim().trim_start_matches("0x");
    if trimmed.len() == 64 {
        if let Ok(bytes) = hex::decode(trimmed) {
            if let Ok(array) = <[u8; 32]>::try_from(bytes) {
                return array;
            }
        }
    }
    keccak(id.as_bytes())
}

/// A decimal base-unit amount as a big-endian `uint256`.
pub fn value_from_decimal(text: &str) -> Result<[u8; 32], String> {
    let trimmed = text.trim();
    if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("{trimmed:?} is not a base-unit integer"));
    }
    let parsed: u128 = trimmed
        .parse()
        .map_err(|_| "amount does not fit".to_owned())?;
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&parsed.to_be_bytes());
    Ok(out)
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn left_pad20(address: &[u8; 20]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[12..].copy_from_slice(address);
    out
}

fn u256(value: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&value.to_be_bytes());
    out
}

/// EIP-55 mixed-case checksum encoding.
fn eip55(address: &[u8; 20]) -> String {
    let lower = hex::encode(address);
    let hash = keccak(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (i, c) in lower.chars().enumerate() {
        let nibble = if i % 2 == 0 {
            hash[i / 2] >> 4
        } else {
            hash[i / 2] & 0x0f
        };
        if c.is_ascii_digit() || nibble < 8 {
            out.push(c);
        } else {
            out.push(c.to_ascii_uppercase());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one vector everything else rests on. If the address derivation
    /// is wrong, every signature is by a key nobody deployed.
    #[test]
    fn the_address_is_derived_the_way_ethereum_derives_it() {
        // Well-known deterministic development key; holds nothing anywhere.
        let bytes = hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
            .unwrap();
        let key = CosignKey::from_bytes(&bytes.try_into().unwrap()).unwrap();
        assert_eq!(
            key.address_hex(),
            "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        );
    }

    fn verdict() -> Verdict {
        Verdict {
            wallet: address_from_hex("0x1111111111111111111111111111111111111111").unwrap(),
            to: address_from_hex("0x2222222222222222222222222222222222222222").unwrap(),
            token: [0u8; 20],
            value: value_from_decimal("100000000000000").unwrap(),
            evidence_id: evidence_id_to_bytes32("ev_3f26a9a37bda5dbff9061b25"),
            expiry: 1_800_000_000,
        }
    }

    /// Every field has to reach the digest. A field that is in the struct
    /// but not in the hash is a field an attacker may choose freely.
    #[test]
    fn changing_any_field_changes_the_digest() {
        let base = verdict();
        let wallet = address_from_hex("0x1111111111111111111111111111111111111111").unwrap();
        let digest = base.digest(84532, &wallet);

        let mut others = Vec::new();
        let mut v = base.clone();
        v.to = address_from_hex("0x3333333333333333333333333333333333333333").unwrap();
        others.push(("to", v));
        let mut v = base.clone();
        v.token = address_from_hex("0x036CbD53842c5426634e7929541eC2318f3dCF7e").unwrap();
        others.push(("token", v));
        let mut v = base.clone();
        v.value = value_from_decimal("100000000000001").unwrap();
        others.push(("value", v));
        let mut v = base.clone();
        v.evidence_id = evidence_id_to_bytes32("ev_0000000000000000000000ff");
        others.push(("evidence_id", v));
        let mut v = base.clone();
        v.expiry = 1_800_000_001;
        others.push(("expiry", v));
        let mut v = base.clone();
        v.wallet = address_from_hex("0x4444444444444444444444444444444444444444").unwrap();
        others.push(("wallet", v));

        for (field, other) in others {
            assert_ne!(
                digest,
                other.digest(84532, &wallet),
                "{field} does not reach the digest"
            );
        }
    }

    /// The chain id is in the domain, so the same verdict on another chain
    /// is a different signature. This is the network-substitution attack
    /// one layer down, and the domain is what closes it.
    #[test]
    fn the_same_verdict_on_another_chain_is_a_different_digest() {
        let v = verdict();
        let wallet = address_from_hex("0x1111111111111111111111111111111111111111").unwrap();
        assert_ne!(v.digest(84532, &wallet), v.digest(1, &wallet));
    }

    /// And so is the same verdict against another deployment.
    #[test]
    fn the_same_verdict_for_another_contract_is_a_different_digest() {
        let v = verdict();
        let a = address_from_hex("0x1111111111111111111111111111111111111111").unwrap();
        let b = address_from_hex("0x5555555555555555555555555555555555555555").unwrap();
        assert_ne!(v.digest(84532, &a), v.digest(84532, &b));
    }

    /// A signature has to recover to the signer, or the contract will
    /// reject every payment Moat allows.
    #[test]
    fn a_signature_recovers_to_the_signing_address() {
        use k256::ecdsa::VerifyingKey;
        let key = CosignKey::generate().unwrap();
        let v = verdict();
        let wallet = address_from_hex("0x1111111111111111111111111111111111111111").unwrap();
        let signature = key.sign_verdict(&v, 84532, &wallet);
        let raw = hex::decode(signature.trim_start_matches("0x")).unwrap();
        assert_eq!(raw.len(), 65, "r, s and v");
        assert!(raw[64] == 27 || raw[64] == 28, "v is {}", raw[64]);

        let sig = Signature::from_slice(&raw[..64]).unwrap();
        let recovery = RecoveryId::from_byte(raw[64] - 27).unwrap();
        let recovered =
            VerifyingKey::recover_from_prehash(&v.digest(84532, &wallet), &sig, recovery).unwrap();
        let point = recovered.to_encoded_point(false);
        let hash = keccak(&point.as_bytes()[1..]);
        assert_eq!(&hash[12..], &key.address()[..]);
    }

    /// Two evidence ids must not collide into one replay key, or paying
    /// one invoice would spend another's slot.
    #[test]
    fn distinct_evidence_ids_give_distinct_replay_keys() {
        assert_ne!(
            evidence_id_to_bytes32("ev_3f26a9a37bda5dbff9061b25"),
            evidence_id_to_bytes32("ev_3f26a9a37bda5dbff9061b26")
        );
    }

    #[test]
    fn an_amount_that_is_not_a_base_unit_integer_is_refused() {
        assert!(value_from_decimal("0.5").is_err());
        assert!(value_from_decimal("1e18").is_err());
        assert!(value_from_decimal("-1").is_err());
        assert!(value_from_decimal("").is_err());
        assert!(value_from_decimal("250000000").is_ok());
    }
}
