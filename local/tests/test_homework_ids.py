from types import SimpleNamespace

import pytest

from spo import stage2

TODAY = ["WS 47", "WS 55", "Spelling pages 103", "15 Minutes of Reading"]


@pytest.mark.parametrize("code, conflict", [
    ("28-261.03-23_G1_MF55", True),   # 11-02 "Addition" math-facts sheet: same number, not a WS
    ("28-261.03-23_G1_MF1", True),
    ("28-221.17-19 G1 WS 46", True),  # an older worksheet
    ("28-221.19-19 G1 WS 47", False),
    ("28-261.41-23_G1_WS55", False),
    ("28-181.03-22", False),          # no identifier: leave it to the model
    ("none visible", False),
    (None, False),
])
def test_worksheet_id_conflict(code, conflict):
    assert bool(stage2.worksheet_id_conflict(code, TODAY)) == conflict


def test_model_yes_is_overruled_for_a_different_worksheet(monkeypatch):
    def fake_chat_json(prompt, schema, **kw):
        return SimpleNamespace(data={"pages": [{
            "page_number": 1, "is_current_homework": True, "matched_subject": "Math",
            "matched_assignment": "WS 55", "confidence": 0.9, "reason": "code matches WS 55",
            "appears_completed": False, "appears_corrected": False}]})
    monkeypatch.setattr(stage2.llm, "chat_json", fake_chat_json)
    manifest = {"homework": {"monday": [{"subject": "Math", "assignment": "WS 55"}]}}
    analysis = {"pages": [
        {"page_number": 1, "category": "school_work", "title": "Addition",
         "document_code": "28-261.03-23_G1_MF55", "subject": "Math"},
        {"page_number": 2, "category": "school_work", "title": "Homework: Area",
         "document_code": "28-261.41-23_G1_WS55", "subject": "Math"},
    ]}
    matches = stage2.match_current_homework([b"", b""], analysis, manifest, "2026-11-02", "x")
    stage2.apply_homework_matches(analysis, matches)
    assert [p["category"] for p in analysis["pages"]] == ["school_work", "homework"]
    assert "MF 55" in analysis["pages"][0]["homework_match_reason"]


@pytest.mark.parametrize("code, assignments, conflict", [
    ("106", ["Spelling pages 105"], True),        # 11-03: blank page 106 matched to page 105
    ("105", ["Spelling pages 105"], False),
    ("104", ["Spelling pages 105"], True),
    ("106", ["Spelling pages 105-106"], False),
    ("106", ["Spelling pp. 105 & 106"], False),
    ("p. 107", ["Spelling pages 105, 106"], True),
    ("Page 105", ["Spelling page 105"], False),
    ("28-181.03-22", ["Spelling pages 105"], False),  # not a bare page number
    ("106", ["WS 56", "15 Minutes of Reading"], False),  # no pages named: leave it to the model
    (None, ["Spelling pages 105"], False),
])
def test_page_number_conflict(code, assignments, conflict):
    assert bool(stage2.page_number_conflict(code, assignments)) == conflict


def test_11_03_scan_page_106_is_overruled():
    today = ["WS 48", "WS 56", "Spelling pages 105", "15 Minutes of Reading"]
    assert stage2.homework_conflict("106", "Spelling pages 105", today)
    assert not stage2.homework_conflict("105", "Spelling pages 105", today)
    assert not stage2.homework_conflict("28-261.43-23_G1_WS56", "WS 56", today)
    assert stage2.homework_conflict("28-261.03-23_G1_MF56", "WS 56", today)
