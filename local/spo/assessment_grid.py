"""Upcoming tests read box by box from the homework sheet's grid.
LOCAL ADDITION (no .gs counterpart).

The homework sheet is a table: a label column, then one column per weekday
(Monday-Friday, headings in the top row). Two rows, "This Week's Assessments"
and "Next Week's Assessments", hold the tests, each in the box under its day.
Reading the whole page, the model often put a test under the wrong day (most
often "Friday") or missed it, so here code finds the table's ruled lines and
the model only reads one small box at a time: the day comes from the box's
column, not from the model.

Checks before anything is trusted: the heading boxes must read Monday..Friday
in order, and both assessment rows must be found. If not, read_grid() returns
None and the whole-page extraction's assessments are kept. Scan contents only
go to the local Ollama model.
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pymupdf

from . import llm

log = logging.getLogger(__name__)

GEOMETRY_DPI = 200   # line finding
READ_DPI = 300       # box crops sent to the model
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
GRID_NUM_CTX = 4096  # one small crop per call

TEXT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"text": {"type": "string"}},
    "required": ["text"],
}
TESTS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"tests": {"type": "array", "items": {"type": "string"}}},
    "required": ["tests"],
}


# --- geometry (pure numpy, unit-tested on synthetic grids)

def _spread(mask: np.ndarray, k: int, axis: int) -> np.ndarray:
    """OR each pixel with its k-1 neighbours along axis (closes small gaps)."""
    out = mask.copy()
    for s in range(1, k):
        out |= np.roll(mask, s, axis=axis)
    return out


def _groups(idx: np.ndarray, gap: int) -> list[tuple[int, int]]:
    out: list[list[int]] = []
    for i in idx.tolist():
        if out and i - out[-1][1] <= gap:
            out[-1][1] = i
        else:
            out.append([i, i])
    return [(a, b) for a, b in out]


@dataclass
class Row:
    top: int
    bottom: int
    cols: list[int]  # 7 x positions: left border, 5 inner lines, right border


def find_grid(gray: np.ndarray) -> list[Row] | None:
    """Rows of a 6-column table (label + 5 days), or None if there isn't one.

    Horizontal lines run (almost) the width of the page. In each row band the
    left/right borders are found separately, which absorbs a slightly tilted
    scan. Inner column lines are often too faint to find (lighter print,
    darker paper), so they're taken from a row where all 5 show clearly,
    else assumed to be equal sixths (the sheet's layout); a visible line
    near the expected spot always wins.
    """
    bg = float(np.median(gray))
    dark = gray < bg * 0.8
    h, w = dark.shape

    hcov = _spread(_spread(dark, 4, 0), 9, 1).mean(axis=1)
    lines = [(a + b) // 2 for a, b in _groups(np.where(hcov > 0.7)[0], 25)]
    bands = [(a, b) for a, b in zip(lines, lines[1:]) if b - a > 30]
    if len(bands) < 3:
        return None

    raw = []
    for top, bottom in bands:
        band = dark[top + 8:bottom - 8]
        cov = _spread(band, 4, 1).mean(axis=0)
        edge = int(w * 0.3)
        cov[:15] = cov[-15:] = 0  # a dark scanner edge isn't a border
        strong_left = np.where(cov[:edge] > 0.85)[0]
        strong_right = np.where(cov[w - edge:] > 0.85)[0] + w - edge
        if not len(strong_left) or not len(strong_right):
            return None
        left, right = int(strong_left[0]), int(strong_right[-1])  # outermost: the borders
        if right - left < w * 0.4:
            return None
        inner = [(a + b) // 2 for a, b in _groups(np.where(cov[left + 20:right - 20] > 0.85)[0] + left + 20, 6)]
        raw.append((top, bottom, left, right, inner))

    fractions = [k / 6 for k in range(1, 6)]
    clear = [[(x - l) / (r - l) for x in inner] for _, _, l, r, inner in raw if len(inner) == 5]
    if clear:
        fractions = np.median(np.array(clear), axis=0).tolist()

    rows = []
    for top, bottom, left, right, inner in raw:
        cols = [left]
        for f in fractions:
            x = left + (right - left) * f
            near = [i for i in inner if abs(i - x) < 15]
            cols.append(near[0] if near else round(x))
        rows.append(Row(top, bottom, cols + [right]))
    return rows


def has_ink(gray: np.ndarray, row: Row, c0: int, c1: int, inset: int = 8) -> bool:
    """True if the box between columns c0..c1 holds more than specks."""
    box = gray[row.top + inset:row.bottom - inset, row.cols[c0] + inset:row.cols[c1] - inset]
    return int((box < np.median(gray) * 0.6).sum()) > 60


def crosses(gray: np.ndarray, row: Row, c: int, inset: int = 8) -> bool:
    """True if writing runs across inner line c (dark on both sides of it in
    the same pixel rows), i.e. one test spans two boxes."""
    x = row.cols[c]
    band = gray[row.top + inset:row.bottom - inset].astype(float)
    profile = band[:, x - 12:x + 13].mean(axis=0)
    x += int(np.argmin(profile)) - 12  # the line's actual spot in this row
    dark = band < np.median(gray) * 0.6
    both = dark[:, x - 9:x - 3].any(axis=1) & dark[:, x + 4:x + 10].any(axis=1)
    return int(both.sum()) > 3


# --- model reads

def _crop(page: pymupdf.Page, row: Row, c0: int, c1: int, inset: int = 5) -> bytes:
    k = 72 / GEOMETRY_DPI
    clip = pymupdf.Rect((row.cols[c0] + inset) * k, (row.top + inset) * k,
                        (row.cols[c1] - inset) * k, (row.bottom - inset) * k)
    return page.get_pixmap(dpi=READ_DPI, clip=clip).tobytes("png")


def _read_text(image: bytes, model: str) -> str:
    prompt = ("This image is one box cut from a table on a school homework sheet. "
              "What is written in it? Answer with the text exactly as printed, "
              "or an empty string if the box is empty.")
    return llm.chat_json(prompt, TEXT_SCHEMA, images=[image], model=model, num_ctx=GRID_NUM_CTX).data["text"].strip()


def _read_tests(image: bytes, row_label: str, model: str) -> list[str]:
    prompt = (f'This image is ONE box cut from the "{row_label}" row of a school homework sheet. '
              "List each test or assessment written in the box, exactly as printed "
              '(for example "Spelling: Test #11"), one entry per test. '
              "If the box is empty, return an empty list. Do not add anything that isn't written in the box.")
    tests = llm.chat_json(prompt, TESTS_SCHEMA, images=[image], model=model, num_ctx=GRID_NUM_CTX).data["tests"]
    return [t.strip() for t in tests if t.strip()]


def _is_weekday(text: str, day: str) -> bool:
    return re.sub(r"[^a-z]", "", text.lower()).startswith(day.lower()[:3])


def _row_kind(label: str) -> str | None:
    t = label.lower()
    if not re.search(r"assess|test|quiz", t):
        return None
    if re.search(r"\bthis\b", t):
        return "this"
    if re.search(r"\bnext\b", t):
        return "next"
    return None


def read_grid(pdf_path: Path, page_number: int, model: str) -> dict | None:
    """{"assessments_this_week": [...], "assessments_next_week": [...]} read box
    by box ({"day", "assessment"} items, as the extraction schema has them), or
    None if the page doesn't have the expected grid."""
    with pymupdf.open(pdf_path) as doc:
        page = doc[page_number - 1]
        pix = page.get_pixmap(dpi=GEOMETRY_DPI, colorspace=pymupdf.csGRAY)
        gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.stride)[:, :pix.width]
        rows = find_grid(gray)
        if not rows:
            log.info("Test grid p.%d: no table found", page_number)
            return None

        heading = None
        for i, row in enumerate(rows[:2]):
            texts = [_read_text(_crop(page, row, c, c + 1), model) for c in range(1, 6)]
            if all(_is_weekday(t, d) for t, d in zip(texts, WEEKDAYS)):
                heading = i
                break
            log.info("Test grid p.%d: row %d headings %s aren't Monday-Friday", page_number, i + 1, texts)
        if heading is None:
            return None

        found: dict[str, tuple[Row, str]] = {}
        for row in rows[heading + 1:]:
            if not has_ink(gray, row, 0, 1):
                continue
            label = _read_text(_crop(page, row, 0, 1), model)
            kind = _row_kind(label)
            if kind and kind not in found:
                found[kind] = (row, label)
        if set(found) != {"this", "next"}:
            log.info("Test grid p.%d: assessment rows not found (found %s)", page_number, sorted(found))
            return None

        out = {}
        for kind, key in (("this", "assessments_this_week"), ("next", "assessments_next_week")):
            row, label = found[kind]
            items = []
            c = 1
            while c < 6:
                end = c + 1  # a test written across a line makes one wider box
                while end < 6 and crosses(gray, row, end):
                    end += 1
                if has_ink(gray, row, c, end):
                    day = WEEKDAYS[c - 1] if end == c + 1 else None
                    for test in _read_tests(_crop(page, row, c, end), label, model):
                        items.append({"day": day, "assessment": test})
                    if day is None:
                        log.info("Test grid p.%d: writing spans %s-%s in %r", page_number,
                                 WEEKDAYS[c - 1], WEEKDAYS[end - 2], label)
                c = end
            out[key] = items
        return out
