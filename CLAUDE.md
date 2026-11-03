# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install     # install dependencies
npm run dev      # start Vite dev server
npm run build    # production build to dist/
npm run preview  # preview the production build locally
npm run deploy   # build then publish dist/ to the gh-pages branch
npm run build:artifact  # single-file page for claude.ai Artifact → dist-artifact/bv-prr-tool.html
```

There is no test suite and no lint script configured in this project.

### GitHub Pages deployment

`vite.config.js` hardcodes `base: "/bv-prr-tool/"` for GitHub Pages. If the repo is ever renamed/forked, update `base` to match the new repo name before deploying.

### claude.ai Artifact version

The same app is also published as a claude.ai Artifact (https://claude.ai/artifact/5MmrcvtQxVyRywVNqW5JzV, declared capabilities `sample` + `downloads`). `scripts/build-artifact.mjs` runs a Vite build with `base: "./"` and inlines the single JS chunk into one HTML file (no doctype/html/head/body — the platform adds them), dropping the `index.html` CSP meta (it would block the inline script) but keeping its `<style>` block. Republish that file to the same artifact URL after changes. `IN_CLAUDE_ARTIFACT` (true when `window.claude.use` exists at load) switches artifact-only behaviour: print buttons are hidden (`window.print()` does nothing in the viewer), the data export is saved as UTF-8 CSV via `claude.use("downloads")` (`.xls` is not on the download allowlist), and the Claude panel analyses inline (below).

## Architecture

This is a single-page Vite + React app with (deliberately) almost all logic in one file: `src/App.jsx` (~2100 lines). `src/main.jsx` only mounts `<App />`; there is no router and no other component files.

The app parses dialysis machine CSV logs (Shift_JIS encoded) and visualizes PRR (plasma refilling rate) alongside ΔBV, ultrafiltration, and blood pressure. Data flows through three stages, all inside `App.jsx`:

1. **`parseCsvBase(text, filename)`** — decodes the raw CSV (via `decodeBytes`, which falls back from Shift_JIS to UTF-8), locates relevant columns by header name (`findColumnIndex`), strips rows with the sentinel invalid value `-9999` in the PRR column, and auto-detects the valid treatment range via `autoDetectRange` (looks for a sharp PRR drop of more than 30, which signals end-of-treatment/sensor detachment). The result of this stage (a "base") is stored in React state per uploaded file and includes a mutable `rangeStart`/`rangeEnd` the user can adjust with sliders.
2. **`computeDerived(base)`** — takes a base plus its current `rangeStart`/`rangeEnd`, slices the rows, and computes all derived per-row values (PRR instantaneous/interval volume, ΔBV %, UF speed/volume, BP, a 50-sample ΔBV moving average) plus session-level stats (totals, min/max, Pearson correlations via `pearson()`). This is recomputed reactively via `useMemo` whenever the range sliders move, so it must stay cheap/pure.
3. Presentation — the rows/stats from step 2 feed Recharts components. Numeric columns are scaled integers in the source CSV (e.g. `dBV[%]*10`, `UF-volume[L]*100`) and must be divided down (`/10`, `/100`) at parse time; if you add a new column, follow the same pattern rather than doing the scaling in the UI layer.

Key state/UI concepts in `BVPRRAnalyzerApp`:
- Multiple CSVs can be loaded at once; each becomes a "base" with a generated `id`. `viewMode` switches between `"single"` (one file, full chart set), `"compare"` (overlaid charts across files, aligned by elapsed time since each session's start), and `"overall"` (aggregate stats/bar charts across sessions, plus the Claude.ai analysis panel).
- Session date/weekday is parsed from the filename itself via `sessionTimestampFromFilename` (expects a `YYYYMMDD_HHMMSS` pattern in the name); compare/overall views can filter by day-of-week using this.
- Patient identity (`patientId`/`patientLabel`) is read from the CSV data itself first: `patientNameFromCsvRow` reads column index 49 (spreadsheet column **AX**, the 50th column, 0-indexed) of the **header row (line 1 of the file)** — this is where the DCS-100NX dialysis machine's CSV export records the patient name. Confirmed against a real export (2026-08-12): the header row mixes column titles (indices 0–40) with fixed session metadata (device model, timestamp fields, patient name at 49, patient/device ID at 50); data rows (line 2 onward) are shorter (41 columns in the sample) and never reach index 49, so the patient name must be read from `header`, not from a data row. `generateDemoCsvText` mirrors this: the demo patient name lives only in the header line, not in every data row. If the header column is empty/absent, it falls back to `patientIdFromFilename`, which parses the filename prefix before the `YYYYMMDD_HHMMSS` pattern (e.g. `M1709234_20260701_085737.csv` → `M1709234`); if neither is available the label is "患者ID不明". Do not change `PATIENT_NAME_COLUMN_INDEX` without confirming the real column position with the user — it's a hardcoded spreadsheet-column assumption, not derived from a header name.
- All three view modes show a patient-selector tab row (only when 2+ distinct patients are loaded): single view's file list panel, and compare/overall above their weekday tab row. In compare/overall, selecting a patient first narrows `presentWeekdays` to that patient's own days, then the weekday tab narrows further; both combine into `sheetResults`, which drives the comparison table/charts, overall stats, Claude.ai analysis prompt, and PDF print header (`ReportHeader` meta). In single view, selecting a patient filters `singleVisibleResults` (the file list) and auto-switches `activeId` to a file for that patient if the current selection falls outside the filter. The single-view file list also tags each entry with `[patientId]` whenever multiple patients are loaded and no single-patient filter is active.
- `generateDemoCsvText` mirrors the real column layout: only the header line pads its 10 meaningful column titles with filler columns out to index 49 (AX) and places the demo patient name there; data rows stay at 10 columns, same as real DCS-100NX exports, keeping the demo data on the exact same code path as production files.
- Chart order within the single view is user-draggable and tracked in `chartOrder` state (chart panels render with a CSS `order` from `chartOrder.indexOf(id)`).
- Missing columns (e.g. no BP data in a given CSV) don't error — `hasDbv`/`hasUf`/`hasBp` flags gate each chart/stat independently so partial data still renders what it can.

### Claude analysis (`buildClaudeAnalysisPrompt` / `runInlineAnalysis` / `analyzeWithClaude`)

`buildClaudeAnalysisPrompt(sessions)` (module-level, pure) builds a Japanese analysis-request prompt from the per-session summary values of `sheetResults` (patient names replaced with pseudonyms 患者A/患者B…, keyed by `patientId` or the session `id` when unresolved; data embedded as a compact CSV table, not JSON, to keep the URL short — CSV header names must not contain commas). The overall view's Claude panel then works in one of two modes:

- **Inline (claude.ai Artifact)**: when `window.claude.use("sample")` resolves a function, "Claude で分析する" calls it on the viewer's own Claude account (`modelTier: "default"`, 5-minute cache; "もう一度分析する" passes `refresh: true`), streams the answer into `analysis.text` via `onText`, offers a Stop button (AbortController in `analysisCtlRef`), and renders the Markdown with `MarkdownView` (a small React renderer — headings, lists, tables, bold/code; never `dangerouslySetInnerHTML`). The finished answer is also printed in the overall PDF report (`.report-analysis`). Error codes map to messages in `sampleErrorInfo`; `not_granted`/`sampling_disabled`/etc. set `sampleUnavailable`, which falls back to the second mode.
- **Open claude.ai (GitHub Pages, or fallback)**: `analyzeWithClaude` opens `https://claude.ai/new?q=<encoded prompt>` in a new tab so the prompt is prefilled. If the URL exceeds `CLAUDE_PREFILL_URL_MAX` (14000 chars; ~50 sessions fit), it opens `claude.ai/new` without `q` and relies on the clipboard copy instead (`claudeStatus` = `"paste"`, or `"paste-manual"` with the prompt textarea shown if the clipboard write failed). The clipboard write is started before `window.open` (the page must still have focus) and `window.open` is called synchronously in the click handler to avoid popup blockers.

"送る内容を確認" shows exactly what will be sent. Prompt/status/analysis are reset (and a running analysis aborted) whenever `sheetResults` changes.

### PDF report (browser print)

PDF export is `window.print()`; all print layout lives in the `<style>` block of `index.html`. Each view wraps its printable content in `.report-print-area`; everything else is `display: none` in print (not `visibility: hidden`, which leaves blank trailing pages), and ancestors of the report area (selected via `:has(.report-print-area)`) have their screen padding/flex layout removed. `ReportHeader` (title + metadata grid: patient/date/range/file or target patients/weekday/period/count) and `ReportFooter` (disclaimer) are `.print-only` components. Print rules worth knowing:
- Everything inside the report is forced to white background / dark text with `!important`, so a colour swatch must be drawn as SVG `fill` (see the compare table), not CSS `background`.
- Charts are rendered at screen width; print CSS scales `.recharts-wrapper > svg.recharts-surface` to 100% width (keep the `>` — legend icons are also `svg.recharts-surface`). Axis text drawn with `fill="#FFFFFF"` for the dark screen theme is recoloured grey for print.
- Chart panels, tables and rows use `break-inside: avoid`; page size/margins and the page-number footer are in `@page`.
- To check print output, render with Playwright: `emulateMedia({ media: "print" })` then `page.pdf({ format: "A4" })` after loading the demo data.
