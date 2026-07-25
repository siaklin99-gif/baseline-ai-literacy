#!/usr/bin/env bash
# ============================================================
# Sync Baseline into the Hlur website (hlur.ai/baseline).
#   ./sync_hlur.sh              copy only  (then deploy by hand)
#   ./sync_hlur.sh --deploy     copy + verify + deploy + commit + prove live
# ------------------------------------------------------------
# THIS repo (AI_Technology) is the single source of truth.
# The copy inside Hlur_Website/baseline/ is a build artifact —
# never edit it there. This script refuses to sync unless the
# local guard passes, so a broken build can't reach hlur.ai.
#
# --deploy runs the whole chain and STOPS at the first red
# (set -e), so a broken build can never reach hlur.ai:
#   selfcheck -> copy -> host-site harnesses -> netlify deploy
#   -> commit the artifact -> parity.js against the live URL
#
# Note: baseline has TWO homes and one file serves both —
#   hlur.ai/baseline/            (this sync, Netlify)
#   siaklin99-gif.github.io/...  (git push, GitHub Pages)
# so the chrome must stay path-portable: no "../" links, the
# orbit mark is inlined, and site links are absolute hlur.ai.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

DEST="/Users/siaklin/Documents/Claude/Projects/LLC/Hlur_Website/baseline"
SITE="$(dirname "$DEST")"
DEPLOY=0
[[ "${1:-}" == "--deploy" ]] && DEPLOY=1

echo "▶ guard first — only a green build may ship"
./selfcheck

mkdir -p "$DEST"
cp index.html data.js og.png "$DEST/"
echo "✓ synced index.html, data.js, og.png -> $DEST"

if [[ $DEPLOY -eq 0 ]]; then
  echo "  next: ./sync_hlur.sh --deploy   (or commit+deploy Hlur_Website, then: node parity.js)"
  exit 0
fi

echo
echo "▶ host-site harnesses — baseline must not break hlur.ai"
( cd "$SITE" && node verify_home.js >/dev/null && echo "  ✓ verify_home" )
( cd "$SITE" && node visual_check.js >/dev/null && echo "  ✓ visual_check" )

echo
echo "▶ deploy hlur.ai"
( cd "$SITE" && netlify deploy --prod --dir . | grep -E 'Production URL|Website URL' )

echo
echo "▶ commit the build artifact"
( cd "$SITE" && git add baseline && \
  ( git diff --cached --quiet && echo "  (no artifact change to commit)" || \
    git commit -q -m "baseline: sync from AI_Technology (source of truth)" && echo "  ✓ committed" ) )

echo
echo "▶ prove the live copy is faithful"
node parity.js

echo
echo "✅ hlur.ai/baseline is live and verified."
echo "   (GitHub Pages copy updates separately: git push in this repo)"
