# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install     # install dependencies
npm run dev      # start Vite dev server
npm run build    # production build to dist/
npm run preview  # preview the production build locally
npm run deploy   # build then publish dist/ to the gh-pages branch
```

There is no test suite and no lint script configured in this project.

### GitHub Pages deployment

`vite.config.js` hardcodes `base: "/bv-prr-tool/"` for GitHub Pages. If the repo is ever renamed/forked, update `base` to match the new repo name before deploying.

## Architecture

This is a single-page Vite + React app with (deliberately) almost all logic in one file: `src/App.jsx` (~2100 lines). `src/main.jsx` only mounts `<App />`; there is no router and no other component files.

The app parses dialysis machine CSV logs (Shift_JIS encoded) and visualizes PRR (plasma refilling rate) alongside ΔBV, ultrafiltration, and blood pressure. Data flows through three stages, all inside `App.jsx`:

1. **`parseCsvBase(text, filename)`** — decodes the raw CSV (via `decodeBytes`, which falls back from Shift_JIS to UTF-8), locates relevant columns by header name (`findColumnIndex`), strips rows with the sentinel invalid value `-9999` in the PRR column, and auto-detects the valid treatment range via `autoDetectRange` (looks for a sharp PRR drop of more than 30, which signals end-of-treatment/sensor detachment). The result of this stage (a "base") is stored in React state per uploaded file and includes a mutable `rangeStart`/`rangeEnd` the user can adjust with sliders.
2. **`computeDerived(base)`** — takes a base plus its current `rangeStart`/`rangeEnd`, slices the rows, and computes all derived per-row values (PRR instantaneous/interval volume, ΔBV %, UF speed/volume, BP, a 50-sample ΔBV moving average) plus session-level stats (totals, min/max, Pearson correlations via `pearson()`). This is recomputed reactively via `useMemo` whenever the range sliders move, so it must stay cheap/pure.
3. Presentation — the rows/stats from step 2 feed Recharts components. Numeric columns are scaled integers in the source CSV (e.g. `dBV[%]*10`, `UF-volume[L]*100`) and must be divided down (`/10`, `/100`) at parse time; if you add a new column, follow the same pattern rather than doing the scaling in the UI layer.

Key state/UI concepts in `BVPRRAnalyzerApp`:
- Multiple CSVs can be loaded at once; each becomes a "base" with a generated `id`. `viewMode` switches between `"single"` (one file, full chart set), `"compare"` (overlaid charts across files, aligned by elapsed time since each session's start), and `"overall"` (aggregate stats/bar charts across sessions, plus the AI analysis panel).
- Session date/weekday is parsed from the filename itself via `sessionTimestampFromFilename` (expects a `YYYYMMDD_HHMMSS` pattern in the name); compare/overall views can filter by day-of-week using this.
- Chart order within the single view is user-draggable and tracked in `chartOrder` state (chart panels render with a CSS `order` from `chartOrder.indexOf(id)`).
- Missing columns (e.g. no BP data in a given CSV) don't error — `hasDbv`/`hasUf`/`hasBp` flags gate each chart/stat independently so partial data still renders what it can.

### AI analysis prompt generator (`generateAnalysisPrompt`)

The "overall" view has a button that builds a detailed Japanese analysis-request prompt from the session summary data entirely client-side (no API calls, no key) and displays it in a read-only textarea with a clipboard-copy button (`copyPrompt`). The user pastes the generated prompt into any AI chat (ChatGPT, Claude, etc.) themselves to get the analysis. This works identically on GitHub Pages and any other host, unlike the earlier direct-API-call version.
