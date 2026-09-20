// Comparing destinations, the same way the gateway does.
//
// This mirrors `crates/moat-core/src/destination.rs`. The arena needs its
// own copy because the runner has to decide whether the attacker was paid
// without asking the thing under test, and a mock has to canonicalize what
// it was handed before it records it. Two implementations of one rule is a
// cost; a scorer that agrees with the gateway by construction would not be
// measuring anything.
//
// The rule, on every kind: two destinations are the same account exactly
// when their canonical forms are equal, and canonical means *re-derived
// from the identifier's own content*, never the text as written. An IBAN is
// compacted and uppercased once mod-97 accepts it. An Ethereum address is
// lowercased once its checksum accepts it. A Solana address is decoded to
// its 32 bytes and re-encoded. Everything else is trimmed text and compares
// as itself.
//
// What is deliberately absent is any notion of partial match. An address
// that shares its first four and last four characters with another is a
// different account, and on this rail that is not a technicality: it is the
// whole of address poisoning. See attacks/chain-address-poisoning.

import { keccak_256 } from "@noble/hashes/sha3.js";

/** What sort of identifier a destination is. */
export type DestinationKind = "iban" | "evm" | "sol" | "opaque";

export interface Destination {
  kind: DestinationKind;
  /** The comparable form. Never shown to anyone. */
  canonical: string;
  /** What the caller wrote, kept for the record. */
  display: string;
}

/** Kind-prefixed, so two kinds can never collide on one string. */
export function destinationKey(d: Destination): string {
  return `${d.kind}:${d.canonical}`;
}

/** Parse a destination, falling back to the trimmed text it arrived as. */
export function parseDestination(raw: string): Destination {
  const display = raw.trim();
  const iban = canonicalIban(display);
  if (iban) return { kind: "iban", canonical: iban, display };
  const evm = canonicalEvm(display);
  if (evm) return { kind: "evm", canonical: evm, display };
  const sol = canonicalSolana(display);
  if (sol) return { kind: "sol", canonical: sol, display };
  return { kind: "opaque", canonical: display, display };
}

/** True when both name the same account, however each is written. */
export function sameDestination(a: string, b: string): boolean {
  return destinationKey(parseDestination(a)) === destinationKey(parseDestination(b));
}

/** An IBAN, uppercased and compacted, if it passes its mod-97 check digits. */
export function canonicalIban(raw: string): string | undefined {
  const compact = raw.replace(/[\s-]/g, "").toUpperCase();
  if (compact.length < 15 || compact.length > 34) return undefined;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return undefined;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    remainder = value >= 10 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder === 1 ? compact : undefined;
}

/** An IBAN in the groups of four it is printed in. */
export function groupIban(compact: string): string {
  return (compact.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * A `0x` address in lowercase, if it is twenty hex bytes and its casing is
 * either uniform or a correct EIP-55 checksum.
 *
 * A mixed-case address whose checksum does not verify is rejected outright
 * rather than lowercased. That is the point of the checksum: it is a typo
 * or a forgery, and canonicalizing it would let it compare equal to the
 * real address it was mistyped from.
 */
export function canonicalEvm(raw: string): string | undefined {
  const s = raw.trim();
  if (!/^0[xX][0-9a-fA-F]{40}$/.test(s)) return undefined;
  const hex = s.slice(2);
  const lower = hex.toLowerCase();
  const hasUpper = /[A-F]/.test(hex);
  const hasLower = /[a-f]/.test(hex);
  if (hasUpper && hasLower && eip55(lower) !== hex) return undefined;
  return `0x${lower}`;
}

/** The EIP-55 mixed-case form of a lowercase hex address body. */
export function eip55(lower: string): string {
  const hash = Buffer.from(keccak_256(Buffer.from(lower, "ascii"))).toString("hex");
  let out = "";
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i] as string;
    const h = hash[i] as string;
    out += c >= "0" && c <= "9" ? c : h < "8" ? c : c.toUpperCase();
  }
  return out;
}

/** An address as a checksummed `0x` string, from any accepted spelling. */
export function checksumEvm(raw: string): string | undefined {
  const canonical = canonicalEvm(raw);
  return canonical === undefined ? undefined : `0x${eip55(canonical.slice(2))}`;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * A 32-byte base58 address, re-encoded from its own bytes.
 *
 * Re-encoding rather than trusting the text means anything that decodes to
 * the same key compares equal, and nothing that is not exactly 32 bytes is
 * treated as an address at all. Base58 is case-sensitive, which is why no
 * case folding happens anywhere on this path: two addresses differing only
 * in case are two different accounts.
 */
export function canonicalSolana(raw: string): string | undefined {
  const s = raw.trim();
  if (s.length < 32 || s.length > 44) return undefined;
  const bytes = base58Decode(s);
  if (bytes === undefined || bytes.length !== 32) return undefined;
  return base58Encode(bytes);
}

/** Base58 to bytes, or undefined if any character is outside the alphabet. */
export function base58Decode(s: string): Uint8Array | undefined {
  if (s === "") return undefined;
  let value = 0n;
  for (const ch of s) {
    const digit = B58.indexOf(ch);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  const body: number[] = [];
  while (value > 0n) {
    body.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // A leading '1' is a leading zero byte, and carries no magnitude to
  // recover from the integer.
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    leadingZeros++;
  }
  return Uint8Array.from([...new Array<number>(leadingZeros).fill(0), ...body]);
}

/** Bytes to base58. */
export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = (B58[Number(value % 58n)] as string) + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out === "" ? "1" : out;
}

/**
 * How an identifier is shown to a person: an IBAN in its printed groups, an
 * Ethereum address with its checksum casing, anything else as written.
 */
export function displayDestination(raw: string): string {
  const d = parseDestination(raw);
  if (d.kind === "iban") return groupIban(d.canonical);
  if (d.kind === "evm") return checksumEvm(d.canonical) ?? d.canonical;
  return d.canonical;
}
