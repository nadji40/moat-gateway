"""Measure the deployed /v1/read path without registering intents or payments.

python3 evaluate_live.py --url http://127.0.0.1:7083 --output live-results.json
"""

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
from pathlib import Path
import statistics
import time
import urllib.request


def number(value):
    return Decimal(value) if value is not None else None


def summarize(rows):
    return {
        "messages": len(rows),
        "correct": {key: sum(r["scores"][key] for r in rows) for key in rows[0]["scores"]},
        "complete": sum(all(r["scores"].values()) for r in rows),
        "unasked_payee_cases": sum(bool(r["unasked_payees"]) for r in rows),
        "median_s": statistics.median(r["seconds"] for r in rows),
        "p95_s": sorted(r["seconds"] for r in rows)[int(len(rows) * 0.95)],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:7083")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    fixtures = Path(__file__).resolve().parents[2] / "crates/moat-intent/tests"
    original = json.loads((fixtures / "corpus.json").read_text(encoding="utf-8"))
    additional = json.loads((fixtures / "additional-corpus.json").read_text(encoding="utf-8"))
    rows = []
    for case in original + additional:
        started = time.monotonic()
        request = urllib.request.Request(
            args.url.rstrip("/") + "/v1/read",
            data=json.dumps({"text": case["text"]}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=65) as response:
            reading = json.load(response)
        elapsed = time.monotonic() - started
        fields = reading["fields"]
        wanted = [case["pay"]] if case["pay"] else []
        expected_amount = (
            [number(case.get("canonical_amount", case["amount"]))]
            if wanted and case["amount"] else []
        )
        currencies = fields.get("currencies", [])
        # Exact name/reference sets deliberately expose extra names, trailing
        # punctuation, and payment descriptions mistaken for identifiers.
        scores = {
            "available": reading["status"] == "read",
            "pay": set(fields.get("pay", [])) == set(wanted),
            "refused": set(fields.get("refused", [])) == set(case["refused"]),
            "amount": [number(a) for a in fields.get("amounts", [])] == expected_amount,
            "currency": not wanted or (len(currencies) == 1 and currencies[0] in case["currencies"]),
            "references": set(fields.get("references", [])) == set(case["references"]),
            "cancel": fields.get("cancels_previous", False) == case["cancels"],
            "destinations": fields.get("destinations", []) == [],
        }
        rows.append({
            "id": case["id"], "response": reading, "scores": scores, "seconds": elapsed,
            "unasked_payees": [p for p in fields.get("pay", []) if p not in wanted],
        })
        print(case["id"], round(elapsed, 3), [k for k, v in scores.items() if not v], flush=True)
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "url": args.url,
        "summary": summarize(rows),
        "original": summarize(rows[:len(original)]),
        "additional": summarize(rows[len(original):]),
        "rows": rows,
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["summary"], indent=2))
    if report["summary"]["unasked_payee_cases"] or not all(r["scores"]["available"] for r in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
