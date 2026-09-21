// Does x402 have any way to notice that the money is going to the wrong
// place?
//
// x402 is a payment protocol for agents: a server answers 402 with
// PaymentRequirements, the client signs a PaymentPayload, and a facilitator
// verifies it before the resource is served. The question this asks is
// narrow and answerable: given two payloads identical in every respect
// except the destination, can the facilitator tell them apart?
//
// Everything here is the real thing. @x402/core and @x402/evm at the
// versions in package.json, their own x402Client to build the payload,
// their own ExactEvmScheme to verify it, and viem doing the actual EIP-712
// signing and signature recovery. The scheme's verify() is called
// unmodified.
//
// The one thing that is not real is the chain. verify() reads the payer's
// USDC balance and the EIP-3009 authorization state, and a test key on a
// public testnet has neither. Those two reads are answered by a stub that
// says "funded, unused", and the stub records every call it receives so
// the run can print exactly what the verifier asked the chain about. That
// substitution is deliberate and it is the fair one: the claim under test
// is about the destination, so the funding question has to be removed as a
// confound rather than left to fail first and hide the answer.
//
// Run:  pnpm --filter @moat/interop x402

import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme as registerClient } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerFacilitator } from "@x402/evm/exact/facilitator";
import { verifyTypedData } from "viem";
import { askMoat } from "./moat-evm.js";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const NETWORK = "eip155:84532";
/** Circle's USDC on Base Sepolia. Nothing is ever sent to it here. */
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const AMOUNT = "480000"; // 0.48 USDC in atomic units, 6 decimals

/** A throwaway key. It signs, and it holds nothing, anywhere. */
const PAYER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/**
 * The two destinations. One is the address the user approved; the other is
 * the one an attacker would put in front of the agent. Same shape, same
 * chain, same asset, same amount.
 */
const APPROVED = "0x8F3A9c21D5e74B0aC6fE18b2D7c4E90a1B3f52D7";
const ATTACKER = "0x8F3A44b1907cC2e5d8Ba0173Ee69fD31c0aa52D7";

/** Every chain read the verifier performs, so the run can show its work. */
const chainReads: string[] = [];

/**
 * The facilitator's view of the chain.
 *
 * verifyTypedData is real: it is viem's, offline, and it will reject a
 * forged signature. getCode and readContract are the stub described above.
 */
function stubbedChain() {
  return {
    address: "0x0000000000000000000000000000000000000001" as `0x${string}`,
    getCode: async (args: { address: `0x${string}` }) => {
      const what = args.address.toLowerCase() === USDC.toLowerCase() ? "the USDC contract" : "the payer";
      chainReads.push(`getCode(${args.address})  <- ${what}`);
      // The token is a deployed contract; the payer is a plain account.
      return args.address.toLowerCase() === USDC.toLowerCase()
        ? ("0x60806040523480156100" as `0x${string}`)
        : undefined;
    },
    readContract: async (args: { address: `0x${string}`; functionName: string; args?: readonly unknown[] }) => {
      chainReads.push(`${args.functionName}(${(args.args ?? []).join(", ")}) on ${args.address}`);
      // balanceOf: funded. authorizationState: this nonce is unused.
      if (args.functionName === "balanceOf") return 1_000_000_000n;
      if (args.functionName === "authorizationState") return false;
      if (args.functionName === "nonces") return 0n;
      if (args.functionName === "allowance") return 1_000_000_000n;
      return 0n;
    },
    verifyTypedData: async (args: Record<string, unknown>) => {
      chainReads.push("verifyTypedData(...)  <- real, viem, offline");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return verifyTypedData(args as any);
    },
    writeContract: async () => {
      throw new Error("settle is never called here; nothing is broadcast");
    },
    sendTransaction: async () => {
      throw new Error("settle is never called here; nothing is broadcast");
    },
    waitForTransactionReceipt: async () => {
      throw new Error("settle is never called here; nothing is broadcast");
    },
  };
}

function requirementsFor(payTo: string): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: AMOUNT,
    asset: USDC,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  } as unknown as PaymentRequirements;
}

/** What the resource server answers 402 with. payTo is decided here. */
function paymentRequiredFor(payTo: string) {
  return {
    x402Version: 2,
    resource: {
      url: "https://aseer-cloud.example/invoice/INV-4471",
      description: "Aseer Cloud Co invoice INV-4471",
      mimeType: "application/json",
    },
    accepts: [requirementsFor(payTo)],
  };
}

async function verifyAgainst(payTo: string, label: string) {
  chainReads.length = 0;

  // The client builds and signs the payload with x402's own code.
  const client = new x402Client();
  registerClient(client, { signer: PAYER });
  const requirements = requirementsFor(payTo);
  const payload = await client.createPaymentPayload(paymentRequiredFor(payTo) as never);

  // The facilitator verifies it with x402's own code.
  const facilitator = new x402Facilitator();
  registerFacilitator(facilitator, { signer: stubbedChain() as never, networks: NETWORK as never });
  const result = await facilitator.verify(payload, requirements);

  const to = (payload as { payload?: { authorization?: { to?: string } } })?.payload?.authorization?.to;
  return { label, payTo, signedTo: to, result, reads: [...chainReads] };
}

const line = (s = "") => process.stdout.write(s + "\n");

async function main() {
  line();
  line("x402: can the facilitator tell an approved destination from an attacker's?");
  line("=".repeat(74));
  line(`network   ${NETWORK} (Base Sepolia)`);
  line(`asset     ${USDC} (USDC)`);
  line(`amount    ${AMOUNT} atomic units`);
  line(`payer     ${PAYER.address}`);
  line();

  const approved = await verifyAgainst(APPROVED, "the address the user approved");
  const attacker = await verifyAgainst(ATTACKER, "an address the user never named");

  for (const r of [approved, attacker]) {
    line(`${r.label}`);
    line(`  payTo          ${r.payTo}`);
    line(`  signed to      ${r.signedTo ?? "(not exposed)"}`);
    line(`  isValid        ${JSON.stringify((r.result as { isValid?: boolean }).isValid)}`);
    line(`  invalidReason  ${JSON.stringify((r.result as { invalidReason?: string }).invalidReason ?? null)}`);
    line();
  }

  line("what the verifier asked the chain about, in order:");
  for (const q of approved.reads) line(`  ${q}`);
  line();

  const a = (approved.result as { isValid?: boolean }).isValid;
  const b = (attacker.result as { isValid?: boolean }).isValid;

  line("-".repeat(74));
  if (a === true && b === true) {
    line("RESULT  Both verify. The facilitator cannot distinguish them, because");
    line("        nothing in the protocol carries what the user asked for. payTo");
    line("        comes from the resource server, and the only recipient check in");
    line("        the spec is that the payload's destination matches the one that");
    line("        same server asked for.");
  } else if (a === b) {
    line(`RESULT  Both returned isValid=${JSON.stringify(a)} for the same reason, so the`);
    line("        destination made no difference to the verdict either way.");
  } else {
    line("RESULT  The two differ. Read the reasons above before believing this test:");
    line("        x402 may have gained a check, or this harness is wrong.");
  }
  line("-".repeat(74));
  line();
  line("The same two destinations, put to Moat. Real gateway binary, real");
  line("policy, real intent and authorization; only the address differs.");
  line();
  const moat = await askMoat(APPROVED, ATTACKER);
  for (const [which, address] of [["approved", APPROVED], ["attacker", ATTACKER]] as const) {
    const v = moat[which];
    line(`  ${address}`);
    line(`    decision  ${v.decision}`);
    for (const r of v.reasons) line(`    because   ${r.id}: ${r.message}`);
    if (v.receipt) line(`    receipt   ${v.receipt}`);
  }
  line();
  if (moat.approved.decision !== "allow" || moat.attacker.decision !== "deny") {
    line("UNEXPECTED  Moat did not behave as the corpus says. Do not publish this run.");
    process.exitCode = 1;
  }
  line();
  line("Run it yourself against the live sandbox:");
  line("  https://interpreted-dir-ones-italiano.trycloudflare.com  (On chain rail)");
  line();

  // The harness fails loudly if x402 stopped behaving as the spec describes.
  if (a !== b) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\nthe harness itself failed, which is not a result:\n", e);
  process.exitCode = 2;
});
