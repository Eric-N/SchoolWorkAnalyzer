from spo.assessments import assessment_events, resolve_year, week_monday, weekday_date


def test_week_monday_formats():
    for text in ["October 12 - October 16", "Oct. 12-16", "10/12 - 10/16", "Week 9: October 12 - 16"]:
        assert week_monday(text, "2026-10-10") == "2026-10-12"
    # A start date that isn't a Monday snaps back to that week's Monday.
    assert week_monday("October 14 - October 16", "2026-10-10") == "2026-10-12"


def test_week_monday_year_wrap():
    assert week_monday("January 4 - January 8", "2026-12-30") == "2027-01-04"
    assert week_monday("December 28 - January 1", "2027-01-02") == "2026-12-28"


def test_week_monday_unparseable():
    assert week_monday(None, "2026-10-10") is None
    assert week_monday("this week", "2026-10-10") is None
    assert week_monday("February 30", "2026-10-10") is None


def test_weekday_date():
    assert weekday_date("2026-10-12", "Tuesday", 0) == "2026-10-13"
    assert weekday_date("2026-10-12", "Fri.", 1) == "2026-10-23"
    assert weekday_date("2026-10-12", None, 0) is None
    assert weekday_date(None, "Friday", 0) is None


def test_assessment_events():
    sheet = {
        "week_date_text": "October 12 - October 16",
        "assessments_this_week": [{"day": "Tuesday", "assessment": "Science: Test #3"}],
        "assessments_next_week": [
            {"day": "Wednesday", "assessment": "Literature: Test #4"},
            {"day": None, "assessment": "Speech: Test #4"},
            {"day": "Friday", "assessment": "  "},
        ],
    }
    events = assessment_events(sheet, "2026-10-10")
    assert [(e["title"], e["date"], e["needs_review"]) for e in events] == [
        ("Science: Test #3", "2026-10-13", False),
        ("Literature: Test #4", "2026-10-21", False),
        ("Speech: Test #4", None, True),
    ]
    assert all(e["all_day"] for e in events)


def test_no_week_text_means_review():
    sheet = {"week_date_text": None, "assessments_this_week": [{"day": "Friday", "assessment": "Spelling: Test #8"}]}
    [event] = assessment_events(sheet, "2026-10-10")
    assert event["date"] is None and event["needs_review"]


def test_week_monday_ordinals():
    # The 10-30 sheet printed "November 2nd – November 6th"; "2nd" used to defeat the parser.
    assert week_monday("November 2nd – November 6th", "2026-10-30") == "2026-11-02"
    assert week_monday("Oct. 1st - 5th", "2026-09-28") == "2026-09-28"
    assert week_monday("November 23rd", "2026-11-20") == "2026-11-23"


def test_resolve_year():
    # No year printed: the model's made-up 2024 becomes the upcoming date.
    assert resolve_year("2024-11-11", "November 11th", "2026-10-30") == "2026-11-11"
    assert resolve_year("2026-05-20", "May 20", "2026-10-30") == "2027-05-20"
    assert resolve_year("2026-10-20", "October 20", "2026-10-30") == "2026-10-20"  # just happened
    assert resolve_year("2026-01-04", "January 4", "2026-12-30") == "2027-01-04"
    # A printed year, or nothing to work with, is left alone.
    assert resolve_year("2024-11-11", "November 11, 2024", "2026-10-30") == "2024-11-11"
    assert resolve_year("2024-11-11", "11/11/24", "2026-10-30") == "2024-11-11"
    assert resolve_year(None, "November 11th", "2026-10-30") is None
    assert resolve_year("soon", None, "2026-10-30") == "soon"
