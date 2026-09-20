// What makes two requests the same payment.
//
// Its own module, not part of the server, because the smoke script and the
// tests need it and importing the server to get it would start an MCP
// server as a side effect.

import { createHash } from "node:crypto";

/**
 * The idempotency key: what identifies this payment, and nothing else.
 *
 * Destination, authorization and invoice. No timestamp and no counter, so
 * that a retry after a lost reply computes the same key and the provider
 * returns the same transfer rather than making a second one. NUL
 * separates, so that no concatenation of one field can spell another --
 * without it ("ab", "c") and ("a", "bc") are one key, and two different
 * payments collapse into one transfer.
 */
export function idempotencyKey(iban: string, authorizationId: string, invoiceId: string): string {
  return createHash("sha256")
    .update(`${iban.toUpperCase()}\0${authorizationId}\0${invoiceId}`)
    .digest("hex");
}
