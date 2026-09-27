#!/usr/bin/env bash
# One clean pass: each configuration alone on the machine, one after another.
cd /d/moat-ml
Q4KM="D:/moat-ml/models/models--unsloth--gemma-4-E4B-it-GGUF/snapshots/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf"
QAT="D:/moat-ml/qat/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf"
MTP="D:/moat-ml/qat/mtp-gemma-4-E4B-it.gguf"
COMMON="--jinja -t 6 --host 127.0.0.1 --port 8097 --no-mmproj -np 1 -c 2048"
OUT=/d/moat-ml/run_clean.txt
: > "$OUT"

run() {
  label="$1"; shift
  ./llama/llama-server.exe "$@" $COMMON > "/d/moat-ml/clean-$label.log" 2>&1 &
  pid=$!
  for i in $(seq 1 90); do
    curl -s http://127.0.0.1:8097/health 2>/dev/null | grep -q '"ok"' && break
    sleep 2
  done
  if curl -s http://127.0.0.1:8097/health 2>/dev/null | grep -q '"ok"'; then
    result=$(PYTHONIOENCODING=utf-8 python bench.py "$label" 8097 2>&1 | tail -1)
    mem=$(powershell -NoProfile -Command "Get-Process llama-server | ForEach-Object { '{0:N2} GB resident, {1:N2} GB private' -f (\$_.WorkingSet64/1GB), (\$_.PrivateMemorySize64/1GB) }")
    echo "$label | $result | $mem" >> "$OUT"
  else
    echo "$label | did not start: $(grep -iE 'error|fail' /d/moat-ml/clean-$label.log | tail -2 | tr '\n' ' ')" >> "$OUT"
  fi
  powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force"
  sleep 3
}

run baseline-q4km   -m "$Q4KM"
run qat             -m "$QAT"
run qat-lazy        -m "$QAT" --lazy-mode on
run qat-lazy-ngram  -m "$QAT" --lazy-mode on --spec-type ngram-simple --spec-draft-n-max 16
run qat-lazy-mtp    -m "$QAT" --lazy-mode on -md "$MTP" --spec-type draft-mtp --spec-draft-n-max 4
run qat-lazy-both   -m "$QAT" --lazy-mode on -md "$MTP" --spec-type draft-mtp,ngram-simple --spec-draft-n-max 8
echo "DONE" >> "$OUT"
