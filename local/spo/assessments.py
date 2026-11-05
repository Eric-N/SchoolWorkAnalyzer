"""Upcoming tests from the weekly homework sheet.

Each assessment has only a weekday ("Friday"; read box by box from the
sheet's grid, see assessment_grid.py) plus the sheet's week text
("October 12 - October 16"), so the date is resolved here: Monday of the
sheet's week + the weekday, +7 days for next week's list. Anything that
can't be resolved safely is marked needs_review instead of guessed. The
"Upcoming tests" email is Pipeline.send_assessment_email.

Started as a port of the Apps Script's Assessments.gs; it has moved on since
(ordinal dates, resolve_year) and no longer has to match it.
"""

import re
from datetime import date, timedelta

MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

_NAMED = re.compile(r"\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b")
_NUMERIC = re.compile(r"\b(\d{1,2})/(\d{1,2})\b")
_PRINTED_YEAR = re.compile(r"\b(?:19|20)\d{2}\b|\d{1,2}/\d{1,2}/\d{2}\b|'\d{2}\b")
# An event announced with no year is taken to be upcoming; this much slack
# keeps one that just happened (a thank-you flyer) in the current year.
PAST_SLACK_DAYS = 60


def week_monday(week_date_text: str | None, scan_date: str) -> str | None:
    """Monday (ISO yyyy-MM-dd) of the week named by week_date_text, or None.

    Reads the FIRST date in the text: "October 12 - October 16", "Oct. 12-16",
    "November 2nd - November 6th" or "10/12 - 10/16". The year comes from the
    scan date, picking whichever of last/this/next year lands closest to it.
    """
    text = str(week_date_text or "").lower()
    month = day = None
    for m in _NAMED.finditer(text):  # skips "week 9"
        if m[1] in MONTHS:
            month, day = MONTHS.index(m[1]) + 1, int(m[2])
            break
    if month is None and (m := _NUMERIC.search(text)):
        month, day = int(m[1]), int(m[2])
    if month is None or month > 12 or day < 1 or day > 31:
        return None

    scan = date.fromisoformat(scan_date)
    candidates = []
    for y in (scan.year - 1, scan.year, scan.year + 1):
        try:
            candidates.append(date(y, month, day))
        except ValueError:  # e.g. Feb 30
            pass
    if not candidates:
        return None
    best = min(candidates, key=lambda d: abs(d - scan))
    return (best - timedelta(days=best.weekday())).isoformat()


def resolve_year(date_iso: str | None, date_text: str | None, scan_date: str) -> str | None:
    """LOCAL ADDITION: the model's date with the year re-chosen when none is
    printed in date_text: the first year that doesn't put the date more than
    PAST_SLACK_DAYS before the scan. Anything unparseable is returned as is."""
    if _PRINTED_YEAR.search(str(date_text or "")):
        return date_iso
    try:
        d, scan = date.fromisoformat(str(date_iso)), date.fromisoformat(scan_date)
    except ValueError:
        return date_iso
    for y in (scan.year - 1, scan.year, scan.year + 1):
        try:
            candidate = date(y, d.month, d.day)
        except ValueError:  # Feb 29 in a non-leap year
            continue
        if candidate >= scan - timedelta(days=PAST_SLACK_DAYS):
            return candidate.isoformat()
    return date_iso


def weekday_date(monday_iso: str | None, day_name: str | None, week_offset: int) -> str | None:
    """ISO date for a weekday name in the week starting at monday_iso, or None."""
    key = str(day_name or "").strip().lower()[:3]
    if not monday_iso or key not in WEEKDAYS:
        return None
    d = date.fromisoformat(monday_iso) + timedelta(days=WEEKDAYS.index(key) + 7 * week_offset)
    return d.isoformat()


def assessment_events(sheet: dict, scan_date: str) -> list[dict]:
    """Event dicts (the shape the ICS builder takes) for one homework sheet's tests."""
    monday = week_monday(sheet.get("week_date_text"), scan_date)
    week_label = sheet.get("week_date_text") or "(week not printed)"
    events = []
    for key, week_offset, when in (
        ("assessments_this_week", 0, "this week"),
        ("assessments_next_week", 1, "next week"),
    ):
        for a in sheet.get(key) or []:
            title = str(a.get("assessment") or "").strip()
            if not title:
                continue
            d = weekday_date(monday, a.get("day"), week_offset)
            events.append({
                "title": title,
                "date_text": f"{a.get('day') or '(no day)'}, {when} (homework sheet for {week_label})",
                "date": d,
                "time_text": None,
                "start_time": None,
                "end_time": None,
                "all_day": True,
                "location": None,
                "description": f"Listed under {when}'s assessments on the homework sheet for {week_label}.",
                "confidence": 1,
                "needs_review": d is None,
            })
    return events
