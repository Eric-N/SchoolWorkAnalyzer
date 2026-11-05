"""One scan, end to end (Main.gs processOneInboxFile_ / spoEnrichAnalysis_ and
Processors.gs spoProcessAnalysis_), writing to a LOCAL output tree.

Output files are written under <root>/School Papers/ and then mirrored to
Google Drive by sync_drive() (drive_sync.py) once signed in. Email goes via
Gmail when a credential is stored, else to .eml files (mailer.py).
Scan contents are only ever analysed by the local Ollama server.
"""

import gc
import hashlib
import json
import re
import shutil
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pymupdf

from . import assessment_grid, assessments, classify, llm, render, spelling, stage2
from .assessments import assessment_events
from .ics import build_ics
from .mailer import Mailer
from .state import State
from .subjects import SUBJECTS_FOLDER_NAME, group_pages_by_subject

TIMEZONE = "America/Los_Angeles"  # forced, as in Config.gs

# A daily stack is ~5-25 pages. Anything far bigger is almost certainly the
# wrong file, and would tie up the model for hours.
MAX_PAGES = 60


class BadScan(Exception):
    """The file can't be (or almost certainly isn't) a school-paper scan."""


class TransientError(Exception):
    """Worth retrying later (e.g. Ollama isn't running)."""


def check_readable_scan(path: Path) -> None:
    try:
        doc = pymupdf.open(path)
    except Exception as e:
        raise BadScan("It isn't a readable PDF (it may be damaged, or not really a PDF).") from e
    with doc:
        if doc.needs_pass:
            raise BadScan("It's password-protected.")
        if doc.page_count == 0:
            raise BadScan("It has no pages.")
        if doc.page_count > MAX_PAGES:
            raise BadScan(f"It has {doc.page_count} pages; a school scan is normally under "
                          f"{MAX_PAGES}, so this looks like the wrong file.")
        try:
            doc[0].get_pixmap(dpi=20)
        except Exception as e:
            raise BadScan("Its pages can't be read (the PDF may be damaged).") from e

FOLDERS = {
    "inbox": "Inbox",
    "homework_sheets": "Homework Sheets",
    "homework": "Homework",
    "flyers": "Informational Flyers",
    "spelling": "Spelling Sheets",
    "subjects": SUBJECTS_FOLDER_NAME,
    "results": "Results",
    # LOCAL ADDITIONS (user request, 2026-11-02): the scan as dropped, and the
    # spelling word lists in their own top-level folder (out of Spelling Sheets).
    "originals": "Original Scans",
    "spelling_words": "Spelling Words",
}


@dataclass
class Settings:
    root: Path
    model: str
    num_ctx: int
    dpi: int = render.DEFAULT_DPI
    student_grade: str = "First Grade"
    student_class: str = "206"
    # Where scans are dropped. Locally that's the SchoolWork folder itself
    # (only *.pdf directly in it); the Drive-style Inbox folder is unused.
    inbox: Path | None = None

    def __post_init__(self):
        if self.inbox is None:
            self.inbox = self.folder("inbox")

    @property
    def papers(self) -> Path:
        return self.root / "School Papers"

    @property
    def outbox(self) -> Path:
        return self.root / "Test Emails (not sent)"

    @property
    def simulated_replies(self) -> Path:
        """Offline testing only: .eml "replies" read when no Gmail credential is stored."""
        return self.root / "Simulated Replies"

    def folder(self, key: str) -> Path:
        return self.papers / FOLDERS[key]

    def ensure_tree(self) -> None:
        """setupProject(): create every output folder up front."""
        for key in FOLDERS:
            self.folder(key).mkdir(parents=True, exist_ok=True)
        self.outbox.mkdir(parents=True, exist_ok=True)


# --- helpers ported from DriveUtils.gs / Processors.gs

def safe_slug(s) -> str:
    x = re.sub(r"^-|-$", "", re.sub(r"[^A-Za-z0-9]+", "-", str(s or ""))).lower()
    return (x or "event")[:60]


def date_label(iso: str) -> str:
    y, m, d = iso.split("-")
    return f"{m}-{d}-{y}"


def versioned_path(folder: Path, filename: str) -> Path:
    if not (folder / filename).exists():
        return folder / filename
    stem, dot, ext = filename.rpartition(".")
    stem, ext = (stem, dot + ext) if dot else (filename, "")
    for i in range(2, 1000):
        candidate = folder / f"{stem}-v{i}{ext}"
        if not candidate.exists():
            return candidate
    raise RuntimeError("Could not find an unused filename for " + filename)


def parse_scan_date(path: Path) -> str:
    """spoParseScanDate_: filename first, then the file's creation date (Pacific)."""
    from_name = classify.parse_scan_date_from_name(path.name)
    if from_name:
        return from_name
    created = datetime.fromtimestamp(path.stat().st_ctime, ZoneInfo(TIMEZONE))
    return created.strftime("%Y-%m-%d")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_pages(source: Path, pages: list[int], folder: Path, filename: str) -> Path:
    """PdfSplitter.gs, done locally. The source PDF is only read."""
    folder.mkdir(parents=True, exist_ok=True)
    out_path = versioned_path(folder, filename)
    with pymupdf.open(source) as src, pymupdf.open() as out:
        for p in sorted(set(pages)):
            out.insert_pdf(src, from_page=p - 1, to_page=p - 1)
        out.save(out_path)
    return out_path


def remove_work_dir(path: Path) -> None:
    """Delete a snapshot copy. Windows can hold a failed-to-open PDF briefly,
    so retry; whatever is left is swept by sweep_work_dirs() on next start."""
    for _ in range(5):
        gc.collect()  # drop any PyMuPDF document still holding the file
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return
        time.sleep(0.5)


class Pipeline:
    def sweep_work_dirs(self) -> None:
        """Remove snapshot copies left by a crash or a locked file."""
        for d in (self.s.root / ".work").glob("*"):
            remove_work_dir(d)

    def __init__(self, settings: Settings):
        self.s = settings
        self.s.ensure_tree()
        self.state = State(self.s.root / "state.sqlite")
        self.mailer = Mailer(self.s.outbox, self.s.simulated_replies)

    # --- inbox
    def new_inbox_files(self) -> list[Path]:
        """PDFs in the drop folder whose CONTENT hasn't been processed yet.

        Decided by hash, not name: a replaced same-name scan is new, and a
        renamed copy of a processed scan is not. Hashes are cached by
        (size, mtime) so polling stays cheap.
        """
        if not hasattr(self, "_hash_cache"):
            self._hash_cache: dict[Path, tuple[tuple[int, float], str]] = {}
        out = []
        self.already_processed: list[Path] = []  # for the watcher to mention
        for p in sorted(p for p in self.s.inbox.iterdir() if p.is_file() and p.suffix.lower() == ".pdf"):
            try:
                st = p.stat()
                key = (st.st_size, st.st_mtime)
                cached = self._hash_cache.get(p)
                sha = cached[1] if cached and cached[0] == key else sha256_file(p)
            except OSError:  # vanished or locked mid-copy; look again next poll
                continue
            self._hash_cache[p] = (key, sha)
            if self.state.hash_processed(sha):
                self.already_processed.append(p)
            else:
                out.append(p)
        return out

    def process(self, path: Path) -> None:
        """Process one scan. Raises TransientError if the local model went away
        (worth retrying later), BadScan if the file can't be a school scan,
        anything else on a bug; all but TransientError are emailed as a problem."""
        scan_date = parse_scan_date(path)
        # Work from a private snapshot: the original may be renamed, moved or
        # replaced while a long run is in progress, and is never modified.
        try:
            sha = sha256_file(path)
            work = self.s.root / ".work" / sha[:16] / path.name
            work.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, work)
        except OSError as e:  # still locked by the scanner/OneDrive, or just moved
            raise TransientError(f"couldn't read {path.name} yet ({e})") from e
        if sha256_file(work) != sha:
            shutil.rmtree(work.parent, ignore_errors=True)
            raise TransientError(f"{path.name} changed while it was being copied")
        try:
            if self.state.hash_processed(sha):
                self.state.record_scan(sha, path.name, scan_date, "duplicate",
                                       "Exact byte-for-byte duplicate of a previously processed scan.")
                self.state.log("INFO", path.name, "Duplicate upload skipped: " + path.name)
                return
            self._process_snapshot(work, sha, scan_date)
        finally:
            remove_work_dir(work.parent)

    def _process_snapshot(self, path: Path, sha: str, scan_date: str) -> None:
        try:
            check_readable_scan(path)
            self.state.log("INFO", path.name, f"Analyzing {path.name} ({scan_date}) with {self.s.model} (local)...")
            analysis = self.stage1(path, scan_date)
            images = render.render_pages(path, dpi=self.s.dpi)
            self.enrich(path, images, scan_date, analysis)
            outputs = self.output(path, sha, scan_date, analysis)
            self.state.record_scan(sha, path.name, scan_date, "processed", "OK",
                                   [str(o.relative_to(self.s.root)) for o in outputs])
            for p in analysis["pages"]:
                self.state.log("INFO", path.name,
                               f"p.{p['page_number']}: {p['category']} ({float(p['confidence']):.2f}) — {p['reason']}")
            self.state.log("INFO", path.name, f"Finished {path.name}: {len(outputs)} file(s) written")
        except Exception as e:
            transient = not isinstance(e, BadScan) and not llm.ollama_available()
            self.state.record_scan(sha, path.name, scan_date, "error", repr(e))
            self.state.log("ERROR", path.name, f"{path.name}: {e!r}")
            if transient:
                raise TransientError(f"the local model stopped responding while processing {path.name}") from e
            self.email(f"PROBLEM: couldn't process {path.name}", "\n".join([
                f"The scan {path.name} could not be processed:", "",
                str(e) if isinstance(e, BadScan) else f"Unexpected error: {e!r}", "",
                "Nothing was filed for it. If this was the wrong file, you can just delete it.",
                "To try again, drop the corrected file into the SchoolWork folder.",
            ]))
            raise

    # --- stage 1
    def stage1(self, path: Path, scan_date: str) -> dict:
        result = classify.classify_pdf(path, scan_date, model=self.s.model, dpi=self.s.dpi, num_ctx=self.s.num_ctx)
        secs = sum(t.seconds for t in result.timings)
        self.state.log("INFO", path.name, f"Stage 1: {len(result.timings)} pages in {secs:.0f}s")
        return result.analysis

    # --- stage 2 (Main.gs spoEnrichAnalysis_)
    def enrich(self, path: Path, images: list[bytes], scan_date: str, analysis: dict) -> None:
        pages = analysis["pages"]
        of = lambda cat: [p["page_number"] for p in pages if p["category"] == cat]
        m = self.s.model
        analysis["homework_sheets"] = []
        analysis["informational_flyers"] = []
        analysis["spelling_sheets"] = []

        if hw := of("homework_sheet"):
            self.state.log("INFO", path.name, f"Extracting homework data from pages: {hw}")
            analysis["homework_sheets"] = stage2.extract_homework_sheets(images, hw, scan_date, m)
            for sheet in analysis["homework_sheets"]:
                self.reread_tests(path, sheet)
                for e in sheet.get("events") or []:
                    self.fix_event_year(e, scan_date, path.name)
            manifest = stage2.manifest_from_sheets(analysis["homework_sheets"], path.name, scan_date)
            if manifest:
                self.state.save_manifest(manifest)
                self.state.log("INFO", path.name, f"Saved homework manifest, week {manifest.get('week_date_text')}")
        if fl := of("informational_flyer"):
            self.state.log("INFO", path.name, f"Extracting flyer events from pages: {fl}")
            analysis["informational_flyers"] = stage2.extract_flyers(
                images, fl, scan_date, m, self.s.student_grade, self.s.student_class)
            for flyer in analysis["informational_flyers"]:
                for e in flyer.get("events") or []:
                    self.fix_event_year(e, scan_date, path.name)
        if sp := of("spelling_word_sheet"):
            self.state.log("INFO", path.name, f"Extracting spelling words from pages: {sp}")
            analysis["spelling_sheets"] = stage2.extract_spelling_sheets(images, sp, scan_date, m)

        matches = stage2.match_current_homework(images, analysis, self.state.load_manifest(), scan_date, m)
        stage2.apply_homework_matches(analysis, matches)

    def reread_tests(self, path: Path, sheet: dict) -> None:
        """LOCAL ADDITION: replace the sheet's tests with a box-by-box read of
        its grid (assessment_grid.py), which gets the days right; keep the
        whole-page answer if the grid can't be read."""
        page = sheet.get("source_page")
        try:
            grid = assessment_grid.read_grid(path, page, self.s.model) if page else None
        except llm.LlmError as e:
            self.state.log("WARN", path.name, f"Couldn't read the test boxes on p.{page} ({e}); "
                                              "using the whole-page reading")
            grid = None
        if grid is None:
            sheet["assessments_source"] = "page"
            return
        as_text = lambda key, s: "; ".join(f"{a['day']}: {a['assessment']}" for a in s.get(key) or []) or "none"
        for key in ("assessments_this_week", "assessments_next_week"):
            if grid[key] != sheet.get(key):
                self.state.log("INFO", path.name, f"Tests p.{page} {key}: read box by box as "
                                                  f"[{as_text(key, grid)}] (whole page said [{as_text(key, sheet)}])")
        sheet["assessments_page_read"] = {k: sheet.get(k) for k in grid}
        sheet.update(grid)
        sheet["assessments_source"] = "grid"

    def fix_event_year(self, event: dict, scan_date: str, source: str) -> None:
        """LOCAL ADDITION: the model sometimes invents the year (Nov 11 on an
        Oct 2026 sheet came back as 2024-11-11). When no year is printed, use
        the first one that doesn't put the event well in the past."""
        fixed = assessments.resolve_year(event.get("date"), event.get("date_text"), scan_date)
        if fixed != event.get("date"):
            self.state.log("INFO", source, f'Event "{event.get("title")}": no year printed, so '
                                           f"{event.get('date')} -> {fixed}")
            event["date"] = fixed

    # --- stage 3 (Processors.gs spoProcessAnalysis_)
    def output(self, path: Path, sha: str, scan_date: str, analysis: dict) -> list[Path]:
        label = date_label(scan_date)
        outputs: list[Path] = [self.save_original(path, scan_date)]

        def make(pages, key_or_folder, filename):
            folder = key_or_folder if isinstance(key_or_folder, Path) else self.s.folder(key_or_folder)
            out = extract_pages(path, pages, folder, filename)
            outputs.append(out)
            self.state.log("INFO", path.name,
                           f"Created {out.relative_to(self.s.papers)} from pages {','.join(map(str, sorted(set(pages))))}")

        by_cat: dict[str, list[int]] = {}
        for p in analysis["pages"]:
            by_cat.setdefault(p["category"], []).append(p["page_number"])
        final_test = self.spelling_final_test_of(analysis, scan_date, path.name)
        for cat, key, filename in [
            ("homework_sheet", "homework_sheets", f"{label}-homework-sheet.pdf"),
            ("homework", "homework", f"{label}-homework.pdf"),
            ("spelling_word_sheet", "spelling", f"{label}-spelling-{'test' if final_test else 'sheet'}.pdf"),
        ]:
            if by_cat.get(cat):
                make(by_cat[cat], key, filename)

        for flyer in analysis["informational_flyers"]:
            if flyer.get("source_page"):
                make([flyer["source_page"]], "flyers", f"{label}-{safe_slug(flyer.get('title') or 'flyer')}.pdf")

        for name, pages in group_pages_by_subject(analysis["pages"]).items():
            make(pages, self.s.folder("subjects") / name, f"{label}-{safe_slug(name)}.pdf")

        for sheet in analysis["homework_sheets"]:
            for e in sheet.get("events") or []:
                self.send_event(e, path)
        for flyer in analysis["informational_flyers"]:
            for e in flyer.get("events") or []:
                self.send_event(e, path)
        self.send_assessment_email(analysis, path, scan_date)
        outputs += self.send_spelling_emails(analysis, path, scan_date)

        results = self.s.folder("results") / f"{label}-{sha[:8]}-analysis.json"
        results.write_text(json.dumps(analysis, indent=2, ensure_ascii=False), encoding="utf-8")
        outputs.append(results)
        self.state.log("INFO", path.name, "Saved analysis JSON: " + results.name)
        return outputs

    def save_original(self, path: Path, scan_date: str) -> Path:
        """An unchanged copy of the scan (path is the snapshot) in Original Scans."""
        folder = self.s.folder("originals")
        folder.mkdir(parents=True, exist_ok=True)
        out = versioned_path(folder, f"{date_label(scan_date)}-original-scan.pdf")
        shutil.copy2(path, out)
        self.state.log("INFO", path.name, f"Saved original scan as {out.relative_to(self.s.papers)}")
        return out

    # --- notifications: Gmail when a credential is stored, else saved as .eml
    def email(self, subject: str, body: str, attachments: list[tuple[str, str]] = (),
              kind: str = "notice", ref=None, in_reply_to: str | None = None,
              references: str | None = None) -> str:
        message_id, where = self.mailer.send(subject, body, attachments, in_reply_to, references)
        self.state.record_sent(message_id, kind, ref, subject, where)
        self.state.log("INFO", "", f"Email sent: {subject}" if where == "gmail" else f"Email saved (not sent): {subject}")
        return message_id

    def send_event(self, event: dict, path: Path) -> None:
        """Processors.gs spoSendEvent_."""
        if event.get("needs_review") or not event.get("date"):
            if self.state.register_event(dict(event, needs_review=True), path.name) == "duplicate":
                return
            body = "\n".join([
                f"I found a possible school event in {path.name}, but the date could not be resolved safely.", "",
                f"Event: {event['title']}",
                f"Printed date: {event.get('date_text') or '(none)'}",
                f"Printed time: {event.get('time_text') or '(none)'}",
                f"Source: {path.name}",
            ])
            self.email(f"REVIEW NEEDED: school event — {event['title']}", body)
            return

        status = self.state.register_event(event, path.name)
        if status == "duplicate":
            return
        label = "UPDATED School Event" if status == "updated" else "School Event"
        time_line = "All day" if event.get("all_day") else (
            event.get("start_time") or event.get("time_text") or "Time stated on source")
        body = f"Event: {event['title']}\nDate: {event['date']}\nTime: {time_line}\nSource: {path.name}\n"
        if event.get("location"):
            body += f"Location: {event['location']}\n"
        if event.get("description"):
            body += f"\n{event['description']}\n"
        self.email(f"{label}: {event['title']} — {event['date']}", body,
                   [(f"{safe_slug(event['title'])}.ics", build_ics(event, TIMEZONE))])

    def send_assessment_email(self, analysis: dict, path: Path, scan_date: str) -> None:
        """Assessments.gs spoSendAssessmentEmail_."""
        fresh, review = [], []
        for sheet in analysis["homework_sheets"]:
            for event in assessment_events(sheet, scan_date):
                status = self.state.register_event(event, path.name)
                if status == "duplicate":
                    continue
                (review if event["needs_review"] else fresh).append((event, status))
        if not fresh and not review:
            return
        fresh.sort(key=lambda es: es[0]["date"])
        body = []
        if fresh:
            body += ["Upcoming tests from the homework sheet (calendar invites attached):", ""]
            body += [f"- {e['date']}: {e['title']}{' [UPDATED]' if s == 'updated' else ''}" for e, s in fresh]
            body.append("")
        if review:
            body += ["REVIEW NEEDED: could not work out the date for these tests (no invite attached):", ""]
            body += [f"- {e['title']} — {e['date_text']}" for e, _ in review]
            body.append("")
        body.append(f"Source: {path.name}")
        subject = f"Upcoming tests: {len(fresh)} new" if fresh else "REVIEW NEEDED: upcoming tests"
        self.email(subject, "\n".join(body),
                   [(f"{e['date']}-{safe_slug(e['title'])}.ics", build_ics(e, TIMEZONE)) for e, _ in fresh])

    def spelling_final_test_of(self, analysis: dict, scan_date: str, source: str) -> dict | None:
        """LOCAL ADDITION: the pre-test batch this scan's spelling sheet is the
        final test of, or None for a new week's pre-test. Worked out once and
        kept in the analysis as spelling_final_test_of."""
        if "spelling_final_test_of" not in analysis:
            words = spelling.words_from_sheets(analysis.get("spelling_sheets") or [])
            first = (date.fromisoformat(scan_date) - timedelta(days=spelling.PRETEST_WINDOW_DAYS)).isoformat()
            match = None
            for batch in self.state.spelling_batches_between(first, scan_date) if words else []:
                pre = [spelling.Word(**w) for w in batch["words"]]
                if spelling.is_same_list(words, pre):
                    match = {"batch_id": batch["id"], "pretest_scan_date": batch["scan_date"],
                             "pretest_source": batch["source_file"],
                             "shared_words": spelling.shared_words(words, pre)}
                    self.state.log("INFO", source,
                                   f"Spelling sheet is the final test for the {date_label(batch['scan_date'])} "
                                   f"pre-test (batch {batch['id']}, {match['shared_words']} shared words); "
                                   "filing it without an email")
                    break
            analysis["spelling_final_test_of"] = match
        return analysis["spelling_final_test_of"]

    def send_spelling_emails(self, analysis: dict, path: Path, scan_date: str,
                             detect_final_test: bool = True) -> list[Path]:
        """New spelling batch: word file in Spelling Sheets + one email that asks
        for corrections of unclear words by reply (see check_replies).
        A final test (same words as a recent pre-test) only gets a results file:
        no batch, no email, no needs-help words."""
        words = spelling.words_from_sheets(analysis["spelling_sheets"])
        if not words:
            return []
        final_test = self.spelling_final_test_of(analysis, scan_date, path.name) if detect_final_test else None
        if final_test:
            self.s.folder("spelling_words").mkdir(parents=True, exist_ok=True)
            out = versioned_path(self.s.folder("spelling_words"), f"{date_label(scan_date)}-spelling-test.txt")
            out.write_text(spelling.render_test_file(words, date_label(scan_date),
                                                     date_label(final_test["pretest_scan_date"]), path.name),
                           encoding="utf-8")
            self.state.log("INFO", path.name, f"Wrote {out.relative_to(self.s.papers)}")
            return [out]
        batch_id = self.state.new_spelling_batch(scan_date, path.name, [w.to_dict() for w in words])
        words_file = self.write_words_file(batch_id, words, scan_date, path.name)
        for w in words:
            if w.needs_work and not w.unclear:
                self.state.add_or_refresh_spelling_word(w.word, scan_date, path.name)
        self.email(f"This week's spelling words ({date_label(scan_date)})",
                   spelling.render_email(words, path.name, batch_id), kind="spelling", ref=batch_id)
        return [words_file]

    def write_words_file(self, batch_id: int, words, scan_date: str, source: str) -> Path:
        batch = self.state.get_spelling_batch(batch_id)
        if batch and batch.get("words_file"):
            out = self.s.root / batch["words_file"]  # rewrite in place on corrections
        else:
            self.s.folder("spelling_words").mkdir(parents=True, exist_ok=True)
            out = versioned_path(self.s.folder("spelling_words"), f"{date_label(scan_date)}-spelling-words.txt")
            self.state.update_spelling_batch(batch_id, words_file=str(out.relative_to(self.s.root)))
        out.write_text(spelling.render_words_file(words, date_label(scan_date), source), encoding="utf-8")
        self.state.log("INFO", source, f"Wrote {out.relative_to(self.s.papers)}")
        return out

    # --- Google Drive: copy into the Drive for desktop folder (folder_sync.py)
    # when it's there, else upload with the API (drive_sync.py) once drive-login
    # has been run
    def sync_drive(self) -> list[str] | None:
        """Upload new/changed output files. None if neither way is available."""
        from . import drive_sync, folder_sync
        my_drive = folder_sync.find_my_drive()
        if my_drive:
            if not isinstance(getattr(self, "_drive", None), folder_sync.FolderSync):
                self._drive = folder_sync.FolderSync(self.s.papers, my_drive)
        elif drive_sync.signed_in():
            if not isinstance(getattr(self, "_drive", None), drive_sync.DriveSync):
                self._drive = drive_sync.DriveSync(self.state.db, self.s.papers)
        else:
            return None
        uploaded = self._drive.sync()
        if uploaded:
            self.state.log("INFO", "", f"Uploaded {len(uploaded)} file(s) to Google Drive "
                                       f'"{drive_sync.DRIVE_ROOT_NAME}": ' + ", ".join(uploaded))
        return uploaded

    # --- email replies with spelling corrections
    def check_replies(self) -> int:
        """Apply corrections from replies to spelling emails. Returns how many
        replies were handled."""
        own = self.state.sent_message_ids()
        handled = 0
        for msg in self.mailer.fetch_candidate_replies():
            if not msg.message_id or msg.message_id in own or self.state.reply_handled(msg.message_id):
                continue
            refs = [msg.in_reply_to] + msg.references.split()
            sent = self.state.sent_lookup([r for r in refs if r])
            batch_id = None
            if sent and sent["kind"] in ("spelling", "spelling-update"):
                batch_id = int(sent["ref"])
            else:
                m = re.search(r"spelling-ref-(\d+)", msg.body)
                batch_id = int(m[1]) if m else None
            batch = self.state.get_spelling_batch(batch_id) if batch_id else None
            if not batch:
                continue  # not a reply to a spelling email; leave it alone
            words = [spelling.Word(**w) for w in batch["words"]]
            result = spelling.apply_reply(words, msg.body)
            self.state.update_spelling_batch(batch_id, words=[w.to_dict() for w in words])
            self.write_words_file(batch_id, words, batch["scan_date"], batch["source_file"])
            for n, _old, new in result.changes:
                w = next(w for w in words if w.number == n)
                if w.needs_work:
                    self.state.add_or_refresh_spelling_word(new, batch["scan_date"], batch["source_file"])
            subject = msg.subject if msg.subject.lower().startswith("re:") else f"Re: {msg.subject}"
            self.email(subject, spelling.render_update_email(words, result, batch["source_file"], batch_id),
                       kind="spelling-update", ref=batch_id,
                       in_reply_to=msg.message_id, references=msg.references)
            summary = f"{len(result.changes)} change(s), {len(result.problems)} problem(s)"
            self.state.mark_reply(msg.message_id, summary)
            self.state.log("INFO", batch["source_file"], f"Spelling reply for batch {batch_id}: {summary}")
            handled += 1
        return handled
