#!/usr/bin/env bash
# Beyond against Bun, runs alternated: the server (`oha -c 50` for 10 s, the
# text and the JSON program), the fetch() client (1, 10 and 50 in
# flight, against a Beyond server) and URL parsing. Needs bun and oha on
# PATH, and Beyond built (cargo build --release).
#
#   bench/run.sh [serve|fetch|url]...
set -euo pipefail
cd "$(dirname "$0")/.."
beyond=target/release/beyond
work=$(mktemp -d)
trap 'kill $(jobs -p) 2>/dev/null || true; rm -rf "$work"' EXIT

# Builds bench/NAME.ts with Beyond, and a copy of it for Bun.
prepare() {
  local name=$1 subst=${2:-}
  sed "$subst" "bench/$name.ts" > "$work/$name.ts"
  sed 's/Beyond\.serve/Bun.serve/' "$work/$name.ts" > "$work/$name.bun.ts"
  "$beyond" build "$work/$name.ts" -o "$work/$name" > /dev/null
}

# Runs a server (a command) until $1 stops.
serving() {
  "$@" &
  local pid=$!
  for _ in $(seq 50); do
    curl -s -o /dev/null http://127.0.0.1:3000/ && return 0
    sleep 0.1
  done
  echo "the server did not start" >&2
  return 1
}

stop() {
  kill "$(jobs -p)" 2>/dev/null || true
  wait 2>/dev/null || true
}

serve() {
  for name in serve-text serve-json; do
    prepare "$name"
    for round in 1 2; do
      for who in beyond bun; do
        if [ $who = beyond ]; then serving "$work/$name"; else serving bun "$work/$name.bun.ts"; fi
        local pid
        pid=$(jobs -p | tail -1)
        printf '%-11s %-6s ' "$name" "$who"
        oha -c 50 -z 10s --no-tui --output-format json http://127.0.0.1:3000/ > "$work/oha.json"
        local rss
        rss=$(ps -o rss= -p "$(pgrep -P "$pid" || echo "$pid")" | tail -1)
        python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["summary"]; p=d["latencyPercentiles"]; print("%8.0f requests/s  p99 %.2f ms  RSS %d MB" % (s["requestsPerSec"], p["p99"]*1000, int(sys.argv[2])//1024))' "$work/oha.json" "$rss"
        stop
      done
    done
  done
}

# Runs a command; its output on one line, then its peak memory.
peak() {
  python3 -c 'import resource, subprocess, sys
out = subprocess.run(sys.argv[1:], capture_output=True, text=True).stdout
print(out.replace("\n", "  ") + "peak RSS %d MB" % (resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss // 1024))' "$@"
}

fetch() {
  prepare serve-text
  serving "$work/serve-text"
  for c in 1 10 50; do
    prepare fetch "s/__C__/$c/"
    for round in 1 2; do
      printf 'fetch c=%-3s beyond ' "$c"; peak "$work/fetch"
      printf 'fetch c=%-3s bun    ' "$c"; peak bun "$work/fetch.bun.ts"
    done
  done
  stop
}

url() {
  prepare url
  for round in 1 2; do
    echo "url beyond"; "$work/url"
    echo "url bun"; bun "$work/url.bun.ts"
  done
}

[ $# -eq 0 ] && set -- serve fetch url
for what in "$@"; do "$what"; done
