from spo.subjects import group_pages_by_subject, page_subject_folders, subject_folder_names


def test_aliases_share_a_folder():
    for s in ["Math", "Mathematics", "math", "First Grade Math"]:
        assert subject_folder_names(s) == ["Math"]
    assert subject_folder_names("First Grade Spelling") == ["Spelling"]
    assert subject_folder_names("Logical Thinking - Pattern Recognition") == ["Logic"]
    assert subject_folder_names("Patterns") == ["Logic"]
    assert subject_folder_names("History") == ["Social Studies"]
    assert subject_folder_names("Reading Comprehension") == ["Reading"]


def test_two_subjects_go_to_both_folders():
    assert subject_folder_names("Grammar / Spelling") == ["Grammar", "Spelling"]
    assert subject_folder_names("Reading and Writing") == ["Reading", "Writing"]
    assert subject_folder_names("Geography/Environmental Studies") == ["Geography", "Science"]
    assert subject_folder_names("Grammar/Editing") == ["Grammar"]
    assert subject_folder_names("General (likely Math or Science)") == ["Math", "Science"]


def test_page_kinds_are_not_subjects():
    assert subject_folder_names("Boardwork") == []
    assert subject_folder_names("Art/Visual Activity") == ["Art"]


def test_unknown_subject_gets_its_own_folder():
    assert subject_folder_names("music  class!") == ["Music Class"]
    assert subject_folder_names("Language Arts") == ["Language Arts"]


def test_empty_subject():
    assert subject_folder_names(None) == []
    assert subject_folder_names("") == []


def test_page_rules():
    assert page_subject_folders({"category": "homework", "subject": "Mathematics"}) == ["Math"]
    assert page_subject_folders({"category": "school_work", "subject": None}) == ["Unsorted"]
    assert page_subject_folders({"category": "spelling_word_sheet", "subject": None}) == ["Spelling"]
    for cat in ["homework_sheet", "informational_flyer", "other", "unknown"]:
        assert page_subject_folders({"category": cat, "subject": "Math"}) == []


def test_group_pages_by_subject():
    pages = [
        {"page_number": 1, "category": "homework", "subject": "Math"},
        {"page_number": 2, "category": "school_work", "subject": "Grammar / Spelling"},
        {"page_number": 3, "category": "other", "subject": None},
        {"page_number": 4, "category": "school_work", "subject": "Mathematics"},
    ]
    assert group_pages_by_subject(pages) == {"Math": [1, 4], "Grammar": [2], "Spelling": [2]}


def test_pattern_title_also_files_under_logic():
    from spo.subjects import page_subject_folders
    page = lambda subject, title: {"category": "school_work", "subject": subject, "title": title}
    assert page_subject_folders(page("Math", "Worksheet #9: Patterns")) == ["Math", "Logic"]
    assert page_subject_folders(page("Logic / Math", "Shape Pattern Identification")) == ["Logic", "Math"]
    assert page_subject_folders(page("Math", "Class Practice: Area")) == ["Math"]
    assert page_subject_folders(page("Literature", "My Addition to the Bookworm")) == ["Literature"]
    assert page_subject_folders({"category": "informational_flyer", "title": "Pattern Day"}) == []
