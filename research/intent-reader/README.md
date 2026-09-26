# GLiNER as a span locator for Moat's intent reader

`gliner_eval.py` runs a GLiNER model over 26 payment sentences in 12
languages and scores what Moat needs: the payee and the amount as exact spans
of the user's text, reference numbers never read as prices, and every span a
literal substring of the input. Results from 26 September 2026 are the
`results_*.json` files beside it.

Run it in an isolated environment:

```bash
uv venv gliner-env --python 3.11
uv pip install --python gliner-env/Scripts/python.exe --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple torch
uv pip install --python gliner-env/Scripts/python.exe gliner sentencepiece protobuf tiktoken
gliner-env/Scripts/python.exe gliner_eval.py NAMAA-Space/gliner_arabic-v2.1 0.4 script
```

The third argument `script` swaps GLiNER's whitespace word splitter for one
that makes each Chinese, Japanese or Korean character its own token. Without
it, unspaced CJK text is one "word" and nothing is found.

GLiNER locates names and amounts. It does not judge negation: in "don't pay
X, pay Y" it returns both. Deciding which one the user asked for stays with
the rules reader or a generative model.

## Generative readers

`llm_eval.py` asks a model served by llama.cpp to read one user message and
return, as schema-constrained JSON, who to pay, who is refused, the amount, the
currency and any references. It runs 36 cases, the 26 above plus ten that a
span locator cannot handle: "cancel that", a quoted scam email, a budget with
no payee, a question, and negations in Italian, German, Japanese, Hindi, Gulf
Arabic and Chinese. `rescore.py` then applies Moat's own number rule.

Fail-open means the model put someone in `pay` whom the user refused or never
named. It is the only error that could let money out.

| Model, Q4_K_M | Fail-open | Payee | Refused | Currency ISO | Median on a Ryzen 5 5600G |
|---|---|---|---|---|---|
| Gemma 4 E4B | 0 | 36/36 | 36/36 | 36/36 | 8.3 s |
| Qwen3.5 4B | 0 | 36/36 | 36/36 | 23/36 | 7.7 s |
| Gemma 4 E2B | 3 | 32/36 | 35/36 | 19/36 | 4.2 s |
| Qwen3.5 2B | 4 | 29/36 | 33/36 | 30/36 | 2.8 s |

Serve a model with:

```bash
llama-server -hf unsloth/gemma-4-E4B-it-GGUF:Q4_K_M --jinja -c 4096 -t 6 --port 8092
python llm_eval.py gemma4-e4b 8092
```
