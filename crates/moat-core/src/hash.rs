//! Hashing and canonical JSON.
//!
//! Canonical JSON here means: object keys sorted, no insignificant whitespace,
//! UTF-8. It is what gets hashed and, later, signed. Two records that differ
//! only in key order or spacing hash the same.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of some bytes.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Serialize with sorted keys and no whitespace.
pub fn canonical_json(v: &Value) -> String {
    let mut out = String::new();
    write_canonical(v, &mut out);
    out
}

fn write_canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                // serde_json's string escaping is deterministic.
                out.push_str(&Value::String((*k).clone()).to_string());
                out.push(':');
                if let Some(child) = map.get(*k) {
                    write_canonical(child, out);
                }
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_sorted_recursively() {
        let v = json!({"b": 1, "a": {"z": [3, {"y": 2, "x": 1}], "m": "s"}});
        assert_eq!(
            canonical_json(&v),
            r#"{"a":{"m":"s","z":[3,{"x":1,"y":2}]},"b":1}"#
        );
    }

    #[test]
    fn same_content_same_hash() {
        let a = json!({"b": 1, "a": 2});
        let b = json!({"a": 2, "b": 1});
        assert_eq!(
            sha256_hex(canonical_json(&a).as_bytes()),
            sha256_hex(canonical_json(&b).as_bytes())
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
