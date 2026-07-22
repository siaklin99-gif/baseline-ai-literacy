#!/usr/bin/env bash
# ============================================================
# Sync Baseline into the Hlur website (hlur.ai/baseline).
#   ./sync_hlur.sh
# ------------------------------------------------------------
# THIS repo (AI_Technology) is the single source of truth.
# The copy inside Hlur_Website/baseline/ is a build artifact —
# never edit it there. This script refuses to sync unless the
# local guard passes, so a broken build can't reach hlur.ai.
# After deploying the Hlur site, prove the copy is faithful:
#   node parity.js            (checks https://hlur.ai/baseline)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

DEST="/Users/siaklin/Documents/Claude/Projects/LLC/Hlur_Website/baseline"

echo "▶ guard first — only a green build may ship"
./selfcheck

mkdir -p "$DEST"
cp index.html data.js og.png "$DEST/"
echo "✓ synced index.html, data.js, og.png -> $DEST"
echo "  next: commit+deploy Hlur_Website, then run: node parity.js"
