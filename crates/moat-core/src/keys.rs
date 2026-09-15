//! ed25519 keys for signing evidence.
//!
//! On disk a keypair is two files in one directory: `moat_ed25519` holding the
//! 32-byte seed as lowercase hex (mode 0600 on Unix) and `moat_ed25519.pub`
//! holding the 32-byte public key as lowercase hex.

use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// Secret key file name.
pub const SECRET_FILE: &str = "moat_ed25519";
/// Public key file name.
pub const PUBLIC_FILE: &str = "moat_ed25519.pub";

/// Key handling failures.
#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    /// Filesystem problem.
    #[error("{action} {path}: {source}")]
    Io {
        /// What was being attempted.
        action: &'static str,
        /// The file.
        path: PathBuf,
        /// The error.
        #[source]
        source: std::io::Error,
    },
    /// A key file did not contain 64 hex characters.
    #[error("{path}: expected 64 hex characters, got {detail}")]
    Format {
        /// The file.
        path: PathBuf,
        /// What was wrong.
        detail: String,
    },
    /// A public key was not a valid curve point.
    #[error("invalid public key: {0}")]
    InvalidPublic(String),
    /// The OS random source failed.
    #[error("random source failed: {0}")]
    Random(String),
    /// A signature did not verify.
    #[error("signature does not verify")]
    BadSignature,
    /// A signature string was not valid.
    #[error("malformed signature: {0}")]
    MalformedSignature(String),
}

/// A signing keypair.
#[derive(Clone)]
pub struct Keys {
    signing: SigningKey,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Keys")
            .field("public", &self.public_hex())
            .finish_non_exhaustive()
    }
}

impl Keys {
    /// A fresh random keypair.
    pub fn generate() -> Result<Keys, KeyError> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|e| KeyError::Random(e.to_string()))?;
        Ok(Keys::from_seed(seed))
    }

    /// A keypair from a fixed seed. Deterministic; for tests and golden files.
    pub fn from_seed(seed: [u8; 32]) -> Keys {
        Keys {
            signing: SigningKey::from_bytes(&seed),
        }
    }

    /// The public key.
    pub fn public(&self) -> Public {
        Public {
            verifying: self.signing.verifying_key(),
        }
    }

    /// Public key as lowercase hex.
    pub fn public_hex(&self) -> String {
        self.public().to_hex()
    }

    /// Sign bytes; returns the 64-byte signature as lowercase hex.
    pub fn sign_hex(&self, bytes: &[u8]) -> String {
        hex::encode(self.signing.sign(bytes).to_bytes())
    }

    /// Load from `dir`, or generate and write a new pair if the secret file
    /// is absent. Returns the keys and whether they were freshly created.
    pub fn load_or_create(dir: &Path) -> Result<(Keys, bool), KeyError> {
        let secret_path = dir.join(SECRET_FILE);
        if secret_path.exists() {
            return Keys::load(dir).map(|k| (k, false));
        }
        let keys = Keys::generate()?;
        keys.save(dir)?;
        Ok((keys, true))
    }

    /// Load from `dir`.
    pub fn load(dir: &Path) -> Result<Keys, KeyError> {
        let path = dir.join(SECRET_FILE);
        let seed = read_hex32(&path)?;
        Ok(Keys::from_seed(seed))
    }

    /// Write both files into `dir`, creating it if needed. Refuses to
    /// overwrite an existing secret.
    pub fn save(&self, dir: &Path) -> Result<(), KeyError> {
        std::fs::create_dir_all(dir).map_err(|source| KeyError::Io {
            action: "creating",
            path: dir.to_path_buf(),
            source,
        })?;
        let secret_path = dir.join(SECRET_FILE);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&secret_path).map_err(|source| KeyError::Io {
            action: "creating",
            path: secret_path.clone(),
            source,
        })?;
        use std::io::Write;
        writeln!(f, "{}", hex::encode(self.signing.to_bytes())).map_err(|source| KeyError::Io {
            action: "writing",
            path: secret_path.clone(),
            source,
        })?;
        let public_path = dir.join(PUBLIC_FILE);
        std::fs::write(&public_path, format!("{}\n", self.public_hex())).map_err(|source| {
            KeyError::Io {
                action: "writing",
                path: public_path,
                source,
            }
        })
    }
}

/// A public key, for verification.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Public {
    verifying: VerifyingKey,
}

impl Public {
    /// From 64 hex characters.
    pub fn from_hex(s: &str) -> Result<Public, KeyError> {
        let bytes = hex::decode(s.trim()).map_err(|e| KeyError::InvalidPublic(e.to_string()))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| KeyError::InvalidPublic("expected 32 bytes".to_owned()))?;
        let verifying =
            VerifyingKey::from_bytes(&arr).map_err(|e| KeyError::InvalidPublic(e.to_string()))?;
        Ok(Public { verifying })
    }

    /// Load `moat_ed25519.pub` from `dir`.
    pub fn load(dir: &Path) -> Result<Public, KeyError> {
        let path = dir.join(PUBLIC_FILE);
        let text = std::fs::read_to_string(&path).map_err(|source| KeyError::Io {
            action: "reading",
            path,
            source,
        })?;
        Public::from_hex(&text)
    }

    /// As lowercase hex.
    pub fn to_hex(&self) -> String {
        hex::encode(self.verifying.to_bytes())
    }

    /// Verify a hex signature over bytes.
    pub fn verify_hex(&self, bytes: &[u8], sig_hex: &str) -> Result<(), KeyError> {
        let sig_bytes =
            hex::decode(sig_hex).map_err(|e| KeyError::MalformedSignature(e.to_string()))?;
        let sig = Signature::from_slice(&sig_bytes)
            .map_err(|e| KeyError::MalformedSignature(e.to_string()))?;
        self.verifying
            .verify(bytes, &sig)
            .map_err(|_| KeyError::BadSignature)
    }
}

fn read_hex32(path: &Path) -> Result<[u8; 32], KeyError> {
    let text = std::fs::read_to_string(path).map_err(|source| KeyError::Io {
        action: "reading",
        path: path.to_path_buf(),
        source,
    })?;
    let bytes = hex::decode(text.trim()).map_err(|e| KeyError::Format {
        path: path.to_path_buf(),
        detail: e.to_string(),
    })?;
    bytes.try_into().map_err(|v: Vec<u8>| KeyError::Format {
        path: path.to_path_buf(),
        detail: format!("{} bytes", v.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_round_trip() {
        let k = Keys::generate().unwrap();
        let sig = k.sign_hex(b"hello");
        assert_eq!(sig.len(), 128);
        k.public().verify_hex(b"hello", &sig).unwrap();
        assert!(matches!(
            k.public().verify_hex(b"hellp", &sig),
            Err(KeyError::BadSignature)
        ));
        assert!(matches!(
            k.public().verify_hex(b"hello", "zz"),
            Err(KeyError::MalformedSignature(_))
        ));
    }

    #[test]
    fn seed_is_deterministic() {
        let a = Keys::from_seed([7u8; 32]);
        let b = Keys::from_seed([7u8; 32]);
        assert_eq!(a.public_hex(), b.public_hex());
        assert_eq!(
            a.sign_hex(b"x"),
            b.sign_hex(b"x"),
            "ed25519 is deterministic"
        );
    }

    #[test]
    fn save_load_and_refuse_overwrite() {
        let dir = std::env::temp_dir().join(format!("moat-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (k, created) = Keys::load_or_create(&dir).unwrap();
        assert!(created);
        let (k2, created) = Keys::load_or_create(&dir).unwrap();
        assert!(!created);
        assert_eq!(k.public_hex(), k2.public_hex());
        assert_eq!(Public::load(&dir).unwrap(), k.public());
        assert!(
            k.save(&dir).is_err(),
            "must not overwrite an existing secret"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(SECRET_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
