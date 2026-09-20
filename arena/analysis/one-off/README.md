# one-off

Tools written for a single run and kept as its provenance, not as part of
the pipeline. Nothing here is on a path `tables.py` or CI touches.

## The 20 September 2026 four-rail join

Run `20260920002744-null` was stopped with 1,285 of 2,060 rows on disk.
Re-running the whole corpus costs an hour and re-measures 1,285 rows that
nothing had changed, so the gap was run on its own and the two halves were
joined.

`run-gap.sh` runs the twelve scenarios that had cells the first half never
reached, each across only the rails it was missing, all four arms and all
five iterations -- so every published cell comes wholly from one half. One
cell, `spoof-lookalike-name` on card, was caught mid-flight with 5 of its
20 rows; it was rerun and those 5 discarded.

`merge-gap.py` writes nothing unless the join is exactly the planned set:
every (scenario, rail, arm, iteration) once, none missing, none twice. It
records both halves and their commits in the joined manifest's
`composed_of`.

Neither script runs from a clean checkout: both expect the run artefacts
under `arena/results/`, which are not committed. They are here to be read
against the manifest and the published `.jsonl`, both of which are.
