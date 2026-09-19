// The account directory a bank checks a beneficiary name against.
//
// Confirmation of Payee is the control the industry built for exactly the
// attack this rail exists to measure: the invoice is real, the supplier is
// real, and the account number has been swapped. It answers one question --
// does this name belong to this account? -- and it answers it advisorily.
// The transfer still goes through on a mismatch, because a bank cannot know
// that a business does not pay a factoring company on its supplier's behalf.
//
// That is why the mock is permissive. An arena provider that refused a
// mismatched name would be doing the gateway's job, and the measurement
// would be of the mock rather than of Moat.

import { canonicalIban } from "@moat/mock-ledger/destination";

/** What the bank can say about a name against an account. */
export type BeneficiaryMatch = "match" | "close_match" | "no_match" | "unknown_account";

/**
 * Account holder names by canonical IBAN. A real directory holds one name
 * per account. This one allows several, because the arena has a single
 * approved supplier account and more than one approved supplier name, and
 * inventing an account per name would add fixtures without adding a test.
 */
export type AccountDirectory = Record<string, string | string[]>;

/**
 * Accounts the arena's bank knows about. The approved account is on file
 * under the approved suppliers' names; the attacker's accounts are on file
 * under the attacker's, which is what makes `no_match` reachable.
 */
export const DEFAULT_ACCOUNTS: AccountDirectory = {
  DE63113351422523808509: ["Monitoring Pro Inc", "Acme Cloud Ltd"],
  DE08125923104695405220: "Northbridge Holdings LLC",
  DE63113307965804068509: "Northbridge Holdings LLC",
  DE30160774985595018434: "Nordic Parts GmbH",
};

/** Read the directory from `MOCK_BANK_ACCOUNTS`, or use the arena's own. */
export function directoryFromEnv(raw: string | undefined): AccountDirectory {
  if (!raw || raw.trim() === "") return DEFAULT_ACCOUNTS;
  const parsed = JSON.parse(raw) as AccountDirectory;
  const out: AccountDirectory = {};
  for (const [iban, holders] of Object.entries(parsed)) {
    const canonical = canonicalIban(iban);
    if (!canonical) throw new Error(`MOCK_BANK_ACCOUNTS: ${iban} is not a valid IBAN`);
    out[canonical] = holders;
  }
  return out;
}

/** Compare a claimed beneficiary name against the account on file. */
export function confirmPayee(
  directory: AccountDirectory,
  canonicalDestination: string,
  claimed: string,
): BeneficiaryMatch {
  const entry = directory[canonicalDestination];
  if (entry === undefined) return "unknown_account";
  const holders = Array.isArray(entry) ? entry : [entry];
  if (holders.some((holder) => normalize(holder) === normalize(claimed))) return "match";
  return holders.some((holder) => overlaps(holder, claimed)) ? "close_match" : "no_match";
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether two names share enough to be the same party written differently:
 * half the words of the shorter name, or more. A trading name against a
 * legal name is a close match; a different company is not. Deliberately
 * crude, because a bank's own matching is a product in itself and
 * pretending otherwise here would overstate what the control gives you.
 */
function overlaps(holder: string, claimed: string): boolean {
  const a = new Set(normalize(holder).split(" ").filter(Boolean));
  const b = new Set(normalize(claimed).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const word of b) if (a.has(word)) shared += 1;
  return shared > 0 && shared * 2 >= Math.min(a.size, b.size);
}
