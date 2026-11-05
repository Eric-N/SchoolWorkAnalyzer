"""Subject folders: School Papers/Subjects/<Subject> (port of Subjects.gs).

Every worksheet page (class work, tonight's homework, spelling tests) is also
copied into one PDF per subject per scan. Stage 1's free-text "subject" is
normalized so "Math", "Mathematics" and "First Grade Math" share a folder; a
subject like "Grammar / Spelling" goes into BOTH folders; anything that matches
no known subject gets its own folder named from the model's answer.

(The Apps Script is retired; this no longer has to match Subjects.gs.)
"""

import re

SUBJECTS_FOLDER_NAME = "Subjects"

# Pages in these categories get subject copies. The weekly homework sheet,
# flyers, blank/other and unknown pages do not.
SUBJECT_CATEGORIES = ("school_work", "homework", "spelling_word_sheet")

# A subject part is filed under EVERY alias it matches, in this order.
SUBJECT_ALIASES = [
    ("Math", re.compile(r"math|arithmetic|addition|subtraction|multiplication|fraction|coins?\b|money")),
    ("Spelling", re.compile(r"spelling|phonics|vowel")),
    ("Grammar", re.compile(r"grammar|editing|punctuation|capitali[sz]ation|diagramming|parts of speech")),
    ("Literature", re.compile(r"literature|poetry|poems?\b")),
    ("Logic", re.compile(r"logic|pattern|puzzle")),
    ("Geography", re.compile(r"geography|\bmaps?\b")),
    ("Social Studies", re.compile(r"social studies|history|civics|community")),
    ("Science", re.compile(r"science|biology|physics|chemistry|environment")),
    ("Reading", re.compile(r"reading|comprehension")),
    ("Writing", re.compile(r"writing|composition")),
    ("Art", re.compile(r"\bart\b|drawing|coloring")),
]

# Words that describe the kind of page, not its subject. A part that matches
# no alias and matches this is dropped instead of becoming a folder.
NOT_A_SUBJECT = re.compile(r"board ?work|work ?sheet|homework|class ?work|practice|activity|general|unknown|^n/?a$")

# User request 2026-11-03: pattern sheets also belong in Logic even when the
# model called them Math ("Worksheet #9: Patterns"). Only the title is checked,
# and only for these, so e.g. "My Addition to the Bookworm" doesn't become Math.
TITLE_EXTRA_SUBJECTS = [
    ("Logic", re.compile(r"pattern|puzzle|logic")),
]

UNSORTED_SUBJECT = "Unsorted"
MAX_SUBJECTS_PER_PAGE = 3

_SPLIT = re.compile(r"\s*[/,;&+]\s*|\s+and\s+", re.IGNORECASE)
_GRADE = re.compile(r"\b(first|1st|second|2nd|third|3rd)\s+grade\b|\bgrade\s+\d\b", re.IGNORECASE)


def subject_folder_names(subject: str | None) -> list[str]:
    """Normalize one free-text subject into a deduplicated list of folder names."""
    names: list[str] = []
    for raw in _SPLIT.split(str(subject or "")):
        part = re.sub(r"\s+", " ", _GRADE.sub(" ", raw)).strip()
        if not part:
            continue
        lower = part.lower()
        matched = [n for n, rx in SUBJECT_ALIASES if rx.search(lower)]
        if not matched and not NOT_A_SUBJECT.search(lower):
            matched = [_title_case_folder_name(part)]
        for name in matched:
            if name and name not in names:
                names.append(name)
    return names[:MAX_SUBJECTS_PER_PAGE]


def _title_case_folder_name(s: str) -> str:
    s = re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9 ]+", " ", s)).strip()[:40].lower()
    return re.sub(r"\b[a-z]", lambda m: m[0].upper(), s)


def page_subject_folders(page: dict) -> list[str]:
    """Subject folder names for one page, or [] if it doesn't get subject copies.

    A spelling sheet always lands in Spelling; a worksheet with no usable
    subject goes to Unsorted so it isn't silently dropped.
    """
    if page.get("category") not in SUBJECT_CATEGORIES:
        return []
    names = subject_folder_names(page.get("subject"))
    if page["category"] == "spelling_word_sheet" and "Spelling" not in names:
        names.insert(0, "Spelling")
    for name, rx in TITLE_EXTRA_SUBJECTS:
        if name not in names and rx.search(str(page.get("title") or "").lower()):
            names.append(name)
    return names or [UNSORTED_SUBJECT]


def group_pages_by_subject(pages: list[dict]) -> dict[str, list[int]]:
    """{"Math": [1, 2], "Grammar": [3]} for the pages of one analysis."""
    by_subject: dict[str, list[int]] = {}
    for p in pages or []:
        for name in page_subject_folders(p):
            by_subject.setdefault(name, []).append(p["page_number"])
    return by_subject
