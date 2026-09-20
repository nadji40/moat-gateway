#!/usr/bin/env python3
"""Join the stopped run to the run that filled its gap, or refuse to.

Run 20260920002744 was stopped with 1,285 of 2,060 rows on disk. Re-running
the whole corpus to recover 775 rows costs an hour and changes nothing that
was already measured, so the gap was run on its own and the two halves are
joined here.

The join is only sound if no published cell is stitched together from both
halves. One cell -- spoof-lookalike-name on card -- was caught mid-flight
with 5 of its 20 rows written; those 5 are dropped and the whole cell comes
from the second half. Everything else was either complete or untouched.

This refuses to write unless the result is exactly the planned set: every
(scenario, rail, arm, iteration) once, none missing, none twice.
"""
from __future__ import annotations

import json
import pathlib
import sys
from collections import Counter

ARENA = pathlib.Path(__file__).resolve().parents[2]
RESULTS = ARENA / "results"
GAP = RESULTS / "gap"
FIRST = RESULTS / "20260920002744-null.jsonl"


def read(path: pathlib.Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


def key(row: dict) -> tuple[str, str, str, int]:
    return (row["attack"], row["rail"], row["arm"], int(row["iteration"]))


def main() -> int:
    plan = set(tuple(k.split("|")[:3]) + (int(k.split("|")[3]),) for k in json.load((GAP / "plan.json").open()))
    second: list[dict] = []
    for path in sorted(GAP.glob("*.jsonl")):
        second.extend(read(path))
    redone = {(k[0], k[1], k[2]) for k in map(key, second)}
    first = [r for r in read(FIRST) if (key(r)[0], key(r)[1], key(r)[2]) not in redone]

    rows = first + second
    counts = Counter(map(key, rows))
    duplicated = sorted(k for k, n in counts.items() if n > 1)
    got = set(counts)
    missing = sorted(plan - got)
    unexpected = sorted(got - plan)
    print(f"first half {len(first)} rows (after dropping cells the second half redid)")
    print(f"second half {len(second)} rows")
    print(f"total {len(rows)} rows; plan {len(plan)}")
    for label, bad in (("duplicated", duplicated), ("missing", missing), ("unexpected", unexpected)):
        for k in bad[:10]:
            print(f"  {label}: {'/'.join(map(str, k))}")
        if len(bad) > 10:
            print(f"  ... and {len(bad) - 10} more {label}")
    if duplicated or missing or unexpected:
        print("REFUSED: the join is not the planned set")
        return 1

    run_id = "20260920002744-null-joined"
    out = RESULTS / f"{run_id}.jsonl"
    rows.sort(key=key)
    with out.open("w", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    base = json.loads((RESULTS / "20260920002744-null.manifest.json").read_text(encoding="utf-8"))
    later = json.loads(sorted(GAP.glob("*.manifest.json"))[0].read_text(encoding="utf-8"))
    base["run_id"] = run_id
    base["results"] = f"results/{run_id}.jsonl"
    base["finished_at"] = max(m["started_at"] for m in (base, later))
    base["composed_of"] = {
        "note": (
            "Two runs joined cell by cell; no cell draws on both. The first was "
            "stopped after 1,285 of 2,060 rows, the second ran only the "
            "scenario/rail cells it never reached, whole. The one cell caught "
            "mid-flight, spoof-lookalike-name on card, was rerun and its 5 "
            "partial rows discarded."
        ),
        "halves": [
            {"run_id": base_id, "commit": commit, "rows": n}
            for base_id, commit, n in (
                ("20260920002744-null", base["commit"], len(first)),
                ("gap runs 20260920113654+", later["commit"], len(second)),
            )
        ],
        "code_delta_between_halves": (
            "crates/moat-gateway/src/proxy.rs splits one authorization-reservation "
            "message into two; same rule id, same decision. The rule does not fire "
            "anywhere in the first half, and nothing else under arena/, policies/ "
            "or crates/ differs."
        ),
    }
    (RESULTS / f"{run_id}.manifest.json").write_text(
        json.dumps(base, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
