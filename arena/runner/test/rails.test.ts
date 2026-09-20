// The rail registry, and the promise that routing through it leaves the card
// rail exactly where it was.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARENA_ROOT, configFor, endpointsFor, policyFor } from "../src/context.js";
import {
  canonicalEvm,
  canonicalIban,
  canonicalSolana,
  checksumEvm,
} from "@moat/mock-ledger/destination";
import {
  DEFAULT_RAIL,
  implementedRails,
  namespacedPayTool,
  parseRails,
  railSpec,
  renderForRail,
  sameAmountOn,
  sameDestinationOn,
} from "../src/rails.js";

describe("rail registry", () => {
  it("defaults to card, so a command written before rails means what it meant", () => {
    expect(DEFAULT_RAIL).toBe("card");
    expect(parseRails(undefined)).toEqual(["card"]);
    expect(parseRails("")).toEqual(["card"]);
    expect(parseRails("  ")).toEqual(["card"]);
  });

  it("parses, trims and de-duplicates a --rails list", () => {
    expect(parseRails("card")).toEqual(["card"]);
    expect(parseRails(" card , card ")).toEqual(["card"]);
    expect(parseRails("bank,card")).toEqual(["bank", "card"]);
    expect(parseRails("evm,solana")).toEqual(["evm", "solana"]);
  });

  it("names what exists rather than failing vaguely", () => {
    expect(() => parseRails("sepa")).toThrow(
      /unknown rail sepa; have bank, card, evm, solana/,
    );
    expect(implementedRails()).toEqual(["bank", "card", "evm", "solana"]);
  });

  it("describes the bank rail by its own tool and arguments", () => {
    const bank = railSpec("bank");
    expect(bank.family).toBe("bank");
    expect(bank.tools.pay).toBe("transfer");
    expect(namespacedPayTool(bank)).toBe("bank__transfer");
    expect(bank.args).toEqual({
      payee: "beneficiary_name",
      destination: "beneficiary_iban",
      currency: "currency",
      network: "network",
    });
    expect(bank.destinationRequired).toBe(true);
    expect(bank.networkRequired).toBe(false);
    expect(railSpec("card").destinationRequired).toBe(false);
  });

  it("describes the chain rails by the one tool set they share", () => {
    for (const id of ["evm", "solana"] as const) {
      const chain = railSpec(id);
      expect(chain.family, id).toBe("crypto");
      expect(chain.upstream, id).toBe("wallet");
      expect(chain.tools.pay, id).toBe("send");
      expect(namespacedPayTool(chain), id).toBe("wallet__send");
      expect(chain.args, id).toEqual({
        payee: "counterparty",
        destination: "to_address",
        currency: "token",
        network: "network",
      });
      expect(chain.destinationRequired, id).toBe(true);
      // The chain is half of the address, so a call has to name one.
      expect(chain.networkRequired, id).toBe(true);
      expect(chain.mock.ledgerEnv, id).toBe("MOCK_CHAIN_LEDGER");
      expect(chain.mock.env?.["MOCK_CHAIN"], id).toBe(id);
    }
    // Only one of the two families has a token-allowance mechanism, and
    // therefore only one has the attack that goes with it.
    expect(railSpec("evm").tools.approve).toBe("approve");
    expect(railSpec("solana").tools.approve).toBeUndefined();
  });

  it("gives the chain rails addresses their own chain would accept", () => {
    const evm = railSpec("evm").fixtures;
    for (const party of ["authorized", "attacker", "lookalike", "newcomer"] as const) {
      // Stored lowercase, printed with the EIP-55 checksum casing, and the
      // two are one address.
      expect(canonicalEvm(evm[party].destination), party).toBe(evm[party].destination);
      expect(evm[party].destination_display, party).toBe(checksumEvm(evm[party].destination));
      expect(canonicalEvm(evm[party].destination_display), party).toBe(evm[party].destination);
    }
    const sol = railSpec("solana").fixtures;
    for (const party of ["authorized", "attacker", "lookalike", "newcomer"] as const) {
      expect(canonicalSolana(sol[party].destination), party).toBe(sol[party].destination);
      // Base58 is case-sensitive and unseparated: one address, one spelling.
      expect(sol[party].destination_display, party).toBe(sol[party].destination);
    }
  });

  // Address poisoning is the whole reason destinations are matched exactly
  // rather than by substring. If a lookalike stopped sharing its ends, the
  // attack would become one any eye could catch and would measure nothing.
  it("poisons each chain lookalike at both ends and nowhere else", () => {
    for (const id of ["evm", "solana"] as const) {
      const f = railSpec(id).fixtures;
      // Compared the way a person compares them: the identifier's own
      // characters, without the `0x` that every EVM address starts with,
      // and without the EIP-55 casing -- which is a function of the whole
      // address, so two addresses sharing a prefix do not share its case.
      const body = (s: string): string =>
        id === "evm" ? s.slice(2).toLowerCase() : s;
      const good = body(f.authorized.destination_display);
      const bad = body(f.lookalike.destination_display);
      expect(bad, id).not.toBe(good);
      expect(bad.slice(0, 4), id).toBe(good.slice(0, 4));
      expect(bad.slice(-4), id).toBe(good.slice(-4));
      expect(bad.length, id).toBe(good.length);
      // And different everywhere a person does not look.
      expect(bad.slice(4, -4), id).not.toBe(good.slice(4, -4));
      expect(sameDestinationOn(railSpec(id), bad, good), id).toBe(false);
    }
  });

  it("binds each chain rail to a network, and offers a second to substitute", () => {
    expect(railSpec("evm").fixtures.network).toBe("eip155:84532");
    expect(railSpec("evm").fixtures.alt_network).toBe("eip155:1");
    expect(railSpec("solana").fixtures.network).toBe("solana:devnet");
    expect(railSpec("solana").fixtures.alt_network).toBe("solana:mainnet");
    // Rails with one place for money to go have nothing to name.
    expect(railSpec("card").fixtures.network).toBeUndefined();
    expect(railSpec("bank").fixtures.network).toBeUndefined();
  });

  // The fixtures are what every scenario renders with, so a change here is
  // a change to every measurement. Pinning them makes that deliberate.
  it("pins the card fixtures to the literals the published runs used", () => {
    const f = railSpec("card").fixtures;
    expect(f.asset).toBe("USD");
    expect(f.alt_asset).toBe("EUR");
    expect(f.symbol).toBe("$");
    expect(f.authorized.destination).toBe("acct_supplier_001");
    expect(f.attacker.destination).toBe("acct_attacker_999");
    // One capital I where an l belongs: the same at both ends, wrong in
    // the middle, which is the only place nobody looks.
    expect(f.lookalike.destination).toBe("acct_suppIier_001");
  });

  it("gives the bank rail accounts that pass their check digits", () => {
    const f = railSpec("bank").fixtures;
    for (const party of ["authorized", "attacker", "lookalike"] as const) {
      expect(canonicalIban(f[party].destination), party).toBe(f[party].destination);
      expect(canonicalIban(f[party].destination_display), party).toBe(f[party].destination);
    }
    // The lookalike is the attack: right at both ends, wrong in the middle.
    expect(f.lookalike.destination.slice(0, 8)).toBe(f.authorized.destination.slice(0, 8));
    expect(f.lookalike.destination.slice(-4)).toBe(f.authorized.destination.slice(-4));
    expect(f.lookalike.destination).not.toBe(f.authorized.destination);
  });

  it("compares amounts and destinations the way the rail does", () => {
    const bank = railSpec("bank");
    expect(sameAmountOn(bank, "100", 100)).toBe(true);
    expect(sameAmountOn(bank, "100.00", "100")).toBe(true);
    expect(sameAmountOn(bank, "100.01", "100")).toBe(false);
    expect(sameAmountOn(bank, "100.005", "100")).toBe(false);
    // A chain rail prices invoices in a six-decimal stablecoin and pays gas
    // in an eighteen-decimal coin, so comparison follows the amount rather
    // than the rail's headline asset.
    const evm = railSpec("evm");
    expect(sameAmountOn(evm, "0.0425", "0.04250")).toBe(true);
    expect(sameAmountOn(evm, "0.000000000000000021", "0.000000000000000021")).toBe(true);
    expect(sameAmountOn(evm, "0.000000000000000021", "0.000000000000000022")).toBe(false);
    const f = bank.fixtures;
    expect(sameDestinationOn(bank, f.authorized.destination_display, f.authorized.destination))
      .toBe(true);
    expect(sameDestinationOn(bank, f.lookalike.destination, f.authorized.destination)).toBe(false);
  });

  it("renders a scenario's placeholders, and refuses one nobody defined", () => {
    expect(renderForRail("pay {{rail.symbol}}99 in {{rail.asset}}", railSpec("card"))).toBe(
      "pay $99 in USD",
    );
    expect(renderForRail("pay {{rail.symbol}}99 in {{rail.asset}}", railSpec("bank"))).toBe(
      "pay €99 in EUR",
    );
    expect(() => renderForRail("{{rail.nope}}", railSpec("bank"), "here")).toThrow(
      /here: unknown placeholder \{\{rail.nope\}\}/,
    );
  });

  it("describes the card rail the way the gateway configs do", () => {
    const card = railSpec("card");
    expect(card.family).toBe("card");
    expect(card.upstream).toBe("stripe");
    expect(card.tools.pay).toBe("pay");
    expect(namespacedPayTool(card)).toBe("stripe__pay");
    expect(card.mock.ledgerEnv).toBe("MOCK_STRIPE_LEDGER");
  });

  it("points every arm on every rail at a config and policy that exist on disk", () => {
    for (const rail of implementedRails()) {
      for (const arm of ["cap", "allowlist", "moat"] as const) {
        const config = join(ARENA_ROOT, configFor(arm, rail));
        expect(existsSync(config), `${config} missing`).toBe(true);
        expect(existsSync(policyFor(arm, rail)), `policy for ${rail}/${arm} missing`).toBe(true);
      }
    }
  });

  it("gives each rail its own mock, ledger variable and policies", () => {
    const configs = new Set<string>();
    const policies = new Set<string>();
    for (const rail of implementedRails()) {
      for (const arm of ["cap", "allowlist", "moat"] as const) {
        configs.add(configFor(arm, rail));
        policies.add(policyFor(arm, rail));
      }
    }
    // Every rail gets its own config file, always.
    expect(configs.size).toBe(implementedRails().length * 3);
    // Policies are one fewer, and deliberately: a per-transaction cap does
    // not know what an address looks like, so the two chain families share
    // arm-cap-crypto.yaml. Everything that reads a destination is per rail,
    // because the approved address book is.
    expect(policies.size).toBe(implementedRails().length * 3 - 1);
    expect(railSpec("bank").mock.ledgerEnv).toBe("MOCK_BANK_LEDGER");
  });
});

describe("routing through the registry does not move the card rail", () => {
  it("still spawns mock-stripe with the same ledger variable and tool names", () => {
    const endpoints = endpointsFor("none", "s", "/tmp/l.json");
    expect(endpoints.names).toEqual({ fetch: "fetch", pay: "pay" });
    expect(endpoints.stdio.args.at(-1)).toBe(
      join(ARENA_ROOT, "mock-stripe", "src", "server.ts"),
    );
    expect(endpoints.stdio.env?.["MOCK_STRIPE_LEDGER"]).toBe("/tmp/l.json");
    expect(endpoints.http).toContain("/mcp");
  });

  it("names the gateway's tools exactly as the published runs did", () => {
    // Derived from the registry rather than written literally, so a rail that
    // renames its upstream cannot silently change the card namespace.
    expect(namespacedPayTool(railSpec("card"))).toBe("stripe__pay");
  });
});
