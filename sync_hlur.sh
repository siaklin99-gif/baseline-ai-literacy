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

# DEST is overridable so CI runs THIS script rather than a duplicate in YAML.
# Locally it defaults to the checkout on this machine.
DEST="${DEST:-/Users/siaklin/Documents/Claude/Projects/LLC/Hlur_Website/baseline}"
SITE="$(dirname "$DEST")"
DEPLOY=0
[[ "${1:-}" == "--deploy" ]] && DEPLOY=1
# CI sets PUSH=1 to publish the artifact commit; locally you push when you choose.
PUSH="${PUSH:-0}"

echo "▶ guard first — only a green build may ship"
SELF_OUT="$(mktemp)"; trap 'rm -f "$SELF_OUT"' EXIT
./selfcheck | tee "$SELF_OUT"

# The hlur.ai homepage advertises this repo's check count ("Ships behind N automated
# checks"). That number goes stale every time a check is added, and a stale claim on a
# page about honesty is the worst place to have one. Compare it to what selfcheck just
# reported: warn on a plain sync, FAIL on --deploy (an untrue claim must not go live).
CHECKS="$(grep -oE '^[0-9]+ checks' "$SELF_OUT" | grep -oE '^[0-9]+' | awk '{s+=$1} END{print s+0}')"
CLAIMED="$(grep -oE 'Ships behind [0-9]+ automated checks' "$SITE/index.html" 2>/dev/null | grep -oE '[0-9]+' || true)"
if [[ -n "$CLAIMED" && "$CHECKS" -gt 0 && "$CLAIMED" != "$CHECKS" ]]; then
  echo
  echo "⚠  CLAIM DRIFT: hlur.ai homepage says \"$CLAIMED automated checks\"; selfcheck reports $CHECKS."
  echo "   Fix the Baseline card receipt in $SITE/index.html"
  if [[ $DEPLOY -eq 1 ]]; then
    echo "   Refusing to deploy an untrue claim. (Plain ./sync_hlur.sh only warns.)"
    exit 1
  fi
else
  [[ -n "$CLAIMED" ]] && echo "  ✓ homepage claim matches selfcheck ($CHECKS checks)"
fi

mkdir -p "$DEST"
cp index.html data.js og.png manifest.json sw.js icon-192.png icon-512.png "$DEST/"
echo "✓ synced index.html, data.js, og.png, manifest.json, sw.js, icons -> $DEST"

if [[ $DEPLOY -eq 0 ]]; then
  echo "  next: ./sync_hlur.sh --deploy   (or commit+deploy Hlur_Website, then: node parity.js)"
  exit 0
fi

echo
echo "▶ host-site harnesses — baseline must not break hlur.ai"
# Do NOT swallow stdout here. It was >/dev/null, so when verify_home failed in CI the
# step died with exit 1 and printed nothing at all — undiagnosable from the run log.
# Show the failing lines on failure, stay quiet on success.
run_harness() {  # run_harness <file>
  local out; out="$(cd "$SITE" && node "$1" 2>&1)" && { echo "  ✓ $1"; return 0; }
  echo "  ✗ $1 FAILED:"; echo "$out" | grep -aE '^FAIL|CHECK\(S\) FAILED|Error' | head -12 | sed 's/^/      /'
  return 1
}
run_harness verify_home.js
run_harness visual_check.js

echo
echo "▶ deploy hlur.ai"
# Publish _dist, NEVER the repo root. This said `--dir .`, which would have uploaded the
# whole private Hlur_Website repo — harnesses, the user-guide PDF, review notes, scripts —
# to a public URL. That is the exact leak Hlur_Website's own deploy.sh was rewritten to
# close, and this second deploy path still had it. The two paths must publish the same dir.
( cd "$SITE" && node build_dist.js | tail -1 )
# NETLIFY_SITE_ID/NETLIFY_AUTH_TOKEN are only needed in CI; locally the CLI is already
# logged in and reads .netlify/state.json, so both stay unset and this is a no-op.
( cd "$SITE" && netlify deploy --prod --dir _dist ${NETLIFY_SITE_ID:+--site "$NETLIFY_SITE_ID"} \
    | grep -E 'Production URL|Website URL' )

echo
echo "▶ commit the build artifact"
( cd "$SITE" && git add baseline && \
  ( git diff --cached --quiet && echo "  (no artifact change to commit)" || \
    ( git commit -q -m "baseline: sync from AI_Technology (source of truth)" && echo "  ✓ committed" ) ) && \
  if [[ "$PUSH" == "1" ]]; then git push -q origin HEAD && echo "  ✓ pushed"; fi )

echo
echo "▶ prove the live copy is faithful"
node parity.js

echo
echo "✅ hlur.ai/baseline is live and verified."
echo "   (GitHub Pages copy updates separately: git push in this repo)"
