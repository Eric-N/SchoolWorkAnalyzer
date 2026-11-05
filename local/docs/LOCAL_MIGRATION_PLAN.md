# Plan: Move School Paper Organizer to a local pipeline on a Windows PC

> Historical plan (approved 2026-10-26, now built). Since 2026-11-01 the Apps Script
> `.gs` files it mentions are in `apps-script/`, and this file is in `local/docs/`.

## Context
Today the pipeline is a Google Apps Script. You drop a PDF into a Drive "Inbox" folder, a 5-minute trigger sends it to Claude, and the script sorts pages into Drive folders, sends emails with .ics invites and logs state to a Google Sheet.

The new design:
- Scans are saved on a **Windows PC with an NVIDIA GPU**.
- Dropping a PDF into a local folder starts analysis by a **fully local** vision model. Scans never go to a cloud model.
- Sorted output is uploaded to the same Drive folder layout with the **Drive API**.
- Notifications stay as **email with .ics attachments**, sent over SMTP.
- State moves to **local SQLite**.

The three-stage logic (classify → extract/match → output) and every prompt and schema are already proven. The job is to **port** them, not redesign them.

## Approach: a Python service in a new `local/` folder
Python fits best on Windows. It has good libraries for each piece: Ollama client, PyMuPDF, pypdf, watchdog, the Google API client, smtplib and sqlite3. The `.gs` files stay untouched until cutover.

```
local/
  pyproject.toml          # deps: ollama, pymupdf, pypdf, watchdog, google-api-python-client,
                          #       google-auth-oauthlib, tzdata (Windows needs it for zoneinfo)
  config.toml.example     # paths, model name, student grade/class, SMTP, Drive root id
  spo/
    config.py      <- Config.gs (SPO_DEFAULTS; timezone forced to America/Los_Angeles)
    llm.py         <- Anthropic.gs call plumbing: Ollama chat with format=<json schema>, retries, validation
    prompts.py     <- Prompt.gs preamble + spoBuildScanPrompt_ + prompts from each *Extraction.gs (copied verbatim)
    schemas.py     <- spoSchoolScanSchema_, spoHomeworkExtractionSchema_, flyer/spelling/matching schemas
    render.py      NEW: PDF -> per-page PNG (PyMuPDF, ~200 DPI); local models can't read PDFs directly
    classify.py    <- Stage 1 (spoAnalyzePdfWithClaude_, spoValidateAnalysis_)
    extract.py     <- HomeworkExtraction.gs, FlyerExtraction.gs, SpellingExtraction.gs
    matching.py    <- HomeworkMatching.gs + HomeworkManifest.gs (manifest stored in SQLite, not Script Properties)
    pipeline.py    <- Main.gs processOneInboxFile_ / spoEnrichAnalysis_, Processors.gs spoProcessAnalysis_
    split.py       <- PdfSplitter.gs, done locally with pypdf (the Cloud Run splitter is no longer needed)
    ics.py         <- Ics.gs (straight port: escaping, line folding, all-day vs timed, +1h default)
    notify.py      <- spoSendEmail_/spoSendEvent_/spoSendAssessmentEmail_ over SMTP (Gmail app password)
    assessments.py <- Assessments.gs date resolution (already ported + tested, 2026-10-29)
    subjects.py    <- Subjects.gs subject-folder normalization (already ported + tested, 2026-10-29)
    events.py      <- EventMatching.gs known-event matching (already ported + tested, 2026-10-29); state.py's events table uses it
    state.py       <- State.gs sheets -> SQLite tables: scans, events, spelling_words, homework, manifest, log
    drive_sync.py  NEW: mirror local output tree to Drive folders; store Drive file ids in scans table
    watcher.py     NEW: watchdog on Inbox; wait until file size is stable (scanner writes incrementally)
    cli.py         run-watcher | process <file> | reprocess <file> (forceReprocessFile) | show-config
  tests/           unit tests for ics, date parsing, schema validation; golden-file tests per stage
```

### Key design points
- **Model:** Ollama on Windows (CUDA) with a vision model, configurable by name. Start with Qwen2.5-VL 7B, which fits in 8–12 GB of VRAM at Q4 and is strong on document OCR. If you have ≥24 GB of VRAM, also benchmark a larger variant. Ollama's `format` parameter takes the existing JSON schemas, so structured output carries over.
- **Smaller calls than today:** Claude reads a whole PDF in one call. A local model does better with one page (or one homework sheet) per call. Stage 1 therefore classifies **page by page**, and stages 2–3 send only the relevant page images. The schemas stay the same; the results are merged in code.
- **Output stays the same:**
  - Local output tree: `School Papers/{Homework Sheets, Homework, Informational Flyers, Spelling Sheets, Subjects/<Subject>, Results}`.
  - Subject folders (added 2026-10-29): `spo/subjects.py` is already ported from `Subjects.gs` and tested. `pipeline.py`/`split.py` still need to write one PDF per subject per scan, and `drive_sync.py` must create `Subjects/<Subject>` folders on demand.
  - File names reuse `spoDateLabel_`, `spoSafeSlug_` and `spoVersionedName_`.
  - Inbox originals are never modified.
- **Drive sync:** OAuth installed-app flow with the narrow `drive.file` scope. Uploads go into the existing "School Papers" folder tree, looked up by name or by a configured root id. Uploads happen only after a scan finishes successfully, and each uploaded file id is recorded so `reprocess` can trash it, the same way `forceReprocessFile` works today.
- **Duplicate detection** stays two-layered: SHA-256 of the file contents plus the path/name. The scan date still comes from the filename first, then the file's creation time (`spoParseScanDate_`).
- **Runs at logon** through Windows Task Scheduler (`spo run-watcher`). A startup sweep picks up any files dropped while it wasn't running.

## How to start (order of work)
1. **Spike first. Accuracy is the biggest risk.**
   - Install Ollama on the PC and pull the model.
   - Write `render.py`, `llm.py` and `classify.py` only.
   - Run them on 5–10 past scans. Compare against the Claude results JSON already saved in the Drive **Results** folder, which serves as the ground truth.
   - Measure page-category accuracy and time per page.
   - Do the same for homework-sheet and spelling extraction, which are the hardest OCR tasks (grids, handwriting, teacher corrections).
   - If the 7B model falls short, try a larger model or a higher DPI before building anything else.
2. Port the deterministic pieces with unit tests: `ics.py`, `state.py` (SQLite), `split.py`, filename and date helpers.
3. Port the remaining stages (extraction, homework matching, manifest) and `pipeline.py`. Run end to end with an output folder and no email or Drive.
4. Add `notify.py` (SMTP) and `drive_sync.py`. Test against a scratch Drive folder first.
5. Add `watcher.py` and register it in Task Scheduler. Run it alongside the Apps Script for a week, then remove the Apps Script trigger with `deleteInboxTriggers`.

Optional housekeeping: run `git init` before starting. The project isn't under version control yet, and `.gitignore` already excludes `*.pdf`.

## Verification
- `pytest local/tests`: ICS output (folding, timed vs all-day), duplicate detection, schema validation, and golden-file comparisons of stage outputs against saved Claude Results JSON.
- `spo process <sample.pdf> --dry-run`: prints the analysis and planned files, emails and uploads without sending anything.
- End to end on the PC:
  1. Drop a known scan into Inbox.
  2. Check that the split PDFs appear locally and in the scratch Drive folder.
  3. Check that the email arrives and its .ics imports into Google Calendar with the correct Pacific time.
  4. Drop the same scan again under a new name and confirm it's skipped as a duplicate.
  5. Run `spo reprocess` and confirm the outputs are trashed and the scan is reprocessed.
