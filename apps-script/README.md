# School Paper Organizer: Google Apps Script + Claude version

> **Live again since 2026-11-05.** The family switched back from the local
> AI version (`../local/`, now retired) to this one. Everything the local
> version added was ported back: spelling word files with corrections by
> email reply, final-test detection, worksheet-ID and page-number homework
> checks, the Logic title rule, ordinal week dates, the event-year fix, the
> not-from-school rule, Original Scans and Spelling Words folders, and
> safer error handling. See "Added 2026-11-05" below. The pre-port code is
> in `../apps-script backup before port (2026-11-05).zip`.
>
> Run `clasp` from inside this folder (`.clasp.json` and `.claspignore` are
> here). Checks: `node tests/run-tests.js` (fake Google services, no network).

A Google Apps Script that turns a folder of scanned school-paper PDFs into
structured, useful output: it classifies each page with Claude, pulls out
homework assignments, calendar events, and spelling words, figures out which
worksheet is *actually* tonight's homework (vs. old graded work or in-class
practice), splits the PDF into per-category files in Drive, and emails you
digests and calendar (.ics) invites.

Drop a scanned PDF into an "Inbox" Drive folder; a time-based trigger (or a
manual run) picks it up, sends it to Claude, and does the rest.

## How it works

Each PDF goes through three stages (`processOneInboxFile_` in `Main.gs`):

**Stage 1 — page classification** (`Anthropic.gs`)
Claude looks at every page of the PDF and classifies it into one of:
`homework_sheet` (the weekly homework manifest/grid), `spelling_word_sheet`,
`informational_flyer`, `school_work` (class practice, completed/graded work,
tests), `other`, or `unknown`. This stage never assigns "current homework" —
that's decided later, once the current week's manifest is known.

**Stage 2 — extraction and homework matching** (`spoEnrichAnalysis_` in
`Main.gs`, plus `HomeworkExtraction.gs`, `FlyerExtraction.gs`,
`SpellingExtraction.gs`, `HomeworkMatching.gs`)
- Any `homework_sheet` pages are parsed into a structured weekly manifest
  (Monday–Friday assignments, assessments, events) and saved as the current
  authoritative manifest (`HomeworkManifest.gs`, kept in Script Properties).
- Any `informational_flyer` pages have their calendar-worthy events pulled
  out, filtered to the configured student's grade/class.
- Any `spelling_word_sheet` pages have their word list extracted, with
  teacher corrections marked as `needs_work`.
- Finally, every remaining page is checked against *today's* entry in the
  current homework manifest to decide if it's actually current homework —
  as opposed to a `Class Practice`/`Classwork` page that happens to share a
  worksheet packet's serial code with a real homework page, or an old,
  already-graded assignment that was returned to the student.

**Stage 3 — output** (`Processors.gs`)
- Pages are grouped by category and split into separate PDFs
  (`PdfSplitter.gs`, via an external Cloud Run helper — see below) and
  filed into the matching Drive folder. Informational flyers each get their
  own PDF named from their extracted title, not a generic date.
- Every worksheet page (class work, current homework, spelling tests) is
  also copied into `Subjects/<Subject>`, one PDF per subject per scan
  (`Subjects.gs`). The page's subject is normalized ("Mathematics" → Math,
  "Patterns" → Logic); a page with two subjects ("Grammar / Spelling") is
  copied into both; an unrecognized subject gets a new folder; a worksheet
  with no subject goes to `Subjects/Unsorted`.
- Calendar events (from homework sheets and flyers) are emailed as `.ics`
  attachments (`Ics.gs`). Every event, including review-only ones, is
  recorded in the Events sheet, which is the list of known events. A later
  mention of a known event sends no email, even when it's worded
  differently ("Dress Up Day" / "Halloween Dress-Up Day") or comes from a
  different paper (`EventMatching.gs`). Repeats that were skipped are noted
  in the Log sheet. A mention that adds a start time, or that gives a
  usable date for a review-only event, is sent as UPDATED.
- Upcoming tests from the homework sheet's "this week" / "next week"
  assessment lists are emailed together as one "Upcoming tests" email with
  an all-day `.ics` per test (`Assessments.gs`). The date is resolved from the
  sheet's week plus the printed weekday; tests already emailed are skipped,
  and any test whose date can't be resolved is listed for review instead.
- Spelling sheets: a new week's list (the pre-test) becomes a batch
  (SpellingBatches sheet), a `Spelling Words/MM-DD-YYYY-spelling-words.txt`
  file and one "This week's spelling words (MM-DD-YYYY)" email. Unclear words
  show as `???`; replying "18 = garage" (or "18 ok") fixes the file and gets
  a confirmation in the same thread (`checkSpellingReplies`, run at the end
  of every `processInbox`). The same list scanned again within 14 days is
  the final test: filed as `-spelling-test.pdf` / `-spelling-test.txt`, no
  email (`Spelling.gs`, `SpellingBatches.gs`).
- An unchanged copy of every scan goes to `Original Scans`.
- Homework assignment rows are appended to the state spreadsheet.
- The full analysis JSON is saved to a Results folder.
- A record of the scan (content hash, status, generated file IDs) is
  written to the Scans sheet, which drives de-duplication.

## Drive layout

Created automatically by `setupProject()` under a root folder (default
"School Papers"):

| Folder | Contents |
|---|---|
| Inbox | Drop scanned PDFs here. Originals are **never** renamed, moved, or modified. |
| Homework Sheets | The weekly homework manifest pages |
| Homework | Pages matched as *current* homework |
| Informational Flyers | One PDF per flyer, named from its extracted title |
| Spelling Sheets | Spelling word list pages |
| Subjects | One subfolder per subject (Math, Grammar, Spelling, …), created on demand. Copies of worksheet pages, including homework and spelling tests. |
| Results | One analysis JSON per scan |
| Original Scans | `MM-DD-YYYY-original-scan.pdf`, the scan as uploaded |
| Spelling Words | Word lists (`-spelling-words.txt`) and final-test results (`-spelling-test.txt`) |

## State spreadsheet

Created automatically by `setupProject()` (title "School Paper Organizer
State"), with sheets:

| Sheet | Purpose |
|---|---|
| Scans | One row per scan attempt: content hash, file id/name, status (`processed`/`duplicate`/`error` = will retry/`failed` = won't retry), and the Drive IDs of everything that scan generated. Drives de-dup. |
| Events | De-dup ledger for calendar events (by title+date+time signature), so the same event isn't emailed twice. |
| SpellingWords | Running practice-word history (word, first/last seen, active). Shared/merged across scans — see "Rewinding a scan" below. |
| Homework | One row per extracted homework assignment. |
| Log | Freeform run log. |
| SpellingBatches | One row per week's spelling list: words (JSON), its words file, scan date. Numbering continues the PC version's. |
| EmailMessages | Spelling emails we sent and replies already handled, so each reply is applied once. |

## Configuration (Script Properties)

Set these in the Apps Script editor under **Project Settings → Script
Properties** before running `setupProject()`.

Required:

| Property | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `NOTIFICATION_EMAIL` | Where digests/calendar emails get sent |

Optional:

| Property | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used for all extraction calls |
| `STUDENT_GRADE` | `First Grade` | Used to filter multi-grade flyer events down to this student's events |
| `STUDENT_CLASS` | `206` | Same, for class-specific events |
| `ROOT_FOLDER_ID` | (creates "School Papers") | Use an existing Drive folder as the root instead |
| `PDF_SPLITTER_URL` / `PDF_SPLITTER_TOKEN` | (unset) | Optional Cloud Run service that actually splits PDF pages — without it, category PDFs aren't generated but everything else (emails, sheet rows) still works |

Event times are **always** forced to `America/Los_Angeles` regardless of the
Apps Script project's own timezone setting (see `Config.gs`) — this is
hardcoded, not a property, since the school is in California.

## Setup

1. **Create the Apps Script project** (if you don't already have one) and
   note its script ID, or use the existing one referenced in
   `.clasp.json`.
2. Install [`clasp`](https://github.com/google/clasp) and log in:
   ```
   npm install -g @google/clasp
   clasp login
   ```
3. Push the source:
   ```
   clasp push
   ```
4. In the Apps Script editor, open **Project Settings → Script Properties**
   and set at least `ANTHROPIC_API_KEY` and `NOTIFICATION_EMAIL` (see table
   above for optional ones).
5. Run `setupProject` once (select it from the function dropdown and click
   Run). This creates the Drive folders and the state spreadsheet, and
   prints their URLs to the execution log. Google will prompt you to
   authorize the required scopes (Drive, Sheets, external requests,
   Gmail send, script triggers) — accept them.
6. (Optional but needed for split PDFs) Deploy the Cloud Run PDF-splitter
   service and set `PDF_SPLITTER_URL` / `PDF_SPLITTER_TOKEN`.
7. Run `installInboxTrigger` once to install a 5-minute recurring trigger
   that calls `processInbox`. (`deleteInboxTriggers` removes it.)
8. Drop a PDF into the Inbox folder and either wait for the trigger or run
   `processInbox` manually to test.

Re-running `setupProject()` later (e.g. after pulling an update that adds a
new state-sheet column) is safe — it only fills in whatever's missing.

## Manual operations

Run these from the Apps Script editor's function dropdown:

- **`processInbox`** — process up to `MAX_FILES_PER_RUN` (default 5) new
  PDFs sitting in the Inbox. This is what the installed trigger calls.
- **`retryErrors`** — alias for `processInbox`. Temporary errors (Claude
  busy, network) are retried automatically. A scan that `failed` for another
  reason is emailed about once ("PROBLEM: couldn't process ...") and not
  retried, so it can't run up the bill; upload a corrected copy, or use
  `forceReprocessFile`. A bad API key or empty credit balance is retried and
  emailed about at most once a day.
- **`checkSpellingReplies`** — apply spelling corrections sent by reply now.
- **`forceReprocessFile(fileNameOrId)`** — full "rewind and redo" for a
  botched scan. Trashes every Drive file that scan generated, deletes its
  Homework and Events rows, and clears its Scans record, so the next
  `processInbox` run reprocesses it from scratch. The Apps Script editor
  can't pass arguments to Run, so edit the file name inside the
  `forceReprocessScratch_()` wrapper in `Main.gs` and run that instead.
  **Not** rewound: SpellingWords rows, since a word can be touched by
  multiple scans over time and blindly deleting "this scan's" rows could
  erase one that predates it — instead, any words that scan last touched
  are logged so you can review them by hand.
- **`showConfiguration`** — prints the resolved config (secrets redacted).
- **`debugCurrentHomeworkManifest`** — prints the currently stored weekly
  homework manifest.

## Design notes / gotchas

- **Classwork vs. homework**: many worksheet packets print a "Class
  Practice"/"Classwork" page and a "Homework" page that share the exact
  same serial code. The homework-matching prompt is explicitly told a
  matching serial code alone is not enough — the page's own printed
  heading always wins.
- **De-duplication** is two-layered: by Drive `file_id` and by SHA-256
  content hash, so the same bytes uploaded under a different name are
  still caught.
- **Scan date** comes from the filename first (`MM-DD-YYYY` or
  `YYYY-MM-DD` pattern), falling back to the file's Drive creation time
  only if no date pattern is found. If you're uploading a backlogged scan,
  make sure the filename reflects the date the papers are actually from,
  not the day you're scanning them.

## Added 2026-11-05 (ported back from the local version)

- **Homework double-checks** (`HomeworkMatching.gs`): a model "yes" is
  overruled when the page's code has worksheet identifiers (`WS 55`, `MF55`;
  `G1` = grade is ignored) and none equals the assignment's, or when the code
  is a bare workbook page number ("106") that the assignment's pages
  ("pages 105", "pp. 105-106") don't include.
- **Right week's homework sheet** (`HomeworkManifest.gs`): the last 4 sheets
  are kept and the one whose printed week contains the scan date is used.
  The next week's sheet often comes home Thursday/Friday; with no sheet for
  the week, matching is skipped instead of using an old week.
- **Logic title rule** (`Subjects.gs`): titles with pattern/puzzle/logic also
  go in Logic.
- **Dates** (`Assessments.gs`): ordinal week text ("November 2nd – November
  6th") and `spoResolveYear_` (a date with no printed year gets the first year
  not more than 60 days before the scan) for homework-sheet and flyer events.
- **Prompts**: the stage-1 not-from-school rule (a bill or recipe is `other`)
  and a homework-sheet layout note so tests land under the right weekday.
- **Seed** (`SeedFromLocal.gs`, made by `tools/make_seed.py`): `setupProject()`
  once carries over the PC version's homework sheet, spelling batches, handled
  replies and practice words.
- **Model**: `claude-sonnet-5-5` (same price as `claude-sonnet-5`);
  `setupProject()` moves an `ANTHROPIC_MODEL` of `claude-sonnet-5` to it.
- **Scopes**: Gmail (`https://mail.google.com/`, for sending spelling emails as
  drafts and reading replies) and `userinfo.email`. The first run after the
  update asks for permission again.
