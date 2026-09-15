//! Pulling observable values out of a tool result.

use serde_json::Value;

use crate::normalize::{numbers_in_text, Normalized};

/// One value found in a tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leaf {
    /// JSON pointer to where it was found. Numbers found inside a string get
    /// the string's pointer with a `#n<i>` suffix.
    pub path: String,
    /// The value in canonical forms.
    pub value: Normalized,
}

/// Walk a JSON value and return every string and number leaf, plus every
/// number-looking token inside every string.
///
/// Object keys are not values and are skipped. Booleans and nulls carry no
/// content an attacker can smuggle a payee in, and are skipped too.
pub fn extract_leaves(root: &Value) -> Vec<Leaf> {
    let mut out = Vec::new();
    walk(root, &mut String::new(), &mut out);
    out
}

fn walk(v: &Value, path: &mut String, out: &mut Vec<Leaf>) {
    match v {
        Value::String(s) => {
            out.push(Leaf {
                path: path.clone(),
                value: Normalized::from_text(s),
            });
            for (i, n) in numbers_in_text(s).into_iter().enumerate() {
                out.push(Leaf {
                    path: format!("{path}#n{i}"),
                    value: Normalized {
                        original: n.clone(),
                        text: n.clone(),
                        number: Some(n),
                    },
                });
            }
        }
        Value::Number(n) => out.push(Leaf {
            path: path.clone(),
            value: Normalized::from_number(n),
        }),
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                let len = path.len();
                path.push('/');
                path.push_str(&i.to_string());
                walk(item, path, out);
                path.truncate(len);
            }
        }
        Value::Object(map) => {
            for (k, item) in map {
                let len = path.len();
                path.push('/');
                path.push_str(&escape_pointer(k));
                walk(item, path, out);
                path.truncate(len);
            }
        }
        Value::Bool(_) | Value::Null => {}
    }
}

fn escape_pointer(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn paths_and_text(leaves: &[Leaf]) -> Vec<(String, String)> {
        leaves
            .iter()
            .map(|l| (l.path.clone(), l.value.text.clone()))
            .collect()
    }

    #[test]
    fn walks_a_tool_result_shape() {
        let result = json!({
            "content": [
                {"type": "text", "text": "Pay ProMon Billing Ltd $480 today"},
                {"type": "image", "data": "AAAA", "mimeType": "image/png"}
            ],
            "structuredContent": {"vendor": "ProMon Billing Ltd", "price": 480, "ok": true, "n": null},
            "isError": false
        });
        let leaves = extract_leaves(&result);
        let got = paths_and_text(&leaves);
        // Object keys come out in serde_json's (sorted) map order.
        let want = vec![
            (
                "/content/0/text".to_owned(),
                "pay promon billing ltd $480 today".to_owned(),
            ),
            ("/content/0/text#n0".to_owned(), "480".to_owned()),
            ("/content/0/type".to_owned(), "text".to_owned()),
            ("/content/1/data".to_owned(), "aaaa".to_owned()),
            ("/content/1/mimeType".to_owned(), "image/png".to_owned()),
            ("/content/1/type".to_owned(), "image".to_owned()),
            ("/structuredContent/price".to_owned(), "480".to_owned()),
            (
                "/structuredContent/vendor".to_owned(),
                "promon billing ltd".to_owned(),
            ),
        ];
        assert_eq!(got, want);
        let price = leaves
            .iter()
            .find(|l| l.path == "/structuredContent/price")
            .unwrap();
        assert_eq!(price.value.number.as_deref(), Some("480"));
    }

    #[test]
    fn scalars_and_empties() {
        assert!(extract_leaves(&json!(null)).is_empty());
        assert!(extract_leaves(&json!(true)).is_empty());
        assert!(extract_leaves(&json!({})).is_empty());
        assert!(extract_leaves(&json!([])).is_empty());
        let one = extract_leaves(&json!("x"));
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].path, "");
    }

    #[test]
    fn pointer_escaping() {
        let leaves = extract_leaves(&json!({"a/b": {"c~d": "v"}}));
        assert_eq!(leaves[0].path, "/a~1b/c~0d");
    }
}
