//! Outbound mail.
//!
//! The gateway sends exactly one kind of message: a recovery key to the
//! address a workspace's owner gave at signup. It goes through a transactional
//! mail provider over HTTPS rather than an SMTP server of our own, because a
//! message from a fresh VPS address lands in spam and a message from a
//! provider's verified domain does not. One provider is implemented; the
//! request shape is small enough that a second is an afternoon.
//!
//! What this module never does is log the key it sends, or the address it
//! sends it to, at any level above debug.

use anyhow::{Context, Result};

use crate::config::{Mail, MailProvider};

/// A configured sender. Built once at startup; `None` when recovery is off.
pub struct Mailer {
    client: reqwest::Client,
    provider: MailProvider,
    api_key: String,
    from: String,
    dashboard_url: String,
}

impl Mailer {
    /// The sender the config asks for, or `None` with a reason in the log.
    ///
    /// No `mail` section means the deployment did not ask for recovery. A
    /// section whose API key is not in the environment is a misconfiguration
    /// worth a warning but not a refusal to start: every other part of the
    /// gateway works without it, and the recovery endpoint says so itself.
    pub fn from_config(mail: Option<&Mail>) -> Option<Mailer> {
        let mail = mail?;
        let api_key = match std::env::var(&mail.api_key_env) {
            Ok(key) if !key.trim().is_empty() => key.trim().to_owned(),
            _ => {
                tracing::warn!(
                    env = %mail.api_key_env,
                    "mail is configured but its API key is not in the environment; admin-key recovery is off"
                );
                return None;
            }
        };
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .ok()?;
        Some(Mailer {
            client,
            provider: mail.provider,
            api_key,
            from: mail.from.clone(),
            dashboard_url: mail.dashboard_url.trim_end_matches('/').to_owned(),
        })
    }

    /// Mail a recovery key to the workspace's owner.
    ///
    /// The key travels twice: in the text, to copy, and as a JSON attachment
    /// of the same shape the dashboard offers for download, so the file that
    /// arrives is the file the sign-in form already knows how to read.
    pub async fn send_recovery(
        &self,
        to: &str,
        workspace: &str,
        recovery_key: &str,
        expires_at: &str,
    ) -> Result<()> {
        let file = recovery_file(workspace, recovery_key, expires_at, &self.dashboard_url);
        let text = format!(
            "Somebody asked for a new admin key for the Moat workspace \"{workspace}\".\n\
             \n\
             If that was you, open {dashboard} choose \"I have a key\", and paste this \
             recovery key, or upload the attached file:\n\
             \n\
             {recovery_key}\n\
             \n\
             It works once and expires at {expires_at}. Redeeming it issues a new admin \
             key and withdraws every previous admin key of the workspace, so a key that \
             was lost cannot be used by whoever found it.\n\
             \n\
             If you did not ask for this, ignore it: nothing changes until the key is used.\n",
            dashboard = self.dashboard_url,
        );
        let body = serde_json::json!({
            "from": self.from,
            "to": [to],
            "subject": format!("Your Moat recovery key for {workspace}"),
            "text": text,
            "attachments": [{
                "filename": format!("moat-{workspace}-recovery-key.json"),
                "content": base64(file.as_bytes()),
            }],
        });
        let endpoint = match self.provider {
            MailProvider::Resend => "https://api.resend.com/emails",
        };
        let response = self
            .client
            .post(endpoint)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("reaching the mail provider")?;
        let status = response.status();
        if !status.is_success() {
            // The body may echo the address; the status is enough to act on.
            anyhow::bail!("the mail provider answered {status}");
        }
        tracing::info!(workspace, "recovery key mailed");
        Ok(())
    }
}

/// The attachment: the same shape as a downloaded key file, with a
/// `recovery_key` where that file has a `key`, so the sign-in form can tell
/// the two apart and knows what to do with each.
fn recovery_file(
    workspace: &str,
    recovery_key: &str,
    expires_at: &str,
    dashboard_url: &str,
) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "moat_recovery_key": 1,
        "workspace": workspace,
        "recovery_key": recovery_key,
        "expires_at": expires_at,
        "use_at": dashboard_url,
        "note": "Works once, until expires_at. Redeeming it issues a new admin key and withdraws the previous admin keys.",
    }))
    .unwrap_or_default()
}

/// Standard base64 with padding, for the attachment. Small enough to write
/// here rather than take a dependency for one call.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_vectors() {
        for (input, want) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), want, "{input:?}");
        }
    }

    #[test]
    fn the_attachment_is_a_key_file_the_sign_in_form_can_read() {
        let text = recovery_file(
            "northwind",
            "rk_abc",
            "2026-10-30T15:00:00Z",
            "https://moatgateway.dpdns.org/dashboard",
        );
        let file: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(file["workspace"], "northwind");
        assert_eq!(file["recovery_key"], "rk_abc");
        assert!(
            file.get("key").is_none(),
            "a recovery file must not look like an admin key file"
        );
    }
}
