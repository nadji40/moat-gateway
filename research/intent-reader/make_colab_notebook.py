"""Build colab_gpu_bench.ipynb from the reader's own prompt and the corpus.

The notebook runs Gemma 4 E4B (QAT) with and without its MTP drafter on a
Colab GPU, scores the reader's corpus exactly as the local tests do, and
writes the results to Google Drive under MyDrive/moat-gemma-bench/.

Run from the repo root:  python research/intent-reader/make_colab_notebook.py
"""
import json
import pprint
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
reader = (ROOT / "crates/moat-intent/src/reader.rs").read_text(encoding="utf-8")
prompt = re.search(r'pub const SYSTEM_PROMPT: &str = "\\\n(.*?)";\n', reader, re.S).group(1).replace('\\"', '"')
corpus = json.loads((ROOT / "crates/moat-intent/tests/corpus.json").read_text(encoding="utf-8"))

LLAMA_TAG = "b11205"

cells = []


def md(text):
    cells.append({"cell_type": "markdown", "metadata": {}, "source": text.strip("\n")})


def code(text):
    cells.append({"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
                  "source": text.strip("\n")})


md("""
# Moat intent reader: Gemma 4 E4B on a GPU

Measures how fast the `moat-intent` reader's model reads a message on a GPU, and checks it is still safe.

**To run:** Runtime → Change runtime type → **T4 GPU** → Save. Then Runtime → **Run all**, and allow the Google Drive prompt.

It runs the reader's exact prompt over the 36-message corpus (12 languages) in three setups:
1. Gemma 4 E4B, quantization-aware build, alone.
2. The same with Google's MTP drafter (speculative decoding), four tokens ahead.
3. Four requests at once, to see how many users one GPU serves.

Results go to **MyDrive/moat-gemma-bench/**. Nothing else is written, and no message leaves Colab except to Hugging Face and GitHub for the downloads.
""")

code("""
# 1. A GPU is required.
import subprocess
gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                     capture_output=True, text=True)
assert gpu.returncode == 0, "No GPU. Runtime -> Change runtime type -> T4 GPU, then run again."
GPU = gpu.stdout.strip()
print(GPU)
""")

code("""
# 2. Where the results go.
from google.colab import drive
drive.mount("/content/drive")
import os
OUT = "/content/drive/MyDrive/moat-gemma-bench"
os.makedirs(OUT, exist_ok=True)
print("results will be written to", OUT)
""")

code(f"""
# 3. llama.cpp, the official prebuilt CUDA build (no compiling).
import glob, os, subprocess
TAG = "{LLAMA_TAG}"
BASE = f"https://github.com/ggml-org/llama.cpp/releases/download/{{TAG}}"
os.makedirs("/content/llama", exist_ok=True)
!wget -q -O /content/llama.tar.gz {{BASE}}/llama-{{TAG}}-bin-ubuntu-cuda-12.8-x64.tar.gz
!tar -xzf /content/llama.tar.gz -C /content/llama
SERVER = glob.glob("/content/llama/**/llama-server", recursive=True)[0]
LIBDIR = os.path.dirname(SERVER)
os.environ["LD_LIBRARY_PATH"] = LIBDIR + ":" + os.environ.get("LD_LIBRARY_PATH", "")
missing = subprocess.run(f"ldd {{SERVER}} | grep 'not found'", shell=True, capture_output=True, text=True).stdout
if missing.strip():
    print("fetching the CUDA runtime llama.cpp was built against:\\n", missing)
    !wget -q -O /content/cudart.tar.gz {{BASE}}/cudart-llama-{{TAG}}-bin-ubuntu-cuda-12.8-x64.tar.gz
    !tar -xzf /content/cudart.tar.gz -C {{LIBDIR}}
print(subprocess.run([SERVER, "--version"], capture_output=True, text=True).stderr.strip()[-200:])
""")

code("""
# 4. The model and its drafter (4.2 GB and 60 MB).
from huggingface_hub import hf_hub_download
REPO = "unsloth/gemma-4-E4B-it-qat-GGUF"
MODEL = hf_hub_download(REPO, "gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf", local_dir="/content/models")
DRAFT = hf_hub_download(REPO, "mtp-gemma-4-E4B-it.gguf", local_dir="/content/models")
print(MODEL, DRAFT, sep="\\n")
""")

code("# 5. The reader's prompt and the corpus, copied from the repository.\n"
     f"SYSTEM = {json.dumps(prompt, ensure_ascii=False)}\n\n"
     f"CORPUS = {pprint.pformat(corpus, width=110, sort_dicts=False)}\n\n"
     "SCHEMA = {\n"
     '    "type": "object",\n'
     '    "properties": {\n'
     '        "pay": {"type": "array", "items": {"type": "string"}},\n'
     '        "refused": {"type": "array", "items": {"type": "string"}},\n'
     '        "amount": {"type": ["string", "null"]},\n'
     '        "currency": {"type": ["string", "null"]},\n'
     '        "destinations": {"type": "array", "items": {"type": "string"}},\n'
     '        "references": {"type": "array", "items": {"type": "string"}},\n'
     '        "cancels_previous": {"type": "boolean"},\n'
     "    },\n"
     '    "required": ["pay", "refused", "amount", "currency", "destinations", "references", "cancels_previous"],\n'
     "}\n"
     'print(len(CORPUS), "messages")')

code("""
# 6. Running a server, asking it, scoring the answer.
import json, re, statistics, subprocess, time, unicodedata, urllib.request
from concurrent.futures import ThreadPoolExecutor

PORT = 8092

def start(*args):
    log = open("/content/server.log", "w")
    proc = subprocess.Popen([SERVER, "-m", MODEL, "--host", "127.0.0.1", "--port", str(PORT),
                             "--jinja", "--no-mmproj", "-ngl", "99", *args],
                            stdout=log, stderr=subprocess.STDOUT, env=os.environ)
    for _ in range(180):
        if proc.poll() is not None:
            break
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as r:
                if b'"ok"' in r.read():
                    return proc
        except Exception:
            time.sleep(1)
    proc.kill()
    raise RuntimeError(open("/content/server.log").read()[-2000:])

def stop(proc):
    proc.kill(); proc.wait(); time.sleep(2)

def gpu_memory():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.strip()
    return round(int(out.splitlines()[0]) / 1024, 2)

def ask(text):
    body = json.dumps({
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
        "temperature": 0, "max_tokens": 400,
        "response_format": {"type": "json_schema", "json_schema": {"name": "intent", "schema": SCHEMA}},
        "chat_template_kwargs": {"enable_thinking": False},
    }).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    t = time.time()
    with urllib.request.urlopen(req, timeout=300) as r:
        out = json.load(r)
    wall = time.time() - t
    timings = out.get("timings", {})
    return json.loads(out["choices"][0]["message"]["content"]), wall, timings

def norm(s):
    return unicodedata.normalize("NFKC", s or "").strip().strip(".,،:;\\"'").casefold()

AR = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬", "01234567890123456789.,")
def number(s):
    if not s:
        return None
    s = re.sub(r"[^\\d.,']", "", s.translate(AR))
    if re.fullmatch(r"\\d{1,3}(\\.\\d{3})+,\\d+", s): s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\\d+,\\d{1,2}", s): s = s.replace(",", ".")
    else: s = s.replace(",", "").replace("'", "")
    try: return f"{float(s):.6f}".rstrip("0").rstrip(".")
    except ValueError: return None

def score(case, got):
    pays = [norm(p) for p in got.get("pay") or []]
    wanted = {norm(case["pay"])} if case["pay"] else set()
    refused = {norm(r) for r in case["refused"]}
    # Fail-open: anyone in "pay" the user refused or did not ask for. The
    # only error that could let money out, and it is judged on the raw
    # answer: the reader's grounding can only remove from "pay".
    unasked = [p for p in pays if p not in wanted and (p in refused or not any(p in w or w in p for w in wanted))]
    return {
        "id": case["id"],
        "fail_open": unasked,
        "pay_ok": set(pays) == wanted,
        "refused_ok": all(norm(r) in {norm(x) for x in got.get("refused") or []} for r in case["refused"]),
        "amount_ok": (case["amount"] is None or not case["pay"]) or number(got.get("amount")) == number(case["amount"]),
        "currency_ok": (not case["pay"]) or (got.get("currency") or "").upper() in case["currencies"],
        "references_ok": all(r in (got.get("references") or []) for r in case.get("references", [])),
        "cancel_ok": bool(got.get("cancels_previous")) == case.get("cancels", False),
        "got": got,
    }

def run_corpus(label):
    ask("warm up")
    rows, walls, speeds, accept = [], [], [], []
    for case in CORPUS:
        got, wall, t = ask(case["text"])
        walls.append(wall); speeds.append(t.get("predicted_per_second", 0))
        if t.get("draft_n"):
            accept.append(t.get("draft_n_accepted", 0) / t["draft_n"])
        rows.append({**score(case, got), "seconds": round(wall, 3)})
    n = len(rows)
    summary = {
        "config": label, "gpu": GPU, "messages": n,
        "fail_open": sum(bool(r["fail_open"]) for r in rows),
        "payee": sum(r["pay_ok"] for r in rows), "refused": sum(r["refused_ok"] for r in rows),
        "amount": sum(r["amount_ok"] for r in rows), "currency": sum(r["currency_ok"] for r in rows),
        "references": sum(r["references_ok"] for r in rows), "cancel": sum(r["cancel_ok"] for r in rows),
        "median_s": round(statistics.median(walls), 3), "p95_s": round(sorted(walls)[int(n * 0.95) - 1], 3),
        "tokens_per_s": round(statistics.mean(speeds), 1),
        "draft_acceptance": round(statistics.mean(accept), 2) if accept else None,
        "gpu_memory_gb": gpu_memory(),
    }
    print(json.dumps(summary))
    return {"summary": summary, "rows": rows}

def run_concurrent(label, workers):
    ask("warm up")
    texts = [c["text"] for c in CORPUS]
    t = time.time()
    with ThreadPoolExecutor(workers) as pool:
        results = list(pool.map(ask, texts))
    total = time.time() - t
    walls = [w for _, w, _ in results]
    summary = {
        "config": label, "gpu": GPU, "concurrent": workers, "messages": len(texts),
        "total_s": round(total, 2), "messages_per_minute": round(len(texts) / total * 60, 1),
        "median_s": round(statistics.median(walls), 3), "max_s": round(max(walls), 3),
        "gpu_memory_gb": gpu_memory(),
    }
    print(json.dumps(summary))
    return {"summary": summary}
""")

code("""
# 7. The three setups.
results = {"gpu": GPU, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "runs": []}

proc = start("-np", "1", "-c", "2048")
results["runs"].append(run_corpus("gemma alone"))
stop(proc)

proc = start("-np", "1", "-c", "2048", "-md", DRAFT, "--spec-type", "draft-mtp", "--spec-draft-n-max", "4")
results["runs"].append(run_corpus("gemma + drafter"))
stop(proc)

# Four at once. The drafter may not support parallel slots in this build;
# if it does not start, the same test runs without it.
try:
    proc = start("-np", "4", "-c", "8192", "-md", DRAFT, "--spec-type", "draft-mtp", "--spec-draft-n-max", "4")
    results["runs"].append(run_concurrent("gemma + drafter, 4 at once", 4))
except RuntimeError as e:
    print("drafter with 4 slots did not start; running without it.\\n", str(e)[-400:])
    proc = start("-np", "4", "-c", "8192")
    results["runs"].append(run_concurrent("gemma alone, 4 at once", 4))
stop(proc)
""")

code("""
# 8. Save to Drive and show the summary.
results["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
stamp = time.strftime("%Y%m%d-%H%M%S")
for name in (f"results-{stamp}.json", "results-latest.json"):
    with open(f"{OUT}/{name}", "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
print("saved to", OUT)
import pandas as pd
pd.DataFrame([r["summary"] for r in results["runs"]])
""")

notebook = {
    "nbformat": 4, "nbformat_minor": 5,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"provenance": [], "gpuType": "T4"},
        "kernelspec": {"name": "python3", "display_name": "Python 3"},
        "language_info": {"name": "python"},
    },
    "cells": cells,
}
out = ROOT / "research/intent-reader/colab_gpu_bench.ipynb"
out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1), encoding="utf-8")
print(out, len(cells), "cells", out.stat().st_size, "bytes")
