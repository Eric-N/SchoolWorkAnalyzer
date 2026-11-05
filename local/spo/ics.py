"""ICS building (straight port of Ics.gs)."""

import hashlib
import re
from datetime import date, datetime, timedelta, timezone


def ics_escape(s) -> str:
    s = str(s or "")
    return re.sub(r"\r?\n", r"\\n", s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,"))


def _compact_date(iso: str) -> str:
    return str(iso).replace("-", "")


def _next_iso_date(iso: str) -> str:
    return (date.fromisoformat(iso) + timedelta(days=1)).isoformat()


def _compact_time(hhmm) -> str | None:
    """"14:30" -> "143000"; None when not a usable HH:MM (degrades to all-day)."""
    m = re.match(r"^(\d{1,2}):(\d{2})", str(hhmm or ""))
    if not m:
        return None
    hours, minutes = int(m[1]), int(m[2])
    if hours > 23 or minutes > 59:
        return None
    return f"{hours:02d}{minutes:02d}00"


def _plus_one_hour(hhmm) -> str | None:
    """Default one-hour duration; clamps at 23:59 instead of rolling past midnight."""
    m = re.match(r"^(\d{1,2}):(\d{2})", str(hhmm or ""))
    if not m:
        return None
    hours, minutes = int(m[1]), int(m[2])
    if hours >= 23:
        return "235900"
    return f"{hours + 1:02d}{minutes:02d}00"


def _fold(line: str) -> str:
    """RFC 5545 line folding, same split points as Ics.gs."""
    if len(line) <= 73:
        return line
    parts, rest = [line[:73]], line[73:]
    while len(rest) > 72:
        parts.append(" " + rest[:72])
        rest = rest[72:]
    if rest:
        parts.append(" " + rest)
    return "\r\n".join(parts)


def build_ics(event: dict, tz: str) -> str:
    if not event.get("date"):
        raise ValueError("Cannot build ICS without a resolved date.")
    seed = f"{event['title']}|{event['date']}|{event.get('start_time') or ''}"
    uid = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24] + "@school-paper-organizer"
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//School Paper Organizer//EN", "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH", "BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{now}",
    ]
    start = None if event.get("all_day") else _compact_time(event.get("start_time"))
    if not start:
        # All-day events take an exclusive DTEND on the following day.
        lines.append(f"DTSTART;VALUE=DATE:{_compact_date(event['date'])}")
        lines.append(f"DTEND;VALUE=DATE:{_compact_date(_next_iso_date(event['date']))}")
    else:
        end = _compact_time(event.get("end_time")) or _plus_one_hour(event.get("start_time"))
        day = _compact_date(event["date"])
        lines.append(f"DTSTART;TZID={tz}:{day}T{start}")
        lines.append(f"DTEND;TZID={tz}:{day}T{end or start}")
    lines.append(f"SUMMARY:{ics_escape(event['title'])}")
    if event.get("location"):
        lines.append(f"LOCATION:{ics_escape(event['location'])}")
    if event.get("description"):
        lines.append(f"DESCRIPTION:{ics_escape(event['description'])}")
    lines += ["END:VEVENT", "END:VCALENDAR", ""]
    return "\r\n".join(_fold(l) for l in lines)
