// The card mock records to the same ledger every other rail's mock uses, so
// the runner scores a card payment and a bank transfer with one reader.
// Re-exported here because callers -- the runner's tests among them -- have
// always imported the ledger from the mock that writes it.

export {
  Ledger,
  toMinor,
  type LedgerEntry,
  type LedgerRail,
  type LedgerSettlement,
  type LedgerStatus,
  type NewLedgerEntry,
} from "@moat/mock-ledger";
