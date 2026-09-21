"""What AP2's mandate constraints can and cannot decide.

AP2 secures an agent payment with mandates: an *open* mandate carrying the
constraints a user agreed to, and a *closed* mandate naming the specific
checkout. Verification checks that the checkout satisfies the constraints.

This asks three questions of AP2's own constraint evaluators, imported from
the SDK installed from google-agentic-commerce/AP2 and called unmodified.
Nothing here is reimplemented and nothing is stubbed.

The questions are chosen to separate two things that get conflated:

  1. can it catch a merchant whose *name* is wrong
  2. can it catch a payment that is wrong while every named thing is right
  3. does it care where the constraint itself came from

Run:  .venv/Scripts/python.exe src/ap2_probe.py
"""

from __future__ import annotations

import json
import sys

# The homoglyph is Cyrillic, and a Windows console defaults to cp1252.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from ap2.sdk.constraints import (
    AllowedMerchants,
    check_checkout_constraints,
)
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
from ap2.sdk.generated.types.checkout import Checkout

# The supplier the user actually named, and the two ways an attack dresses up.
REAL = Merchant(id="aseer-cloud-co", name="Aseer Cloud Co", website="https://aseer-cloud.example")
# Cyrillic А and С. Identical on screen, different bytes, different id.
HOMOGLYPH = Merchant(
    id="аseer-cloud-co", name="Аseer Сloud Co", website="https://aseer-cloud.example"
)
ATTACKER = Merchant(id="qassim-trading-est", name="Qassim Trading Est", website="https://qassim.example")


def checkout(merchant: Merchant, minor_units: int) -> Checkout:
    """A minimal checkout: who is paid, and how much. Amounts are minor units."""
    return Checkout.model_validate(
        {
            "id": "INV-4471",
            "merchant": merchant.model_dump(),
            "line_items": [
                {
                    "id": "1",
                    "item": {
                        "id": "monitoring-team",
                        "title": "Team monitoring, 25 hosts, 12 months",
                        "price": minor_units,
                    },
                    "quantity": 1,
                    "totals": [{"type": "total", "amount": minor_units}],
                }
            ],
            "status": "incomplete",
            "currency": "USD",
            "totals": [{"type": "total", "amount": minor_units}],
            "links": [],
        }
    )


def mandate_allowing(*merchants: Merchant) -> OpenCheckoutMandate:
    """An open mandate whose only constraint is who may be paid."""
    return OpenCheckoutMandate(
        constraints=[AllowedMerchants(allowed=list(merchants))],
        cnf={"jwk": {"kty": "EC", "crv": "P-256", "x": "test", "y": "test"}},
    )


def ask(label: str, mandate: OpenCheckoutMandate, co: Checkout) -> list[str]:
    """Put a checkout to AP2's own constraint checker."""
    violations = check_checkout_constraints(mandate, co)
    verdict = "VIOLATION" if violations else "verifies"
    print(f"  {label}")
    print(f"    AP2 says   {verdict}")
    for v in violations:
        print(f"    because    {v}")
    return violations


def rule(char: str = "-") -> None:
    print(char * 74)


def main() -> int:
    print()
    print("AP2: what the mandate constraints can decide")
    rule("=")
    print("SDK  google-agentic-commerce/AP2, constraint evaluators called unmodified")
    print(f"user approved   {REAL.name}  (id {REAL.id})")
    print()

    print("1. the merchant name is wrong, and the mandate came from the user")
    print("   the user's own words built the allowlist; the invoice is a homoglyph")
    caught = ask("homoglyph merchant vs a user-authored allowlist", mandate_allowing(REAL), checkout(HOMOGLYPH, 48000))
    print()

    print("2. every named thing is right, and the price is not")
    print("   the merchant is the real one; the invoice says 499 where the user said 480")
    missed_amount = ask(
        "right merchant, inflated amount", mandate_allowing(REAL), checkout(REAL, 49900)
    )
    print()

    print("3. the constraint itself was written from the page the agent read")
    print("   the agent built the mandate from the poisoned invoice, then honoured it")
    missed_provenance = ask(
        "attacker allowlisted by a mandate the agent authored",
        mandate_allowing(ATTACKER),
        checkout(ATTACKER, 48000),
    )
    print()

    rule()
    print("READING")
    print()
    if caught:
        print("  AP2 catches the homoglyph. merchant_matches compares id, or name and")
        print("  website, exactly, so a lookalike name is a different merchant. Credit")
        print("  where it is due: this is a real check and it works.")
    else:
        print("  AP2 did not catch the homoglyph. Check this harness before believing it.")
    print()
    if not missed_amount:
        print("  It does not catch the inflated price, because an allowlist is about")
        print("  who, not how much. AP2 can carry an amount range, but only somebody")
        print("  who independently knows the right price can set it.")
    print()
    if not missed_provenance:
        print("  And it verifies a mandate whose allowlist names the attacker, because")
        print("  the chain checks that the checkout matches the constraints, not where")
        print("  the constraints came from. The agent wrote them, from the page.")
    print()
    print("  That is the shape of the allowlist arm in our own table: it catches a")
    print("  wrong name and it does not catch a right name doing the wrong thing.")
    print("  AP2 is not doing this badly. Provenance is outside what it is for.")
    rule()
    print()

    # Fail loudly if AP2 stopped behaving as its own source says it does.
    if not caught:
        print("HARNESS  case 1 should have produced a violation; do not publish this run.")
        return 1
    if missed_amount or missed_provenance:
        print("HARNESS  case 2 or 3 produced a violation; AP2 may have gained a check.")
        return 1
    print(json.dumps({"homoglyph_caught": True, "inflated_amount_caught": False, "page_authored_mandate_caught": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
