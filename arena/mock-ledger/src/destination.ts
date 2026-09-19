// Comparing destinations, the same way the gateway does.
//
// This mirrors `crates/moat-core/src/destination.rs`. The arena needs its
// own copy because the runner has to decide whether the attacker was paid
// without asking the thing under test, and a mock has to canonicalize what
// it was handed before it records it. Two implementations of one rule is a
// cost; a scorer that agrees with the gateway by construction would not be
// measuring anything.
//
// Only the kinds a rail in the arena uses are here. A chain rail adds its
// own when there is one to add.

/** What sort of identifier a destination is. */
export type DestinationKind = "iban" | "opaque";

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
