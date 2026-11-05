# School Paper Organizer: local AI version

> **Retired 2026-11-05.** The family switched back to the Google Apps Script +
> Claude version in `../apps-script/`; everything learned here was ported to it.
> This folder is kept for reference.

Runs on this Windows PC. A scanned PDF dropped into the `SchoolWork` folder is
read page by page by a **local** vision model (Ollama, `qwen2.5vl:32b`), so
scans never go to an AI service. The output goes into folders, Google Drive
(through Google Drive for desktop) and Gmail.

It started as a port of the Apps Script version in `../apps-script/` and has
grown since. The two are now separate: nothing here reads or needs those files.

## What it does with a scan

1. **Sort each page** (`spo/classify.py`) into homework_sheet,
   spelling_word_sheet, informational_flyer, school_work, other or unknown.
2. **Read the details** (`spo/stage2.py`, prompts in `spo/stage2_prompts.json`):
   - **Homework sheet:** the week, homework per day, notes and events.
     **Upcoming tests** are then re-read box by box from the sheet's grid
     (`spo/assessment_grid.py`). Code finds the table lines, so each test's
     day comes from the column it sits in. The date is Monday of the
     sheet's week + that day, +7 days for "next week" (`spo/assessments.py`).
   - **Flyers:** events for this student's grade and class.
   - **Spelling sheets:** the word list, with the words that need practice.
   - **Current homework:** finds which worksheet pages match today's homework
     on the sheet.
   - Event dates with no year printed are put in the coming year when the
     model guesses an old one (`assessments.resolve_year`).
3. **File and notify** (`spo/pipeline.py`):
   - Writes the PDFs into `School Papers/` (Homework Sheets, Homework,
     Informational Flyers, Spelling Sheets, `Subjects/<Subject>`) and saves
     an analysis JSON in `Results/`.
   - Emails each new event with an .ics invite, plus one "Upcoming tests"
     email with an invite per test. Events it has already seen, even when
     worded differently, aren't emailed again (`spo/events.py`).
   - Emails "This week's spelling words". Replying with corrections
     (`18 = garage`) fixes the word file (`spo/spelling.py`).
4. **Copy to Google Drive** (`spo/folder_sync.py`): copies the output into
   `G:\My Drive\School Papers (PC)`. It only adds and updates files, never
   deletes.

## Where things are

| What | Where |
|---|---|
| Drop scans here | `SchoolWork\*.pdf` (not subfolders). Originals are never changed, moved or deleted. |
| Output | `SchoolWork\Local Test\School Papers\` |
| State (scans, events, spelling, manifest) | `SchoolWork\Local Test\state.sqlite` |
| Log | `SchoolWork\Local Test\watcher.log` |
| Emails saved when no Gmail credential is set | `SchoolWork\Local Test\Test Emails (not sent)\` |
| Gmail app password | Windows Credential Manager, generic credential `School Paper Organizer Gmail` |
| Code / tests | `local\spo\`, `local\tests\` |
| History: migration plan, spike | `local\docs\`, `local\spike\` |

## Running it

It runs all the time on its own: the Task Scheduler task
**"School Paper Organizer - scan watcher"** starts
`local\.venv\Scripts\pythonw.exe -m spo.cli watch` at logon and checks
every 5 minutes that it's still running. Only one watcher can run at a time.

By hand, from the `local` folder:

```
.venv\Scripts\python.exe -m spo.cli process-inbox    # one pass over new scans, then exit
.venv\Scripts\python.exe -m spo.cli email-status     # real Gmail or test mode?
.venv\Scripts\python.exe -m spo.cli test-email
.venv\Scripts\python.exe -m spo.cli check-replies    # apply spelling replies now
.venv\Scripts\python.exe -m spo.cli resend-spelling "..\Local Test\School Papers\Results\<file>-analysis.json"
.venv\Scripts\python.exe -m spo.cli drive-sync       # copy to Google Drive now
.venv\Scripts\python.exe -m pytest -q                # tests
```

To restart the watcher after a code change, run this in PowerShell:

```
Stop-ScheduledTask -TaskName "School Paper Organizer - scan watcher"
Get-Process pythonw -ErrorAction SilentlyContinue | Stop-Process
Start-ScheduledTask -TaskName "School Paper Organizer - scan watcher"
```

## Needs

Python 3.12 venv in `local\.venv` (ollama, pymupdf, jsonschema, numpy,
keyring, tzdata, google-api-python-client), and Ollama with
`qwen2.5vl:32b`. Ollama, OneDrive and Google Drive for desktop all start
at logon.
