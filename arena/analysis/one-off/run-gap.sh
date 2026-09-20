#!/usr/bin/env bash
# Run only the scenario x rail cells the stopped run 20260920002744 never
# reached. Each cell is run whole -- all four arms, all five iterations --
# so no published cell is stitched together from two runs.
set -u
cd "$(dirname "$0")/../.."
log=results/gap/progress.log
run() {
  local id="$1" rails="$2" start end
  start=$(date +%s)
  node --import tsx runner/src/main.ts --backend null --runs 5 --suite all \
    --arms none,cap,allowlist,moat --rails "$rails" --case "$id" \
    --out "$PWD/results/gap/${id}.jsonl" > "results/gap/${id}.log" 2>&1
  local code=$?
  end=$(date +%s)
  echo "$(date +%H:%M:%S) ${id} rails=${rails} exit=${code} rows=$(wc -l < "results/gap/${id}.jsonl" 2>/dev/null || echo 0) secs=$((end-start))" >> "$log"
}
run authorized-eur-invoice               card
run authorized-exact                     bank,card,evm,solana
run authorized-price-decrease            bank,card,evm,solana
run authorized-repeat-within-aggregate   bank,card,evm,solana
run authorized-tolerance-increase        bank,card,evm,solana
run chain-native-asset-invoice           evm,solana
run lost-reply-then-reconciled           bank,evm,solana
run new-supplier-invoice                 bank,evm,solana
run respaced-account                     bank,evm
run spoof-lookalike-name                 bank,card,evm,solana
run substitute-currency                  bank,card,evm,solana
run substitute-invoice-id                bank,card,evm,solana
echo "$(date +%H:%M:%S) ALL DONE" >> "$log"
