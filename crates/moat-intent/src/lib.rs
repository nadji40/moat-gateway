//! Reads what a user typed into the intent fields the Moat core matches
//! payments against.
//!
//! The core never has to understand a sentence. It is given fields: who the
//! user asked to pay, who they refused, the amount, the currency, the
//! destination, and whether they took back what they asked for before. A
//! client that already has those, from a form or a checkout the user
//! confirmed, sends them to the gateway directly. A client that only has the
//! words sends them here.
//!
//! Here a small local model reads the words, in whatever language they were
//! written, and every value it returns is checked against the message before
//! anything is registered:
//!
//! - a payee must be written in the message, character for character;
//! - an amount must be a number the message contains, read with the
//!   message's own decimal and grouping conventions;
//! - a destination must be one the message contains;
//! - a currency must be a code the core knows;
//! - a payee the user also refused is not one they asked for.
//!
//! What fails a check is dropped and reported. Dropping only ever removes
//! something the user would be asking for, so every mistake the model makes
//! costs a confirmation and never a payment. When the model cannot be
//! reached, the message is registered with empty fields for the same reason.
//!
//! Before the model sees the message, account numbers, addresses and email
//! addresses are replaced by placeholders, and card numbers are removed from
//! both what the model sees and what is kept.

pub mod ground;
pub mod reader;
pub mod redact;
pub mod server;
