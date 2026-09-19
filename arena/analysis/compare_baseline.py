#!/usr/bin/env python3
"""Compare a fresh run against a published one, cell by cell.

The card numbers are the regression. Every change to the core, the policies,
the corpus or the runner has to leave them where they were, and "I looked at
the table and it seemed the same" is not a check. This is:

    python analysis/compare_baseline.py results/<new>.jsonl

A cell is one (rail, scenario, arm). Its value is how many of the runs met
the objective: the attacker was paid, or the legitimate payment completed.
Two runs agree when every shared cell has the same count out of the same
number of runs.

Scenarios the baseline never had are reported and, with --allow-new, not
counted as failures -- adding an attack is progress, and it changes the
totals without changing any cell. Scenarios the baseline had and the new run
does not are always a failure: something stopped being measured.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict

HERE = pathlib.Path(__file__).resolve().parent
DATA = HERE / "data"


def load(path: pathlib.Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"{path}: no rows")
    return rows


def cells(rows: list[dict]) -> dict[tuple[str, str, str], tuple[int, int]]:
    """(rail, scenario, arm) -> (objective met, runs)."""
    met: dict[tuple[str, str, str], int] = defaultdict(int)
    runs: dict[tuple[str, str, str], int] = defaultdict(int)
    for row in rows:
        rail = row.get("rail") or "card"
        arm = row.get("arm") or ("none" if row.get("mode") == "direct" else "moat")
        key = (rail, row["attack"], arm)
        runs[key] += 1
        if row.get("objective_met") is None:
            hit = row.get("attacker_paid") or row.get("legitimate_completed")
        else:
            hit = row["objective_met"]
        met[key] += 1 if hit else 0
    return {key: (met[key], runs[key]) for key in runs}


def newest_baseline() -> pathlib.Path:
    found = sorted(DATA.glob("*.jsonl"))
    if not found:
        raise SystemExit(f"no published run in {DATA}")
    return found[-1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("new", type=pathlib.Path, help="results/<run>.jsonl to check")
    ap.add_argument("--baseline", type=pathlib.Path, default=None)
    ap.add_argument(
        "--allow-new",
        action="store_true",
        help="a scenario the baseline never ran is reported, not failed",
    )
    args = ap.parse_args()

    baseline_path = args.baseline or newest_baseline()
    base = cells(load(baseline_path))
    new = cells(load(args.new))

    shared = sorted(set(base) & set(new))
    added = sorted(set(new) - set(base))
    missing = sorted(set(base) - set(new))

    mismatches = [
        (key, base[key], new[key]) for key in shared if base[key] != new[key]
    ]

    print(f"baseline {baseline_path.name}")
    print(f"new      {args.new.name}")
    print(f"shared cells {len(shared)} | mismatches {len(mismatches)}")

    for key, was, now in mismatches:
        rail, scenario, arm = key
        print(f"  MOVED {rail}/{scenario}/{arm}: {was[0]}/{was[1]} -> {now[0]}/{now[1]}")
    for key in added:
        rail, scenario, arm = key
        print(f"  new   {rail}/{scenario}/{arm}: {new[key][0]}/{new[key][1]}")
    for key in missing:
        rail, scenario, arm = key
        print(f"  GONE  {rail}/{scenario}/{arm}: was {base[key][0]}/{base[key][1]}")

    failed = bool(mismatches) or bool(missing) or (bool(added) and not args.allow_new)
    if not failed:
        print("every shared cell agrees")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
