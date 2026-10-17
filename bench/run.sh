#!/usr/bin/env bash
# Beyond against Bun, runs alternated: the server (`oha -c 50` for 10 s, the
# text and the JSON program), JSON of typed (`aot type`) and plain objects
# from the server, a Hono app (bench/hono), an Elysia app (bench/elysia),
# the fetch() client (1, 10 and 50
# in flight, against a Beyond server) and URL parsing. Needs bun and oha on
# PATH, and Beyond built (cargo build --release).
#
#   bench/run.sh [serve|json|hono|elysia|fetch|url]...
set -euo pipefail
cd "$(dirname "$0")/.."
# Bun as it runs by default (an environment can set --smol here).
unset BUN_OPTIONS
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

# Loads the running server for 10 s (at path $3, else /): requests a
# second, p99 latency and its memory (labeled $1 $2).
measure() {
  local pid rss
  pid=$(jobs -p | tail -1)
  printf '%-11s %-6s ' "$1" "$2"
  oha -c 50 -z 10s --no-tui --output-format json "http://127.0.0.1:3000${3:-/}" > "$work/oha.json"
  rss=$(ps -o rss= -p "$(pgrep -P "$pid" || echo "$pid")" | tail -1)
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); s=d["summary"]; p=d["latencyPercentiles"]; print("%8.0f requests/s  p99 %.2f ms  RSS %d MB" % (s["requestsPerSec"], p["p99"]*1000, int(sys.argv[2])//1024))' "$work/oha.json" "$rss"
}

serve() {
  for name in serve-text serve-json; do
    prepare "$name"
    for round in 1 2; do
      for who in beyond bun; do
        if [ $who = beyond ]; then serving "$work/$name"; else serving bun "$work/$name.bun.ts"; fi
        measure "$name" "$who"
        stop
      done
    done
  done
}

# A user made for each request, and a list of 50: Beyond with them typed
# (`aot type`), Beyond with them plain (`type`), and Bun (plain: it has no
# typed objects).
json() {
  for name in serve-user serve-users; do
    prepare "$name"
    mv "$work/$name" "$work/$name-typed"
    prepare "$name" 's/^aot type/type/'
    for round in 1 2; do
      for who in typed plain bun; do
        case $who in
          typed) serving "$work/$name-typed" ;;
          plain) serving "$work/$name" ;;
          bun) serving bun "$work/$name.bun.ts" ;;
        esac
        measure "$name" "$who"
        stop
      done
    done
  done
}

# A Hono app (bench/hono, its dependency installed with bun): its text,
# JSON and path parameter routes, through its middleware.
hono() {
  [ -d bench/hono/node_modules ] || (cd bench/hono && bun install > /dev/null)
  sed 's/Beyond\.serve/Bun.serve/' bench/hono/app.ts > bench/hono/app.bun.ts
  "$beyond" build bench/hono/app.ts -o "$work/hono" > /dev/null
  for round in 1 2; do
    for who in beyond bun; do
      if [ $who = beyond ]; then serving "$work/hono"; else serving bun bench/hono/app.bun.ts; fi
      for path in / /json /users/42; do measure "hono $path" "$who" "$path"; done
      stop
    done
  done
  rm -f bench/hono/app.bun.ts
}

# An Elysia 2 app (bench/elysia), built ahead of time with Elysia's AOT
# plugin (bun build.ts): the same bundle on Beyond and on Bun, and on Bun
# the app itself as well (Elysia composing its handlers at run time).
elysia() {
  [ -d bench/elysia/node_modules ] || (cd bench/elysia && bun install > /dev/null)
  (cd bench/elysia && bun build.ts > /dev/null)
  "$beyond" build bench/elysia/dist/app.js -o "$work/elysia" > /dev/null
  for round in 1 2; do
    for who in beyond bun bun-jit; do
      case $who in
        beyond) serving "$work/elysia" ;;
        bun) serving bun bench/elysia/dist/app.js ;;
        bun-jit) serving bun bench/elysia/app.ts ;;
      esac
      for path in / /json /users/42; do measure "elysia $path" "$who" "$path"; done
      stop
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
