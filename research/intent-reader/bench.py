"""Time the reader's real request against a running llama-server.

Usage: python bench.py <label> <port>
Sends the moat-intent system prompt and schema with eight corpus messages,
records wall time and generation speed, and saves the answers so configs can
be compared for identical output.
"""
import json
import re
import statistics
import sys
import time
import urllib.request

READER = "C:/home/moat-prod-work/crates/moat-intent/src/reader.rs"
CORPUS = "C:/home/moat-prod-work/crates/moat-intent/tests/corpus.json"
IDS = ["en-1", "en-2", "ar-2", "it-2", "de-2", "zh-2", "x-quote", "x-zh-cancel"]

src = open(READER, encoding="utf-8").read()
raw = re.search(r'pub const SYSTEM_PROMPT: &str = "\\\n(.*?)";\n', src, re.S).group(1)
SYSTEM = raw.replace('\\"', '"')
SCHEMA = {
    "type": "object",
    "properties": {
        "pay": {"type": "array", "items": {"type": "string"}},
        "refused": {"type": "array", "items": {"type": "string"}},
        "amount": {"type": ["string", "null"]},
        "currency": {"type": ["string", "null"]},
        "destinations": {"type": "array", "items": {"type": "string"}},
        "references": {"type": "array", "items": {"type": "string"}},
        "cancels_previous": {"type": "boolean"},
    },
    "required": ["pay", "refused", "amount", "currency", "destinations", "references", "cancels_previous"],
}
cases = {c["id"]: c for c in json.load(open(CORPUS, encoding="utf-8"))}


def ask(port, text):
    body = json.dumps({
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
        "temperature": 0, "max_tokens": 400,
        "response_format": {"type": "json_schema", "json_schema": {"name": "intent", "schema": SCHEMA}},
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return out, time.time() - t


label, port = sys.argv[1], int(sys.argv[2])
ask(port, "warm up")  # first request loads the prompt cache
walls, speeds, answers, drafted = [], [], {}, []
for cid in IDS:
    out, wall = ask(port, cases[cid]["text"])
    walls.append(wall)
    t = out.get("timings", {})
    speeds.append(t.get("predicted_per_second", 0))
    if t.get("draft_n"):
        drafted.append(t.get("draft_n_accepted", 0) / max(t["draft_n"], 1))
    answers[cid] = json.loads(out["choices"][0]["message"]["content"])
summary = {
    "config": label,
    "median_s": round(statistics.median(walls), 2),
    "tokens_per_s": round(statistics.mean(speeds), 1),
    "draft_acceptance": round(statistics.mean(drafted), 2) if drafted else None,
}
json.dump({"summary": summary, "answers": answers}, open(f"D:/moat-ml/bench_{label}.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=1)
print(json.dumps(summary))
