import { createHash } from "node:crypto";

export type RecipientRole = "authorized" | "unauthorized";

export interface Recipient {
  role: RecipientRole;
  /** The account's label: the first of its names. */
  payee: string;
  /** Every supplier name this account answers to. */
  names: string[];
  secretKey: string;
}

export interface AccountSummary {
  id: string;
  role: RecipientRole;
  payee: string;
  country: string | null;
  charges_enabled: boolean;
}

export interface PaymentSummary {
  id: string;
  account: string;
  role: RecipientRole;
  payee: string;
  amount: number;
  currency: string;
  status: string;
  created: string;
  authorization_id: string;
  invoice_id: string;
  invoice_fingerprint: string;
}

interface StripeAccount {
  id: string;
  country?: string;
  charges_enabled?: boolean;
}

interface StripePaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  created: number;
  metadata?: Record<string, string>;
}

interface StripeList<T> {
  data: T[];
}

interface StripeErrorEnvelope {
  error?: { message?: string; type?: string; code?: string };
}

const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The names an account answers to: `STRIPE_AUTHORIZED_PAYEE="Monitoring Pro Inc|Al Noor Supplies"`.
 *  The first is the account's label; each is a separate supplier as far as a
 *  payment is concerned. */
function names(value: string | undefined, fallback: string): string[] {
  const list = (value ?? "")
    .split("|")
    .map((name) => name.trim())
    .filter(Boolean);
  return list.length ? list : [fallback];
}

export function recipientsFromEnv(env: NodeJS.ProcessEnv = process.env): Recipient[] {
  const authorized = names(env["STRIPE_AUTHORIZED_PAYEE"], "Monitoring Pro Inc");
  const unauthorized = names(env["STRIPE_UNAUTHORIZED_PAYEE"], "ProMon Billing Ltd");
  const recipients: Recipient[] = [
    {
      role: "authorized",
      payee: authorized[0]!,
      names: authorized,
      secretKey: required(env, "STRIPE_AUTHORIZED_SECRET_KEY"),
    },
    {
      role: "unauthorized",
      payee: unauthorized[0]!,
      names: unauthorized,
      secretKey: required(env, "STRIPE_UNAUTHORIZED_SECRET_KEY"),
    },
  ];
  const seen = new Set<string>();
  for (const name of [...authorized, ...unauthorized]) {
    const key = normalise(name);
    if (seen.has(key)) throw new Error(`payee ${JSON.stringify(name)} is listed for more than one account`);
    seen.add(key);
  }
  return recipients;
}

export function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function recipientFor(payee: string, recipients: Recipient[]): Recipient {
  const wanted = normalise(payee);
  const recipient = recipients.find((candidate) => candidate.names.some((name) => normalise(name) === wanted));
  if (!recipient) {
    const known = recipients.flatMap((r) => r.names).join(", ");
    throw new Error(`unknown sandbox payee ${JSON.stringify(payee)}; use one of: ${known}`);
  }
  return recipient;
}

export function majorToMinor(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new Error("currency must be a three-letter ISO code");
  const factor = ZERO_DECIMAL.has(code) ? 1 : 100;
  const minor = Math.round(amount * factor);
  if (Math.abs(minor / factor - amount) > 1e-9) {
    throw new Error(`${code} amount has more decimal places than Stripe accepts`);
  }
  return minor;
}

async function stripeRequest<T>(
  recipient: Recipient,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    ...init,
    headers: {
      authorization: `Basic ${Buffer.from(`${recipient.secretKey}:`).toString("base64")}`,
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & StripeErrorEnvelope;
  if (!response.ok) {
    const detail = body.error?.message ?? body.error?.code ?? `HTTP ${response.status}`;
    throw new Error(`Stripe ${recipient.role} account rejected the request: ${detail}`);
  }
  return body;
}

export async function inspectAccount(recipient: Recipient): Promise<AccountSummary> {
  const account = await stripeRequest<StripeAccount>(recipient, "/v1/account");
  return {
    id: account.id,
    role: recipient.role,
    payee: recipient.payee,
    country: account.country ?? null,
    charges_enabled: account.charges_enabled ?? false,
  };
}

function paymentSummary(intent: StripePaymentIntent, recipient: Recipient): PaymentSummary {
  return {
    id: intent.id,
    account: intent.metadata?.["moat_account"] ?? "",
    role: recipient.role,
    payee: intent.metadata?.["moat_payee"] ?? recipient.payee,
    amount: intent.amount,
    currency: intent.currency.toUpperCase(),
    status: intent.status,
    created: new Date(intent.created * 1000).toISOString(),
    authorization_id: intent.metadata?.["moat_authorization_id"] ?? "",
    invoice_id: intent.metadata?.["moat_invoice_id"] ?? "",
    invoice_fingerprint: intent.metadata?.["moat_invoice_fingerprint"] ?? "",
  };
}

export async function createPayment(
  recipient: Recipient,
  amount: number,
  currency: string,
  authorizationId: string,
  invoiceId: string,
  binding: { recipientAccountId?: string; invoiceFingerprint?: string; payee?: string } = {},
): Promise<PaymentSummary> {
  if (!authorizationId.trim()) throw new Error("authorization_id is required");
  if (!invoiceId.trim()) throw new Error("invoice_id is required");
  const account = await inspectAccount(recipient);
  if (binding.recipientAccountId && binding.recipientAccountId !== account.id) {
    throw new Error("recipient_account_id does not match the configured Stripe account");
  }
  // The payment is recorded under the supplier name the caller used, which
  // is one of the account's names, not always its label.
  const payee = binding.payee?.trim() || recipient.payee;
  const params = new URLSearchParams();
  params.set("amount", String(majorToMinor(amount, currency)));
  params.set("currency", currency.toLowerCase());
  params.set("payment_method", "pm_card_visa");
  params.set("payment_method_types[]", "card");
  params.set("confirm", "true");
  params.set("description", `Moat sandbox payment to ${payee}`);
  params.set("metadata[moat_test]", "true");
  params.set("metadata[moat_payee]", payee);
  params.set("metadata[moat_recipient_role]", recipient.role);
  params.set("metadata[moat_account]", account.id);
  params.set("metadata[moat_authorization_id]", authorizationId);
  params.set("metadata[moat_invoice_id]", invoiceId);
  if (binding.invoiceFingerprint) {
    params.set("metadata[moat_invoice_fingerprint]", binding.invoiceFingerprint.toLowerCase());
  }
  const idempotencyKey = `moat-${createHash("sha256")
    .update(`${account.id}\u0000${authorizationId}\u0000${invoiceId}`)
    .digest("hex")}`;
  const intent = await stripeRequest<StripePaymentIntent>(recipient, "/v1/payment_intents", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey,
    },
    body: params,
  });
  return paymentSummary(intent, recipient);
}

export async function listPayments(
  recipient: Recipient,
  limit = 25,
): Promise<PaymentSummary[]> {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const result = await stripeRequest<StripeList<StripePaymentIntent>>(
    recipient,
    `/v1/payment_intents?limit=${bounded}`,
  );
  return result.data
    .filter((intent) => intent.metadata?.["moat_test"] === "true")
    .map((intent) => paymentSummary(intent, recipient));
}
