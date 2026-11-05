"""Spelling batches: the quick-reference word file, the email, and corrections
sent back by email reply ("18 = garage").

A batch is one scan's spelling words. A word is UNCLEAR when the model said it
needs review, couldn't read it, or read something that isn't a single word
(e.g. "big garage"). Unclear words show as ??? until someone replies with the
right word; the reply's "18 ok" form confirms the model's reading as-is.
"""

import re
from dataclasses import asdict, dataclass

WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'\-]*$")


@dataclass
class Word:
    number: int  # as printed on the sheet, or the position when not printed
    word: str | None  # best reading; None if unreadable
    needs_work: bool  # marked incorrect by the teacher
    unclear: bool
    note: str | None = None  # why it's unclear / what changed

    def to_dict(self) -> dict:
        return asdict(self)


def words_from_sheets(spelling_sheets: list[dict]) -> list[Word]:
    """Model output (spelling_sheets[].words[]) -> numbered Word list."""
    words: list[Word] = []
    used: set[int] = set()
    for sheet in spelling_sheets or []:
        for item in sheet.get("words") or []:
            text = str(item.get("correct_spelling") or item.get("student_spelling") or "").strip() or None
            n = item.get("word_number")
            if not isinstance(n, int) or n in used:
                n = max(used | {0}) + 1
            used.add(n)
            unclear, note = False, None
            if item.get("needs_review"):
                unclear, note = True, "the handwriting or correction was ambiguous"
            elif text is None:
                unclear, note = True, "unreadable"
            elif not WORD_RE.match(text):
                unclear, note = True, "doesn't look like a single word"
            words.append(Word(n, text, bool(item.get("needs_work")), unclear, note))
    return sorted(words, key=lambda w: w.number)


def _line(w: Word) -> str:
    if w.unclear:
        seen = f'looked like "{w.word}"' if w.word else "couldn't read it"
        return f"{w.number:>2}. ???   ({seen} — reply with the right word)"
    return f"{w.number:>2}. {w.word}{'   * needs help' if w.needs_work else ''}"


def render_words_file(words: list[Word], scan_label: str, source: str) -> str:
    unclear = [w for w in words if w.unclear]
    lines = [f"Spelling words — scan of {scan_label}", ""]
    lines += [_line(w) for w in words]
    lines += ["", "* = marked incorrect on the sheet (needs practice)"]
    if unclear:
        lines.append(f"??? = not confirmed yet ({len(unclear)} word{'s' if len(unclear) != 1 else ''})")
    lines += ["", f"Source: {source}", ""]
    return "\n".join(lines)  # write_text turns these into \r\n on Windows


# --- pre-test vs final test
# The week's words come home twice: on the pre-test early in the week and on
# the final test later. Only the pre-test starts a batch (file, email,
# needs-help words). A sheet whose words mostly match a batch from the last
# PRETEST_WINDOW_DAYS is that batch's final test: it's filed, nothing else.

PRETEST_WINDOW_DAYS = 14
MIN_SHARED_WORDS = 3
MIN_SHARED_FRACTION = 0.5  # of the shorter list's words


def _key(text: str | None) -> str:
    return re.sub(r"[^a-z]", "", (text or "").lower())


def _close(a: str, b: str) -> bool:
    """Same word, allowing one misread letter in words of 5+ letters."""
    if a == b:
        return True
    if min(len(a), len(b)) < 5 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    short, long_ = sorted((a, b), key=len)
    return any(long_[:i] + long_[i + 1:] == short for i in range(len(long_)))


def shared_words(words: list[Word], other: list[Word]) -> int:
    """How many of words' readings also appear (or nearly) in other."""
    theirs = [k for k in (_key(w.word) for w in other) if k]
    return sum(any(_close(k, t) for t in theirs) for k in (_key(w.word) for w in words) if k)


def is_same_list(words: list[Word], other: list[Word]) -> bool:
    n = shared_words(words, other)
    shorter = min(sum(1 for w in words if _key(w.word)), sum(1 for w in other if _key(w.word)))
    return n >= MIN_SHARED_WORDS and n >= MIN_SHARED_FRACTION * shorter


def render_test_file(words: list[Word], scan_label: str, pretest_label: str, source: str) -> str:
    missed = [w for w in words if w.needs_work]
    lines = [f"Spelling final test — scan of {scan_label}",
             f"(same words as the {pretest_label} pre-test; no email is sent for the final test)", ""]
    lines += [f"{w.number:>2}. {w.word or '(unreadable)'}{'   * marked incorrect' if w.needs_work else ''}"
              + ("   (unclear reading)" if w.unclear and w.word else "") for w in words]
    lines += ["", f"Marked incorrect: {len(missed)} of {len(words)}", "", f"Source: {source}", ""]
    return "\n".join(lines)


def ref_token(batch_id: int) -> str:
    """Printed in each spelling email; lets a reply be matched to its batch even
    if the mail app drops the In-Reply-To header."""
    return f"spelling-ref-{batch_id}"


def render_email(words: list[Word], source: str, batch_id: int) -> str:
    unclear = [w for w in words if w.unclear]
    needs_help = list(dict.fromkeys(w.word for w in words if w.needs_work and not w.unclear and w.word))
    body = ["All words from this week's spelling sheet:", ""]
    body += [_line(w) for w in words]
    body += ["", f"Needs help with: {', '.join(needs_help)}" if needs_help
             else "No words were marked incorrect this time."]
    if unclear:
        example = unclear[0]
        body += [
            "",
            f"I couldn't confirm {len(unclear)} word{'s' if len(unclear) != 1 else ''}: "
            + ", ".join(f"#{w.number}" for w in unclear) + ".",
            "To fix one, just reply to this email with the number and the right word, one per line:",
            "",
            f"    {example.number} = garage" if example.number else "    1 = garage",
            "",
            f'If my reading was actually right, reply "{example.number} ok".',
        ]
    body += ["", f"Source: {source}", f"({ref_token(batch_id)})"]
    return "\n".join(body)


# --- replies

_QUOTE_START = [
    re.compile(r"^On .*wrote:\s*$"),
    re.compile(r"^-+\s*Original Message\s*-+", re.I),
    re.compile(r"^From:\s"),
    re.compile(r"^_{10,}"),
]
_CORRECTION = re.compile(r"^#?\s*(\d{1,3})\s*(?:=|:|-|–|—|\)|\.|\bis\b)?\s*(.+?)\s*$", re.I)
_SKIP_LINES = re.compile(r"^(sent from my .*|get outlook for .*|thanks?!*|thank you!*)$", re.I)


def new_text(body: str) -> str:
    """The part of a reply the person typed, without the quoted original."""
    lines = body.replace("\r\n", "\n").split("\n")
    out = []
    for i, line in enumerate(lines):
        s = line.strip()
        nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
        if s.startswith(">") or any(p.match(s) for p in _QUOTE_START):
            break
        if s.startswith("On ") and nxt.endswith("wrote:"):  # "On Thu, … <x@gmail.com>\nwrote:"
            break
        out.append(line)
    return "\n".join(out).strip()


@dataclass
class ReplyResult:
    changes: list[tuple[int, str | None, str]]  # (number, old reading, new word)
    problems: list[str]


def apply_reply(words: list[Word], body: str) -> ReplyResult:
    """Apply "18 = garage" / "18 ok" lines (or a bare word when exactly one
    word is unclear) to words, in place."""
    by_number = {w.number: w for w in words}
    unclear = [w for w in words if w.unclear]
    changes, problems, unparsed = [], [], []
    text = new_text(body)
    entries = [e.strip() for line in text.split("\n") for e in re.split(r"[,;]", line)]
    entries = [e for e in entries if e and not _SKIP_LINES.match(e)]

    def set_word(w: Word, new: str, typed: str):
        new = new.strip().strip("\"'.!").strip()
        if not WORD_RE.match(new):
            problems.append(f'"{typed}": "{new}" doesn\'t look like a single word, so I left #{w.number} alone.')
            return
        changes.append((w.number, w.word, new))
        w.word, w.unclear, w.note = new, False, "confirmed by email reply"

    for e in entries:
        m = _CORRECTION.match(e)
        if m:
            n, rest = int(m[1]), m[2]
            w = by_number.get(n)
            if not w:
                problems.append(f'"{e}": there\'s no word #{n} on this list.')
            elif rest.lower() in ("ok", "okay", "correct", "right", "yes"):
                if w.word and WORD_RE.match(w.word):
                    changes.append((n, w.word, w.word))
                    w.unclear, w.note = False, "confirmed by email reply"
                else:
                    problems.append(f'"{e}": I don\'t have a usable reading for #{n}; please reply with the word.')
            else:
                set_word(w, rest, e)
        elif len(unclear) == 1 and len(entries) == 1 and WORD_RE.match(e.strip("\"'.! ")):
            set_word(unclear[0], e, e)
        else:
            unparsed.append(e)
    # Chatty lines ("Hi", "Looks right to me") only matter if nothing else worked.
    if unparsed and not changes and not problems:
        problems += [f'"{e}": I didn\'t understand this line. Use the form "18 = garage".' for e in unparsed]
    return ReplyResult(changes, problems)


def render_update_email(words: list[Word], result: ReplyResult, source: str, batch_id: int) -> str:
    body = []
    if result.changes:
        body += ["Thanks — the spelling list is updated:", ""]
        for n, old, new in result.changes:
            body.append(f"  #{n}: {new}" + (f'   (was "{old}")' if old and old != new else "   (confirmed)"))
        body.append("")
    if result.problems:
        body += ["I couldn't use part of your reply:", ""] + [f"  - {p}" for p in result.problems] + [""]
    body += ["Current list:", ""] + [_line(w) for w in words]
    remaining = [w for w in words if w.unclear]
    if remaining:
        body += ["", "Still unconfirmed: " + ", ".join(f"#{w.number}" for w in remaining)
                 + ". Reply to this email the same way to fix them."]
    body += ["", f"Source: {source}", f"({ref_token(batch_id)})"]
    return "\n".join(body)
