#!/usr/bin/env bash
#
# build-release.sh — bundle Stairinator into a releasable zip.
#
# Produces dist/stairinator-<version>.zip containing ONLY the files needed to run
# the app (no VCS or dev cruft), inside a top-level `stairinator/` folder so it
# extracts cleanly. Version defaults to today's date; override with an argument:
#
#   ./build-release.sh            # -> dist/stairinator-YYYYMMDD.zip
#   ./build-release.sh 1.2.0      # -> dist/stairinator-1.2.0.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="stairinator"
VERSION="${1:-$(date +%Y%m%d)}"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/${NAME}-${VERSION}.zip"

# Allow-list: only these top-level items are shipped. Anything else in the repo
# (.git, .gitignore, .pmdCache, node_modules, this script, dist/, DESIGN.md, …)
# is deliberately excluded.
INCLUDE=(
  index.html
  style.css
  app.js
  src
  sample.gpx
  README.md
)

command -v zip >/dev/null 2>&1 || { echo "error: 'zip' is not installed." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/$NAME"
mkdir -p "$DEST"

echo "Bundling $NAME $VERSION ..."
for item in "${INCLUDE[@]}"; do
  if [ ! -e "$ROOT/$item" ]; then
    echo "  error: required item missing: $item" >&2
    exit 1
  fi
  cp -R "$ROOT/$item" "$DEST/"
done

# Belt-and-braces: strip anything that must never ship, in case it slipped into a
# copied directory.
rm -rf "$DEST/.git" "$DEST/.gitignore" "$DEST/.pmdCache" "$DEST/node_modules" "$DEST/dist"
find "$DEST" -name '.DS_Store' -type f -delete

mkdir -p "$OUT_DIR"
rm -f "$OUT"
( cd "$STAGE" && zip -r -q -X "$OUT" "$NAME" )

echo "Created ${OUT#"$ROOT"/}"
echo
unzip -l "$OUT"
