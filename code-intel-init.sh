#!/usr/bin/env bash
# Build/refresh code intelligence for a checkout or worktree:
#   - CodeGraph  (knowledge-graph index in .codegraph/)  -> mcp__codegraph__*
#   - Serena     (LSP symbol cache in .serena/)          -> mcp__serena__*
# A new worktree seeds both indexes from the canonical checkout (APFS
# copy-on-write clone + incremental sync) in seconds instead of a full re-index.
# Safe to re-run; both are incremental after the first pass.
#
# Usage:
#   code-intel-init.sh [dir]   index dir (defaults to the current worktree)
set -euo pipefail
export PATH="$PATH:$HOME/.local/bin"

DIR="${1:-$PWD}"
[ -d "$DIR" ] || { echo "error: not a directory: $DIR" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"
git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git checkout: $DIR" >&2; exit 1; }

# Canonical checkout the worktree was created from (…/frontend/.git -> …/frontend).
# Its .codegraph/.serena indexes are the seed source; for the canonical checkout
# itself CANON == DIR and seeding is skipped.
COMMON="$(git -C "$DIR" rev-parse --path-format=absolute --git-common-dir)"
CANON="$(dirname "$COMMON")"

# APFS copy-on-write clone (instant, no extra disk); plain copy elsewhere.
clone_dir() { cp -Rc "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }

echo "== code intel for $DIR"

if command -v codegraph >/dev/null 2>&1; then
  if [ ! -d "$DIR/.codegraph" ] && [ "$CANON" != "$DIR" ] && [ -d "$CANON/.codegraph" ]; then
    echo "-- codegraph: seeding index from $CANON (clone), then syncing the diff"
    clone_dir "$CANON/.codegraph" "$DIR/.codegraph"
    codegraph sync "$DIR"
  elif [ -d "$DIR/.codegraph" ]; then
    echo "-- codegraph: syncing existing index"
    codegraph sync "$DIR"
  else
    echo "-- codegraph: no canonical index to seed from — full init (slow, one-time)"
    codegraph init "$DIR"
  fi
else
  echo "-- codegraph: not on PATH, skipped" >&2
fi

if command -v serena >/dev/null 2>&1; then
  if [ ! -d "$DIR/.serena" ] && [ "$CANON" != "$DIR" ] && [ -d "$CANON/.serena" ]; then
    echo "-- serena: seeding cache from $CANON (clone)"
    clone_dir "$CANON/.serena" "$DIR/.serena"
  fi
  echo "-- serena: indexing symbols (incremental against cache)"
  serena project index "$DIR"
else
  echo "-- serena: not on PATH, skipped" >&2
fi

echo
echo "done. codegraph + serena in .mcp.json follow the session's directory —"
echo "no per-worktree path config needed."
