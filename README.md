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
| `test/claims_harness.js` | **Property/oracle** harness: random scenarios against an independent oracle, so a wrong *sentence* can't hide behind a right *number*. |
| `test/features.runtime.js`, `test/return-loop.runtime.js` | Drive the real page in a browser: spaced repetition, path filtering, tally gating, Labs. |
| `test/_load.js` | Shared loader that runs the page's inline script headless — one copy, so the suites can't drift. |
| `test/invariants.js` | Repo-wide syntax / forbidden-marker / leaked-token sweep. |
| `crosscheck.js` | Renders the page in real Chrome (desktop/mobile × light/dark), checks layout + source⇄DOM parity, saves screenshots to `crosscheck_shots/`. |
| `layout.js` | Width, alignment and **desktop-vs-mobile structure** across 4 viewports; compares against `layout_baseline.json`. |
| `layout_baseline.json` | The committed layout fingerprint. Changing it is a reviewable diff, not a silent drift. |
| `visual.js` | **The visual pass, automated**: contrast / clipped text / overlapping controls / blank sections, plus a pixel diff of every section against `visual_ref/`. |
| `visual_ref/` | Approved reference images (11 sections × desktop + mobile). `node visual.js --update` re-approves. |
| `selfcheck` | Runs everything. |

## Can I trust the layout?

Not on anyone's word — run it. `crosscheck.js` measures the *container* and once passed
52/52 while the footer rendered its text in a 560px column inside a 1200px shell, using
under half the width the page had. `layout.js` exists because of that miss, and it fails
on that exact code. It checks, at 1440 / 1280 / 768 / 390 px:

1. **One column** — every content container shares one left edge and width. Anything
   deliberately narrower must be declared in `NARROW_BY_DESIGN` *with a reason*, and an
   exemption that stops being narrow is reported as stale.
2. **Text fill** — no long paragraph renders under 55% of the box it sits in. Grid cells
   are measured against their own column, so a real 3-up layout isn't a false alarm.
3. **No horizontal overflow.**
4. **Structure lock** — content widths and grid column counts are compared to
   `layout_baseline.json`. If an edit turns the topic cards from 2-up to 1-up on desktop,
   or the footer from 3 columns to 1, the run **fails** and names the change. Accepting a
   change is deliberate: `node layout.js --update`, which shows up in the diff.

Point 4 is the answer to "how do I know an update didn't break the desktop or mobile
structure?" — you don't take my word for it, you re-run the harness and read the diff.

## Does it still *look* right?

`visual.js` answers that without anyone opening a PNG:

- **Defect scans** (no reference needed, so they can fail on a first run): text below its
  WCAG contrast minimum, text clipped by its own box, overlapping tap targets, sections
  that render tall but empty.
- **Pixel diff**: each of 11 sections × desktop + mobile is compared to an approved image
  in `visual_ref/`. Dates and shuffles are pinned before page load so runs are identical;
  a real change fails the run, names the section and the changed region, and writes
  before/after crops to `visual_diff/`.

Both layers were **falsified before being trusted**: a 4px padding change and a subtle text
colour change each make it fail; the unchanged page diffs 0.00%. Its own first run produced
54 contrast "failures" that were all the harness's bugs — gradient backgrounds, and
`color(srgb 0.96 …)` values parsed as if they were 0–255. Those are fixed; the 54 became a
real, smaller finding (accent blue and tertiary grey fell below 4.5:1 on tinted panels),
which is why `--accent` and `--text-ter` are slightly deeper than they used to be.

What it still cannot do: tell you the design is *good*. It tells you the design is what you
last approved, and that it breaks no objective rule.

## Are the *sentences* true?

Tests check arithmetic; they do not check English, and a correct number inside a false
sentence passes everything else here — that already happened once, when the footer claimed
the page "counts two things" while the code sent four.

`test/claims_harness.js` runs **random** scenarios (400 schedule cases, 200 monotonicity
cases, 16 hostile storage payloads) and asserts invariants no single example can cement:
the chip text always matches what was stored, a wrong answer can never say "locked in", a
correct answer never makes things worse, and untrusted storage can never produce a count
the page cannot justify. **The oracle is re-declared inside the harness, never imported** —
a shared constant would be a shared bug.

It was falsified before being trusted: changing the schedule from 7 to 8 days, granting
un-spaced wins, or dropping the de-dup guard each make it fail, and it names which
invariant broke.

## Verifying it

Everything is offline and needs only Node + (for `--full`) system Google Chrome.
No `npm install` — all Node built-ins.

```sh
./selfcheck          # fast, offline: static + units + invariants  (safe for pre-commit)
./selfcheck --full   # also renders in headless Chrome: crosscheck + layout, saves screenshots
./selfcheck --live   # fetches the deployed site and checks it matches local source
```

**Every UI change should run `./selfcheck --full`**, which is the three-way cross-check:
source (`verify.js`) ⇄ rendered desktop and mobile geometry (`layout.js`) ⇄ rendered DOM
and pixels (`crosscheck.js`, which writes `crosscheck_shots/*.png` for a human to read).
Numbers matching is not the same as looking right — open the PNGs.

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
