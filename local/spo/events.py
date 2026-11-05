""""Is this an event we already know about?" (port of EventMatching.gs).

The same test or dress-up day is often mentioned several times, worded a
little differently each time. Two mentions are the same event when their
dates match (a mention with no date is compared on title alone), their start
times don't conflict, and their titles match after dropping filler words: one
title's words are all in the other, or one squashed title contains the other.
Different numbers ("Test #3" / "Test #4") or a uniform reminder vs the event
itself are never the same event.

state.py's known-events table should use find_known_event the way State.gs
spoRegisterEvent_ does. (The Apps Script is retired; this no longer has to match it.)
"""

import re
from dataclasses import dataclass

# Words that don't tell two events apart.
EVENT_FILLER = {
    "the", "a", "an", "and", "of", "for", "on", "at", "to", "in", "is", "our", "your",
    "all", "day", "reminder", "event", "annual", "please", "remember",
}

# If only one title has one of these, they are different events.
EVENT_MARKERS = ["uniform"]

MIN_CONTAINED_LENGTH = 4


@dataclass
class _Core:
    words: list[str]
    joined: str
    numbers: str
    markers: str


def _event_core(title: str | None) -> _Core:
    s = re.sub(r"(\w)-(\w)", r"\1\2", str(title or "").lower())  # "dress-up" -> "dressup"
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    words = [w for w in s.split(" ") if w and w not in EVENT_FILLER]
    words = [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in words]
    return _Core(
        words=words,
        joined="".join(words),
        numbers=",".join(sorted(w for w in words if w.isdigit())),
        markers=",".join(m for m in EVENT_MARKERS if m in words),
    )


def event_titles_match(a: str | None, b: str | None) -> bool:
    x, y = _event_core(a), _event_core(b)
    if not x.words or not y.words:
        return False
    if x.markers != y.markers:
        return False
    if x.numbers and y.numbers and x.numbers != y.numbers:
        return False
    small, big = (x, y) if len(x.words) <= len(y.words) else (y, x)
    if all(w in big.words for w in small.words):
        return True
    shorter, longer = sorted((x.joined, y.joined), key=len)
    return len(shorter) >= MIN_CONTAINED_LENGTH and shorter in longer


def _start_time(event: dict) -> str:
    return "" if event.get("all_day") else str(event.get("start_time") or "")


def compare_events(known: dict, event: dict) -> str | None:
    """'same' (a repeat; don't notify), 'more_detail' (same event, adds a start
    time or a usable version of a review-only one), or None (different event)."""
    if event.get("date"):
        if not known.get("date") or str(known["date"]) != str(event["date"]):
            return None
    known_time, event_time = _start_time(known), _start_time(event)
    if known_time and event_time and known_time != event_time:
        return None
    if not event_titles_match(known.get("title"), event.get("title")):
        return None
    if known.get("needs_review") and not event.get("needs_review"):
        return "more_detail"
    if not known_time and event_time:
        return "more_detail"
    return "same"


def find_known_event(event: dict, known_events: list[dict]) -> tuple[dict, str] | None:
    """Best (known, kind) match for event, or None. 'same' wins over 'more_detail'."""
    best = None
    for known in known_events or []:
        kind = compare_events(known, event)
        if kind == "same" and (best is None or best[1] != "same"):
            best = (known, kind)
        elif kind and best is None:
            best = (known, kind)
    return best
