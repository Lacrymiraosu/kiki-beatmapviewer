#!/usr/bin/env bash
# Syntax check before committing (also run by CI):
#   1. node --check on every JS file (site, server, scripts)
#   2. the site's scripts joined in the order index.html loads them, checked as one file: they share one global
#      scope, so this catches the same top-level name declared in two files
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for f in js/*.js api/*.js api/_lib/*.js api/auth/*.js worker.js sw.js scripts/*.mjs; do
  [ -e "$f" ] || continue
  node --check "$f" || { echo "syntax error: $f"; fail=1; }
done

order=$(grep -o '<script src="js/[^"?]*' index.html | sed 's/<script src="//')
[ -n "$order" ] || { echo "no <script src=\"js/...\"> tags found in index.html"; exit 1; }
for f in js/*.js; do
  grep -qx "$f" <<<"$order" || echo "note: $f is not loaded by index.html"
done
all=$(mktemp --suffix=.js)
trap 'rm -f "$all"' EXIT
for f in $order; do cat "$f"; echo; done > "$all"
node --check "$all" || { echo "the joined scripts don't parse: a top-level name is probably declared in two files"; fail=1; }

[ "$fail" = 0 ] && echo "syntax OK ($(wc -l <<<"$order" | tr -d ' ') scripts in load order)"
exit "$fail"
