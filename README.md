# Baseline — reset your AI literacy

A single, lightweight, dependency-free web page that gives anyone — young or old,
technical or not — one calm baseline to understand AI, then go as deep as they want.
No build step, no framework, no server: open `index.html`.

## Files

| File | What it is |
|------|-----------|
| `index.html` | The whole site — HTML + CSS + vanilla JS, self-contained. |
| `data.js` | **The only file to edit when facts change** (models, prices, books). Each entry has an `asOf` date; the page stamps every card with its freshness. |
| `verify.js` | Static + data-shape + regression checks. |
| `test/functions.test.js` | Adversarial unit tests of the page's real functions (escaping, freshness math, malformed data). |
| `test/invariants.js` | Repo-wide syntax / forbidden-marker / leaked-token sweep. |
| `crosscheck.js` | Renders the page in real Chrome (desktop/mobile × light/dark), checks layout + source⇄DOM parity, saves screenshots to `crosscheck_shots/`. |
| `selfcheck` | Runs everything. |

## Verifying it

Everything is offline and needs only Node + (for `--full`) system Google Chrome.
No `npm install` — all Node built-ins.

```sh
./selfcheck          # fast, offline: static + units + invariants  (safe for pre-commit)
./selfcheck --full   # also renders in headless Chrome and saves screenshots
./selfcheck --live   # fetches the deployed site and checks it matches local source
```

Deployed via **GitHub Pages** from `main` (root). `parity.js` proves the live
site matches local: `data.js` must be byte-identical (SHA-256) and every key
structural marker in `index.html` must survive the deploy.

`selfcheck` exits non-zero if anything fails, and **fails closed** (a missing tool or
unreadable file blocks rather than passing). After `--full`, read the PNGs in
`crosscheck_shots/` by eye — numbers matching is not the same as looking right.

## Updating the facts (models / prices / books)

Edit `data.js` only. For each section:

1. Replace `html` (and the optional `list`) with current content.
2. Set `asOf` to the date you checked it (`"YYYY-MM-DD"`).
3. Set `source` / `sourceUrl` to where you verified it.

The page enforces honesty automatically:

- `asOf` empty → amber **"Needs live check"** (an honest blank, not a fake number)
- `asOf` older than 120 days → amber **"May be outdated"**
- `asOf` recent → quiet **"Verified &lt;date&gt;"** + source link

Text fields are HTML-escaped, so you can type `Q&A` or `C < D` safely. The `html`
field is the one place raw markup is allowed. A row missing its `name`/`plan`/`title`
key renders a visible "⚠ Malformed row" marker instead of silently vanishing —
and `node verify.js` catches it before you ship.

## Design intent

- **One signature mechanic:** *What is AI, in 10 layers* — a depth slider from one plain
  sentence to the honest floor ("it isn't thinking"). The reader chooses the depth;
  it's remembered across visits.
- **Progressive disclosure:** the remaining topics are tap-to-expand cards, filterable
  by theme, so the first glance is never a wall of text.
- **Honest about churn:** model/price data is deliberately band-level and dated rather
  than pinned to version numbers that go stale within weeks.
