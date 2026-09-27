# Intent schema order experiment — 2026-09-27

The notebook's Python dict preserves schema property order. Rust's
`serde_json::Value` sorted the properties alphabetically. With llama.cpp b11205,
that changed the generation order, causing the model to decide cancellation
before identifying the requested and refused payees. The fix serializes the
schema as `RawValue` inside typed request structs. The original prompt, model,
MTP configuration and queue remain the same.

## Method

Sequential synthetic reads through SkyLight's Moat HTTP reader, Redis queue,
SSH tunnel and Colab T4. Baseline: deployed reader `6a18f82` on port 7083.
Candidate: reader `884d3a9` on a temporary loopback port 7085, using the same
queue and model. Neither run registered intents or executed payments. The
gateway was not called. No other evaluation ran during these two measurements.

The original 36 messages and 18 additional multilingual messages are in
`crates/moat-intent/tests/`. The additional cases were written before the
first candidate results were inspected, then used to compare candidates;
they are internal validation data, not an independent benchmark.

Each complete reading requires exact payee/refusal/reference sets, correct
canonical amount, accepted currency, correct cancellation and no spurious
destination. Currency is scored only for an active payment. Amount must be
absent when there is no payment. Names are compared exactly here (including
punctuation); the Rust corpus test also reports spelling-normalized names.

The old corpus scorer incorrectly stripped decimal commas, accepted missing
amounts/currencies, and ignored extra references. The new scorer corrects those
issues. Do not compare its complete-reading count to the notebook's per-field
36/36 claims as if they used identical scoring.

Prompt-expansion trials did not improve overall accuracy, and one omitted an
amount. They were rejected. This change preserves the original prompt.

## Results

| Metric, 54 messages | Deployed baseline | Ordered schema |
| --- | ---: | ---: |
| Complete readings | 33/54 | 51/54 |
| Correct payees | 53/54 | 54/54 |
| Exact refused-name sets | 50/54 | 53/54 |
| Correct amounts | 53/54 | 54/54 |
| Correct cancellation flags | 48/54 | 54/54 |
| Correct destinations | 44/54 | 54/54 |
| Exact reference sets | 52/54 | 52/54 |
| Cases with an unasked payee | 1 | 0 |
| Median wall time | 1.905 s | 1.477 s |
| p95 wall time | 2.254 s | 1.615 s |

Full responses, per-case scores, reader hashes and timings are saved in
[baseline.json](baseline.json) and [ordered-candidate.json](ordered-candidate.json).
The original 36-message subset improved from 26 to 35 complete readings;
the additional 18 improved from 7 to 16. The median reduction was about 22%.

The remaining errors were `flat deposit` and `office deposit` incorrectly
included as references, and `Birch Ltd.` instead of `Birch Ltd` in a refusal.
The latter counts as wrong under exact matching, though the core's spelling
normalization treats them alike. No unsafe payment was executed in any run;
the baseline's unasked payee was a reading of a question, not a payment.

The final implementation also removes the grounding fallback that accepted
any literal substring as an account destination. Only a known destination
placeholder can restore an account. This closes the name-as-account path
observed in ten baseline readings, independently of model improvements.

This is one before/after run on a small internal sample, not a production
safety guarantee. Generation can vary despite temperature zero, and these
measurements include the SkyLight-to-Colab path rather than only GPU time.

## Reproduce

From the repository on SkyLight, with the reader running:

```sh
python3.12 research/intent-reader/evaluate_live.py \
  --url http://127.0.0.1:7083 --output /home/moat-eval/live-results.json
```

For the Rust corpus test through the queue (model inference still on Colab):

```sh
MOAT_INTENT_LLM_URL=http://127.0.0.1:8093 \
MOAT_INTENT_MODEL=gemma-4-E4B-it-qat-UD-Q4_K_XL \
cargo test --release -p moat-intent --test model_corpus -- --nocapture
```

Set `MOAT_INTENT_CORPUS=crates/moat-intent/tests/additional-corpus.json`
to evaluate the additional messages with the Rust test.
