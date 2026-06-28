#!/usr/bin/env bash
# Start a local solana-test-validator with torna.so preloaded, run the parallel
# benchmark against it, then tear the validator down. Single-node Agave banking
# stage = the real Sealevel scheduler (unlike LiteSVM).
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROG=$(cat PROGRAM_ID.txt)
SO=../sbf/out/torna.so
LEDGER=/tmp/torna-bench-ledger
RPC=http://127.0.0.1:8899

echo "program: $PROG"
[ -f "$SO" ] || { echo "missing $SO -- run 'make sbf' first"; exit 1; }

pkill -f solana-test-validator 2>/dev/null || true
sleep 1
rm -rf "$LEDGER"

echo "starting validator..."
solana-test-validator --reset --quiet \
  --ledger "$LEDGER" \
  --bpf-program "$PROG" "$SO" \
  --rpc-port 8899 >/tmp/torna-validator.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true; pkill -f solana-test-validator 2>/dev/null || true' EXIT

echo "waiting for RPC..."
for i in $(seq 1 60); do
  if solana --url "$RPC" cluster-version >/dev/null 2>&1; then echo "validator up"; break; fi
  sleep 1
  [ "$i" = 60 ] && { echo "validator did not come up"; cat /tmp/torna-validator.log; exit 1; }
done

cargo run --release --offline --bin parallel -- "$RPC" "$PROG" "${1:-}"
