"""assessment_grid.py on synthetic sheets (no scans, no model)."""

import numpy as np
import pymupdf
import pytest

from spo import assessment_grid as ag

W, H = 1700, 2200
LEFT, RIGHT = 110, 1570
LINES = [380, 455, 645, 835, 1035, 1225, 1415, 1750, 2090]  # header, 4 homework rows, this, next, notes
THIS, NEXT = 5, 6  # row index of the two assessment rows


def sheet(tilt_px=0, inner_gray=170, paper=203):
    """A homework-sheet-shaped grid: dark borders and row lines, faint inner
    column lines; the vertical lines drift tilt_px over the page (a tilted scan)."""
    g = np.full((H, W), paper, np.uint8)
    for y in LINES:
        g[y - 1:y + 2, LEFT:RIGHT + 1] = 40
    for yy in range(LINES[0], LINES[-1]):
        drift = round(tilt_px * yy / H)
        g[yy, LEFT + drift - 1:LEFT + drift + 2] = 40
        g[yy, RIGHT + drift - 1:RIGHT + drift + 2] = 40
        for k in range(1, 6):
            x = LEFT + drift + (RIGHT - LEFT) * k // 6
            g[yy, x - 1:x + 1] = inner_gray
    return g


def box(row, col):
    """Pixel centre of a box (col 0 = label column, 1..5 = Monday..Friday)."""
    return (LINES[row] + LINES[row + 1]) // 2, LEFT + (RIGHT - LEFT) * (2 * col + 1) // 12


def write(g, row, col, width=120):
    """Draw a 'word' (a dark bar) starting in a box; a wide one runs on to
    the right, into the next box."""
    y, x = box(row, col)
    g[y - 6:y + 6, x - 60:x - 60 + width] = 20


@pytest.mark.parametrize("tilt", [0, 15, -15])
def test_find_grid_tilted_faint_lines(tilt):
    rows = ag.find_grid(sheet(tilt_px=tilt))
    assert len(rows) == len(LINES) - 1
    for r in rows:
        assert len(r.cols) == 7
        widths = np.diff(r.cols)
        assert widths.min() > 230 and widths.max() < 260


def test_find_grid_prefers_clear_inner_lines():
    # Dark, unevenly spaced inner lines are used instead of equal sixths.
    g = sheet()
    xs = [400, 640, 880, 1120, 1360]
    for x in xs:
        g[LINES[0]:LINES[-1], x - 1:x + 2] = 40
    rows = ag.find_grid(g)
    assert all(abs(a - b) <= 4 for a, b in zip(rows[3].cols[1:6], xs))


def test_no_table():
    g = np.full((H, W), 255, np.uint8)
    g[500:520, 300:900] = 0  # a picture, not a table
    assert ag.find_grid(g) is None


def test_has_ink_and_crosses():
    g = sheet()
    write(g, THIS, 2)                  # Tuesday
    write(g, NEXT, 4, width=330)       # Thursday, running into Friday
    rows = ag.find_grid(g)
    ink = [ag.has_ink(g, rows[THIS], c, c + 1) for c in range(1, 6)]
    assert ink == [False, True, False, False, False]
    assert [ag.crosses(g, rows[NEXT], c) for c in range(1, 6)] == [False, False, False, False, True]
    assert not any(ag.crosses(g, rows[THIS], c) for c in range(1, 6))


def _pdf(tmp_path, g):
    path = tmp_path / "sheet.pdf"
    pix = pymupdf.Pixmap(pymupdf.csGRAY, W, H, g.tobytes(), False)
    with pymupdf.open() as doc:
        page = doc.new_page(width=W * 72 / ag.GEOMETRY_DPI, height=H * 72 / ag.GEOMETRY_DPI)
        page.insert_image(page.rect, pixmap=pix)
        doc.save(path)
    return path


def fake_model(monkeypatch, labels, tests, headings=ag.WEEKDAYS):
    """Stub the model: crops become (row top, c0, c1) tags looked up in tables."""
    tops = {y: i for i, y in enumerate(LINES)}
    def crop(page, row, c0, c1, inset=5):
        return (min(tops, key=lambda y: abs(y - row.top)), c0, c1)
    def read_text(tag, model):
        top, c0, _ = tag
        i = tops[top]
        return headings[c0 - 1] if i == 0 else labels.get(i, "")
    def read_tests(tag, row_label, model):
        top, c0, c1 = tag
        return tests[(tops[top], c0, c1)]
    monkeypatch.setattr(ag, "_crop", crop)
    monkeypatch.setattr(ag, "_read_text", read_text)
    monkeypatch.setattr(ag, "_read_tests", read_tests)


LABELS = {1: "Grammar", 2: "Math", 3: "Spelling", 4: "15 Minutes of Reading",
          THIS: "This Week's Assessments", NEXT: "Next Week's Assessments", 7: "Notes and Reminders"}


def labelled_sheet():
    g = sheet(tilt_px=8)
    for r in range(1, 8):
        write(g, r, 0)
    return g


def test_read_grid_days_come_from_columns(tmp_path, monkeypatch):
    g = labelled_sheet()
    write(g, THIS, 2)
    write(g, THIS, 5)
    write(g, NEXT, 5)
    fake_model(monkeypatch, LABELS, {
        (THIS, 2, 3): ["Science: Test #4"],
        (THIS, 5, 6): ["Spelling: Test #11", "Math: Test #5"],
        (NEXT, 5, 6): ["Spelling: Test #12"],
    })
    assert ag.read_grid(_pdf(tmp_path, g), 1, "m") == {
        "assessments_this_week": [
            {"day": "Tuesday", "assessment": "Science: Test #4"},
            {"day": "Friday", "assessment": "Spelling: Test #11"},
            {"day": "Friday", "assessment": "Math: Test #5"},
        ],
        "assessments_next_week": [{"day": "Friday", "assessment": "Spelling: Test #12"}],
    }


def test_read_grid_spanning_writing_has_no_day(tmp_path, monkeypatch):
    g = labelled_sheet()
    write(g, NEXT, 3, width=330)  # Wednesday into Thursday
    fake_model(monkeypatch, LABELS, {(NEXT, 3, 5): ["Field trip test"]})
    out = ag.read_grid(_pdf(tmp_path, g), 1, "m")
    assert out["assessments_this_week"] == []
    assert out["assessments_next_week"] == [{"day": None, "assessment": "Field trip test"}]


def test_read_grid_rejects_unexpected_layouts(tmp_path, monkeypatch):
    g = labelled_sheet()
    path = _pdf(tmp_path, g)
    fake_model(monkeypatch, LABELS, {}, headings=["Math", "Grammar", "Spelling", "Reading", "Notes"])
    assert ag.read_grid(path, 1, "m") is None
    fake_model(monkeypatch, {k: v for k, v in LABELS.items() if k != NEXT}, {})
    assert ag.read_grid(path, 1, "m") is None
