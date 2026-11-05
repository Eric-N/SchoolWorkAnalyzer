"""Stage 2: homework-sheet, flyer and spelling extraction, then homework
matching (HomeworkExtraction.gs, FlyerExtraction.gs, SpellingExtraction.gs,
HomeworkMatching.gs, HomeworkManifest.gs).

Prompts and schemas are in stage2_prompts.json, first exported verbatim from
the Apps Script's .gs files and now maintained here. Claude read the whole
PDF in one call; the local model gets one page image per call (same prompt,
plus a short page-context note), and the per-page results are merged.
"""

import json
import logging
import re
from datetime import date
from functools import cache
from pathlib import Path

from . import llm

log = logging.getLogger(__name__)

STAGE2_NUM_CTX = 12288  # homework-sheet answers are long; 8k can truncate them


@cache
def _gs() -> dict:
    return json.loads((Path(__file__).with_name("stage2_prompts.json")).read_text(encoding="utf-8"))


def _fill(template: str, **values: str) -> str:
    for k, v in values.items():
        template = template.replace("{{" + k + "}}", v)
    return template


def page_addendum(page_number: int, page_count: int) -> str:
    """LOCAL ADDITION (not from .gs): the local model sees one page image per call."""
    return f"""
PAGE CONTEXT:
The attached image is page {page_number} of {page_count} of the scanned PDF;
the PDF itself is not attached. Use {page_number} as the page number in your
answer.
"""


def _per_page(kind: str, list_key: str, page_key: str, images: list[bytes], pages: list[int],
              fill: dict, model: str) -> list[dict]:
    spec = _gs()[kind]
    out = []
    for n in pages:
        prompt = _fill(spec["prompt"], PAGES=str(n), **fill) + page_addendum(n, len(images))
        result = llm.chat_json(prompt, spec["schema"], images=[images[n - 1]], model=model,
                               num_ctx=STAGE2_NUM_CTX)
        log.info("%s p.%d: %.1fs", kind, n, result.seconds)
        for item in result.data.get(list_key) or []:
            out.append(dict(item, **{page_key: n}))  # trust our page index
    return out


def extract_homework_sheets(images, pages, scan_date, model):
    return _per_page("homework_sheet", "homework_sheets", "source_page", images, pages,
                     {"SCAN_DATE": scan_date}, model)


def extract_flyers(images, pages, scan_date, model, student_grade, student_class):
    return _per_page("flyer", "informational_flyers", "source_page", images, pages,
                     {"SCAN_DATE": scan_date, "STUDENT_GRADE": student_grade,
                      "STUDENT_CLASS": student_class}, model)


def extract_spelling_sheets(images, pages, scan_date, model):
    return _per_page("spelling", "spelling_sheets", "source_page", images, pages,
                     {"SCAN_DATE": scan_date}, model)


def manifest_from_sheets(homework_sheets: list[dict], file_name: str, scan_date: str) -> dict | None:
    """HomeworkManifest.gs spoSaveHomeworkManifest_ (the final sheet wins)."""
    if not homework_sheets:
        return None
    sheet = homework_sheets[-1]
    return {
        "source_file_name": file_name,
        "scan_date": scan_date,
        **{k: sheet.get(k) or None for k in ("teacher", "grade", "room", "week_number", "week_date_text")},
        "homework": sheet.get("homework") or {},
    }


def homework_for_scan_date(manifest: dict | None, scan_date: str) -> dict | None:
    """HomeworkManifest.gs spoHomeworkForScanDate_."""
    if not manifest or not manifest.get("homework"):
        return None
    try:
        d = date.fromisoformat(scan_date)
    except ValueError:
        return None
    weekday = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][d.weekday()]
    if weekday in ("saturday", "sunday"):
        return {"date": scan_date, "weekday": weekday, "assignments": []}
    assignments = manifest["homework"].get(weekday)
    return {"date": scan_date, "weekday": weekday,
            "assignments": assignments if isinstance(assignments, list) else []}


SPECIAL_CATEGORIES = ("homework_sheet", "informational_flyer", "spelling_word_sheet")
# LOCAL ADDITION: blank/lined pages and drawings can't be current homework, and
# each candidate costs a ~20 s model call, so they aren't checked.
SKIPPED_CANDIDATES = ("other",)


# LOCAL ADDITION: worksheet identifiers such as "WS 55" / "MF55" in a page's
# document code must agree with today's assignment. The model matched an
# "Addition" math-facts sheet (code ..._G1_MF55) to "Math: WS 55" on the shared
# number, so a YES is overruled when the code has identifiers and none is an
# assignment's. "G1" is the grade, not an identifier.
_WORKSHEET_ID = re.compile(r"(?<![A-Za-z])([A-Za-z]{1,4})[\s_#.\-]*(\d{1,4})(?!\d)")


def worksheet_ids(text: str | None) -> set[tuple[str, int]]:
    return {(p.upper(), int(n)) for p, n in _WORKSHEET_ID.findall(text or "") if p.upper() != "G"}


def worksheet_id_conflict(document_code: str | None, assignments: list[str]) -> str | None:
    """Why the page can't be any of these assignments, or None if it can."""
    page_ids = worksheet_ids(document_code)
    wanted = set().union(*(worksheet_ids(a) for a in assignments)) if assignments else set()
    if not page_ids or not wanted or page_ids & wanted:
        return None
    fmt = lambda ids: ", ".join(f"{p} {n}" for p, n in sorted(ids))
    return f"its code {document_code!r} has {fmt(page_ids)}, not {fmt(wanted)}"


# LOCAL ADDITION: workbook page numbers. On the 11-03 scan the model matched
# workbook page 106 (code "106") to "Spelling pages 105" because it was blank and
# had the same title as page 105. A bare page-number code must be one of the
# pages the assignment names ("pages 105", "pp. 105-106", "pages 105 & 106").
_PAGE_CODE = re.compile(r"^\s*(?:(?:pages?|pgs?|pp?)\.?\s*)?(\d{1,4})\s*$", re.IGNORECASE)
_PAGE_LIST = re.compile(r"\b(?:pages?|pgs?|pp?)\.?\s*(\d{1,4}(?:\s*(?:-|–|—|,|&|and|to)\s*\d{1,4})*)",
                        re.IGNORECASE)


def assignment_pages(text: str | None) -> set[int]:
    pages: set[int] = set()
    for group in _PAGE_LIST.findall(text or ""):
        for a, b in re.findall(r"(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?", group):
            lo, hi = int(a), int(b or a)
            pages.update(range(lo, hi + 1) if 0 <= hi - lo <= 20 else (lo, hi))
    return pages


def page_number_conflict(document_code: str | None, assignments: list[str]) -> str | None:
    """Why a page whose code is just a page number can't be any of these assignments."""
    m = _PAGE_CODE.match(document_code or "")
    wanted = set().union(*(assignment_pages(a) for a in assignments)) if assignments else set()
    if not m or not wanted or int(m.group(1)) in wanted:
        return None
    return f"it is page {int(m.group(1))}, not page {', '.join(map(str, sorted(wanted)))}"


def homework_conflict(document_code: str | None, matched: str | None, today: list[str]) -> str | None:
    """Both LOCAL ADDITION checks, against the matched assignment when it names an
    identifier/page, else against all of today's assignments."""
    ids = [matched] if worksheet_ids(matched) else today
    pages = [matched] if assignment_pages(matched) else today
    return worksheet_id_conflict(document_code, ids) or page_number_conflict(document_code, pages)


def match_current_homework(images, analysis, manifest, scan_date, model) -> list[dict]:
    """HomeworkMatching.gs spoMatchCurrentHomework_, one candidate page per call."""
    today = homework_for_scan_date(manifest, scan_date)
    if not today:
        log.info("No current homework manifest; no homework matching performed.")
        return []
    if not today["assignments"]:
        log.info("No homework assignments listed for %s.", today["weekday"])
        return []

    spec = _gs()["homework_matching"]
    matches = []
    for p in analysis["pages"]:
        if p["category"] in SPECIAL_CATEGORIES or p["category"] in SKIPPED_CANDIDATES:
            continue
        candidate = [{
            "page_number": p["page_number"],
            "title": p.get("title") or None,
            "document_code": p.get("document_code") or None,
            "subject": p.get("subject") or None,
            "current_category": p["category"],
        }]
        n = p["page_number"]
        prompt = _fill(
            spec["prompt"],
            SCAN_DATE=scan_date,
            WEEKDAY=today["weekday"],
            ASSIGNMENTS_JSON=json.dumps(today["assignments"], indent=2, ensure_ascii=False),
            CANDIDATES_JSON=json.dumps(candidate, indent=2, ensure_ascii=False),
            PAGES=str(n),
        ) + page_addendum(n, len(images))
        result = llm.chat_json(prompt, spec["schema"], images=[images[n - 1]], model=model,
                               num_ctx=STAGE2_NUM_CTX)
        for m in result.data.get("pages") or []:
            m = dict(m, page_number=n)
            if m["is_current_homework"]:
                if why := homework_conflict(p.get("document_code"), m.get("matched_assignment"),
                                            [str(a.get("assignment") or "") for a in today["assignments"]]):
                    log.info("Homework match p.%d overruled: %s", n, why)
                    m = dict(m, is_current_homework=False, matched_subject=None, matched_assignment=None,
                             reason=f"Not current homework: {why}. (Model said yes: {m['reason']})")
            log.info("Homework match p.%d: %s — %s", n, "YES" if m["is_current_homework"] else "NO", m["reason"])
            matches.append(m)
            break  # one candidate per call
    return matches


def apply_homework_matches(analysis: dict, matches: list[dict]) -> None:
    """HomeworkMatching.gs spoApplyHomeworkMatches_."""
    by_page = {m["page_number"]: m for m in matches or []}
    for page in analysis["pages"]:
        match = by_page.get(page["page_number"])
        if not match:
            continue
        page["homework_match"] = match["is_current_homework"]
        page["matched_assignment"] = match.get("matched_assignment") or None
        page["homework_match_reason"] = match.get("reason") or None
        page["appears_completed"] = match.get("appears_completed")
        page["appears_corrected"] = match.get("appears_corrected")
        if match["is_current_homework"]:
            page["category"] = "homework"
            if match.get("matched_subject"):
                page["subject"] = match["matched_subject"]
            if match.get("matched_assignment"):
                page["assignment_match"] = match["matched_assignment"]
            page["confidence"] = match["confidence"]
            page["reason"] = "Current homework match: " + match["reason"]
