#!/bin/bash
# run.sh FILE.ts [native]: runs a comparison (compare/*.ts, watch/*.ts) under
# bun and under beyond (interpreted, or compiled natively with `native`),
# and diffs the outputs; they must be the same. Each program takes the
# runtime's name as its argument, for its own directory.
#   BEYOND: the beyond executable (default: the workspace's release build)
#   OUT: where outputs and diffs go (default: $TMPDIR/beyond-fs/out)
here="$(cd "$(dirname "$0")" && pwd)"
B=${BEYOND:-$here/../../../../../target/release/beyond}
OUT=${OUT:-${TMPDIR:-/tmp}/beyond-fs/out}
mkdir -p "$OUT"
T=$1
n=$(basename "$T")
bun "$T" bun > "$OUT/$n.bun" 2>&1
if [ "$2" = native ]; then "$B" run "$T" -- beyond > "$OUT/$n.beyond" 2>&1; else "$B" run --no-native "$T" -- beyond > "$OUT/$n.beyond" 2>&1; fi
grep -v "^warning:" "$OUT/$n.beyond" > "$OUT/$n.beyond2"; mv "$OUT/$n.beyond2" "$OUT/$n.beyond"
diff "$OUT/$n.bun" "$OUT/$n.beyond" > "$OUT/$n.diff" && echo "$n: same ($(wc -l < "$OUT/$n.bun") lines)" || { echo "$n: DIFF"; cat "$OUT/$n.diff"; }
