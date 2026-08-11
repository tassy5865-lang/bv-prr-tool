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
- Patient identity (`patientId`/`patientLabel`) is read from the CSV data itself first: `patientNameFromCsvRow` reads column index 49 (spreadsheet column **AX**, the 50th column, 0-indexed) of the **header row (line 1 of the file)** — this is where the DCS-100NX dialysis machine's CSV export records the patient name. Confirmed against a real export (2026-08-12): the header row mixes column titles (indices 0–40) with fixed session metadata (device model, timestamp fields, patient name at 49, patient/device ID at 50); data rows (line 2 onward) are shorter (41 columns in the sample) and never reach index 49, so the patient name must be read from `header`, not from a data row. `generateDemoCsvText` mirrors this: the demo patient name lives only in the header line, not in every data row. If the header column is empty/absent, it falls back to `patientIdFromFilename`, which parses the filename prefix before the `YYYYMMDD_HHMMSS` pattern (e.g. `M1709234_20260701_085737.csv` → `M1709234`); if neither is available the label is "患者ID不明". Do not change `PATIENT_NAME_COLUMN_INDEX` without confirming the real column position with the user — it's a hardcoded spreadsheet-column assumption, not derived from a header name.
- All three view modes show a patient-selector tab row (only when 2+ distinct patients are loaded): single view's file list panel, and compare/overall above their weekday tab row. In compare/overall, selecting a patient first narrows `presentWeekdays` to that patient's own days, then the weekday tab narrows further; both combine into `sheetResults`, which drives the comparison table/charts, overall stats, AI-prompt generator, and PDF print header (`scopeLabel`). In single view, selecting a patient filters `singleVisibleResults` (the file list) and auto-switches `activeId` to a file for that patient if the current selection falls outside the filter. The single-view file list also tags each entry with `[patientId]` whenever multiple patients are loaded and no single-patient filter is active.
- `generateDemoCsvText` mirrors the real column layout: only the header line pads its 10 meaningful column titles with filler columns out to index 49 (AX) and places the demo patient name there; data rows stay at 10 columns, same as real DCS-100NX exports, keeping the demo data on the exact same code path as production files.
- Chart order within the single view is user-draggable and tracked in `chartOrder` state (chart panels render with a CSS `order` from `chartOrder.indexOf(id)`).
- Missing columns (e.g. no BP data in a given CSV) don't error — `hasDbv`/`hasUf`/`hasBp` flags gate each chart/stat independently so partial data still renders what it can.

### AI analysis prompt generator (`generateAnalysisPrompt`)

The "overall" view has a button that builds a detailed Japanese analysis-request prompt from the session summary data entirely client-side (no API calls, no key) and displays it in a read-only textarea with a clipboard-copy button (`copyPrompt`). The user pastes the generated prompt into any AI chat (ChatGPT, Claude, etc.) themselves to get the analysis. This works identically on GitHub Pages and any other host, unlike the earlier direct-API-call version.
