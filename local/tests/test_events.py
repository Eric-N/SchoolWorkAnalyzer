from spo.events import compare_events, event_titles_match, find_known_event


def ev(title, date="2026-10-29", start_time=None, all_day=True, needs_review=False):
    return {"title": title, "date": date, "start_time": start_time, "all_day": all_day,
            "needs_review": needs_review}


def test_reworded_titles_match():
    pairs = [
        ("Halloween Dress-Up Day", "Dress Up Day"),
        ("Halloween Dress-Up Day", "Reminder: Halloween Dressup"),
        ("Spelling: Test #8", "Spelling Test"),
        ("Spelling: Test #8", "spelling test 8"),
        ("No School", "No School - Teacher Work Day"),
        ("Pajama Day", "PAJAMAS DAY!"),
    ]
    for a, b in pairs:
        assert event_titles_match(a, b), (a, b)


def test_different_events_dont_match():
    pairs = [
        ("Science: Test #3", "Logic: Test #3"),
        ("Spelling: Test #8", "Spelling: Test #9"),
        ("Picture Day", "Picture Day - Special Function Uniform"),
        ("Science Test", "Science Fair"),
        ("Halloween Dress-Up Day", "Halloween Party"),
        ("Day", "The Day"),  # nothing left after filler
    ]
    for a, b in pairs:
        assert not event_titles_match(a, b), (a, b)


def test_dates_and_times():
    known = ev("Book Fair", start_time="08:00", all_day=False)
    assert compare_events(known, ev("Book Fair", start_time="08:00", all_day=False)) == "same"
    assert compare_events(known, ev("Book Fair", start_time="15:00", all_day=False)) is None
    assert compare_events(known, ev("Book Fair")) == "same"  # all-day mention of a timed event
    assert compare_events(known, ev("Book Fair", date="2026-10-30")) is None
    # An all-day event later given a time is worth an updated invite.
    assert compare_events(ev("Book Fair"), ev("Book Fair", start_time="08:00", all_day=False)) == "more_detail"


def test_review_only_events():
    review = ev("Field Trip", date=None, needs_review=True)
    assert compare_events(review, ev("Field Trip", date=None, needs_review=True)) == "same"
    # A dated mention of something only known for review is new information.
    assert compare_events(review, ev("Field Trip")) is None
    # A dateless mention of an event already on the calendar is a repeat.
    assert compare_events(ev("Field Trip"), ev("Field Trip", date=None, needs_review=True)) == "same"
    # Same date, but the known one needed review (e.g. unclear grade): send the clean one.
    assert compare_events(ev("Field Trip", needs_review=True), ev("Field Trip")) == "more_detail"


def test_find_known_event_prefers_same():
    known = [ev("Book Fair"), ev("Book Fair", start_time="08:00", all_day=False)]
    match = find_known_event(ev("Book Fair", start_time="08:00", all_day=False), known)
    assert match == (known[1], "same")
    assert find_known_event(ev("Assembly"), known) is None
