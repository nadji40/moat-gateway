//! Outbound mail.
//!
//! The gateway sends exactly one kind of message: a recovery key to the
//! address a workspace's owner gave at signup. It hands the message to the
//! mail server on this machine over plain SMTP on loopback; that server (cPanel's
//! Exim on the pilot host) signs it with the domain's DKIM key and delivers
//! it. Nothing here authenticates, because nothing here leaves the machine:
//! the config refuses a host that is not loopback.
//!
//! What this module never does is log the key it sends, or the address it
//! sends it to, at any level above debug.

use std::time::Duration;

use anyhow::{Context, Result};
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::config::Mail;

/// A configured sender. Built once at startup; `None` when recovery is off.
pub struct Mailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    dashboard_url: String,
}

impl Mailer {
    /// The sender the config asks for, or `None` with a reason in the log.
    ///
    /// No `mail` section means the deployment did not ask for recovery. A
    /// `from` that does not parse as an address is a misconfiguration worth
    /// a warning but not a refusal to start: every other part of the gateway
    /// works without it, and the recovery endpoint says so itself.
    pub fn from_config(mail: Option<&Mail>) -> Option<Mailer> {
        let mail = mail?;
        let from: Mailbox = match mail.from.parse() {
            Ok(from) => from,
            Err(error) => {
                tracing::warn!(%error, "mail.from is not an address; admin-key recovery is off");
                return None;
            }
        };
        // Plain SMTP, which is why the config insists on a loopback host.
        let transport =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(mail.smtp.host.as_str())
                .port(mail.smtp.port)
                .timeout(Some(Duration::from_secs(15)))
                .build();
        Some(Mailer {
            transport,
            from,
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
        let to: Mailbox = to.parse().context("the owner address")?;
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
        let attachment = Attachment::new(format!("moat-{workspace}-recovery-key.json")).body(
            file,
            ContentType::parse("application/json").context("attachment content type")?,
        );
        let message = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(format!("Your Moat recovery key for {workspace}"))
            .multipart(
                MultiPart::mixed()
                    .singlepart(SinglePart::plain(text))
                    .singlepart(attachment),
            )
            .context("building the recovery mail")?;
        self.transport
            .send(message)
            .await
            .context("handing the recovery mail to the mail server")?;
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn a_display_name_in_from_is_accepted_and_a_bare_word_is_not() {
        assert!("Moat <no-reply@moatgateway.dpdns.org>"
            .parse::<Mailbox>()
            .is_ok());
        assert!("no-reply@moatgateway.dpdns.org".parse::<Mailbox>().is_ok());
        assert!("not an address".parse::<Mailbox>().is_err());
    }
}
