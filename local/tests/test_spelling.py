import email
from email import policy
from pathlib import Path

import pytest

from spo import mailer, spelling
from spo.pipeline import Pipeline, Settings

SHEETS = [{"source_page": 2, "words": [
    {"word_number": 1, "student_spelling": "crook", "correct_spelling": "crook", "needs_work": False, "needs_review": False},
    {"word_number": 16, "student_spelling": "cheeck", "correct_spelling": "cheek", "needs_work": True, "needs_review": False},
    {"word_number": 18, "student_spelling": "big garage", "correct_spelling": "big garage", "needs_work": True, "needs_review": False},
    {"word_number": 19, "student_spelling": None, "correct_spelling": None, "needs_work": False, "needs_review": True},
]}]

GMAIL_REPLY = """18 = garage
19 = some

On Thu, Oct 29, 2026 at 2:15 PM School Paper Organizer <family@gmail.com>
wrote:

> All words from this week's spelling sheet:
>     18 = garage
"""


def words():
    return spelling.words_from_sheets(SHEETS)


def test_unclear_detection():
    by_n = {w.number: w for w in words()}
    assert not by_n[1].unclear and not by_n[16].unclear and by_n[16].needs_work
    assert by_n[18].unclear and "single word" in by_n[18].note
    assert by_n[19].unclear and by_n[19].word is None


def test_files_and_email_show_unclear_words():
    text = spelling.render_words_file(words(), "10-29-2026", "scan.pdf")
    assert "16. cheek   * needs help" in text
    assert '18. ???   (looked like "big garage"' in text
    body = spelling.render_email(words(), "scan.pdf", 7)
    assert "#18, #19" in body and "18 = garage" in body and "spelling-ref-7" in body


def test_new_text_drops_quoted_original():
    assert spelling.new_text(GMAIL_REPLY) == "18 = garage\n19 = some"
    assert spelling.new_text("garage\n\n> quoted") == "garage"
    assert spelling.new_text("ok\n-----Original Message-----\nFrom: x") == "ok"


@pytest.mark.parametrize("reply, expected", [
    ("18 = garage", {18: "garage"}),
    ("#18: garage, 19 - some", {18: "garage", 19: "some"}),
    ("Hi!\n18 is garage\nThanks!\nSent from my iPhone", {18: "garage"}),
    ("18 garage.", {18: "garage"}),
])
def test_apply_reply(reply, expected):
    ws = words()
    result = spelling.apply_reply(ws, reply)
    assert {n: new for n, _, new in result.changes} == expected
    assert not result.problems
    by_n = {w.number: w for w in ws}
    assert all(by_n[n].word == v and not by_n[n].unclear for n, v in expected.items())


def test_ok_confirms_and_bare_word_needs_exactly_one_unclear():
    ws = words()
    r = spelling.apply_reply(ws, "16 ok")
    assert r.changes == [(16, "cheek", "cheek")]
    r = spelling.apply_reply(ws, "garage")  # two words still unclear -> ambiguous
    assert not r.changes and r.problems
    spelling.apply_reply(ws, "19 = some")
    r = spelling.apply_reply(ws, "garage")  # now only #18 is unclear
    assert r.changes == [(18, "big garage", "garage")]


def test_reply_problems():
    ws = words()
    r = spelling.apply_reply(ws, "42 = dog\n18 = big garage\n19 ok")
    assert not r.changes
    assert len(r.problems) == 3  # no #42, not a single word, no usable reading


def test_round_trip_through_pipeline(tmp_path, monkeypatch):
    monkeypatch.setattr(mailer, "credential", lambda: None)  # offline: outbox + simulated replies
    pipe = Pipeline(Settings(root=tmp_path, model="x", num_ctx=0, inbox=tmp_path / "drop"))
    analysis = {"spelling_sheets": SHEETS}
    [words_file] = pipe.send_spelling_emails(analysis, Path("10-29-2026.pdf"), "2026-10-29")
    assert words_file.name == "10-29-2026-spelling-words.txt"
    assert words_file.parent.name == "Spelling Words"
    sent_id = next(iter(pipe.state.sent_message_ids()))

    # Simulate the family replying from the account.
    reply = email.message.EmailMessage()
    reply["Message-ID"] = "<reply-1@mail.gmail.com>"
    reply["In-Reply-To"] = sent_id
    reply["References"] = sent_id
    reply["Subject"] = "Re: This week's spelling words (10-29-2026)"
    reply.set_content(GMAIL_REPLY)
    pipe.s.simulated_replies.mkdir(parents=True)
    (pipe.s.simulated_replies / "reply.eml").write_bytes(bytes(reply))

    assert pipe.check_replies() == 1
    assert pipe.check_replies() == 0  # handled once only
    text = words_file.read_text(encoding="utf-8")
    assert "18. garage   * needs help" in text and "19. some" in text and "???" not in text

    confirmation = sorted(pipe.s.outbox.glob("*.eml"))[-1]
    msg = email.message_from_bytes(confirmation.read_bytes(), policy=policy.default)
    assert msg["Subject"] == "Re: This week's spelling words (10-29-2026)"
    assert msg["In-Reply-To"] == "<reply-1@mail.gmail.com>"
    assert '#18: garage   (was "big garage")' in msg.get_body().get_content()
    practice = {r[0] for r in pipe.state.db.execute("SELECT display_word FROM spelling_words")}
    assert practice == {"cheek", "garage"}  # needs-help words, once confirmed


def sheet(*words, needs_work=(), unclear=()):
    return [{"source_page": 1, "words": [
        {"word_number": i, "student_spelling": w, "correct_spelling": w,
         "needs_work": w in needs_work, "needs_review": w in unclear} for i, w in enumerate(words, 1)]}]


PRETEST = ("crook", "cheek", "garage", "stood", "brook", "wooden", "pudding", "should")


def test_same_list_tolerates_one_misread_letter():
    pre = spelling.words_from_sheets(sheet(*PRETEST))
    final = spelling.words_from_sheets(sheet("crook", "cheek", "garaje", "stood", "brock", "woodn", "shud"))
    assert spelling.shared_words(final, pre) == 6  # "shud" is two letters off "should"
    assert spelling.is_same_list(final, pre)
    new_week = spelling.words_from_sheets(sheet("cheek", "plane", "train", "brain", "chain", "stain"))
    assert not spelling.is_same_list(new_week, pre)  # one review word isn't the same list


def test_final_test_is_filed_without_email(tmp_path, monkeypatch):
    monkeypatch.setattr(mailer, "credential", lambda: None)
    pipe = Pipeline(Settings(root=tmp_path, model="x", num_ctx=0, inbox=tmp_path / "drop"))
    pipe.send_spelling_emails({"spelling_sheets": sheet(*PRETEST, needs_work=("cheek",))},
                              Path("11-02-2026.pdf"), "2026-11-02")
    emails = len(pipe.state.sent_message_ids())

    analysis = {"spelling_sheets": sheet(*PRETEST[::-1], needs_work=("garage",), unclear=("brook",))}
    [out] = pipe.send_spelling_emails(analysis, Path("11-06-2026.pdf"), "2026-11-06")
    assert out.name == "11-06-2026-spelling-test.txt"
    assert "same words as the 11-02-2026 pre-test" in out.read_text(encoding="utf-8")
    assert analysis["spelling_final_test_of"]["batch_id"] == 1
    assert len(pipe.state.sent_message_ids()) == emails  # no email, not even for the unclear word
    assert pipe.state.db.execute("SELECT COUNT(*) FROM spelling_batches").fetchone()[0] == 1
    practice = {r[0] for r in pipe.state.db.execute("SELECT display_word FROM spelling_words")}
    assert practice == {"cheek"}  # the final test's misses aren't added

    # Too old to be that week's test -> a new pre-test with its own email.
    pipe.send_spelling_emails({"spelling_sheets": sheet(*PRETEST)}, Path("11-20-2026.pdf"), "2026-11-20")
    assert len(pipe.state.sent_message_ids()) == emails + 1
    # A manual resend never counts as a final test.
    pipe.send_spelling_emails({"spelling_sheets": sheet(*PRETEST)}, Path("11-20-2026.pdf"), "2026-11-20",
                              detect_final_test=False)
    assert len(pipe.state.sent_message_ids()) == emails + 2
