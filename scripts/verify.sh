#!/usr/bin/env bash
# The checks that decide whether a commit is fit to push.
#
# One script, run from two places: the pre-push hook and CI. They used to be
# two lists in two files, which is fine until they drift and "CI is green"
# stops meaning "the thing I ran locally passed". Adding a check here adds it
# to both.
#
#   scripts/verify.sh            everything
#   scripts/verify.sh rust       the crates only
#   scripts/verify.sh arena      the TypeScript workspace only
#
# Exits non-zero on the first failure, and says which check failed rather than
# leaving the last hundred lines of cargo output to be read backwards.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
scope="${1:-all}"
failed=""

step() {
  printf '\n\033[1m--- %s\033[0m\n' "$1"
  shift
  if ! "$@"; then
    failed="$*"
    return 1
  fi
}

if [[ "$scope" == "all" || "$scope" == "rust" ]]; then
  step "cargo fmt" cargo fmt --all --check
  step "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings
  step "cargo test" cargo test --workspace
fi

# The arena is where every bug this project has shipped actually came from, so
# it is not optional when it is present.
if [[ "$scope" == "all" || "$scope" == "arena" ]]; then
  if [[ -f arena/package.json ]]; then
    step "pnpm typecheck" pnpm --dir arena typecheck
    step "pnpm test" pnpm --dir arena test
  else
    echo "arena/package.json not present; skipping"
  fi
fi

printf '\n\033[32mall checks passed\033[0m\n'
