"""Local SQLite state (replaces the State.gs spreadsheet + manifest property)."""

import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from .events import find_known_event

SCHEMA = """
CREATE TABLE IF NOT EXISTS scans (
  sha256 TEXT, file_name TEXT, scan_date TEXT, processed_at TEXT,
  status TEXT, message TEXT, output_files TEXT);
CREATE TABLE IF NOT EXISTS events (
  signature TEXT, title_key TEXT, title TEXT, event_date TEXT, start_time TEXT,
  all_day INTEGER, first_seen TEXT, last_seen TEXT, source_file TEXT, needs_review INTEGER);
CREATE TABLE IF NOT EXISTS spelling_words (
  word_key TEXT PRIMARY KEY, display_word TEXT, first_seen TEXT, last_seen TEXT,
  active INTEGER, source_file TEXT);
CREATE TABLE IF NOT EXISTS manifest (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT, saved_at TEXT);
CREATE TABLE IF NOT EXISTS log (timestamp TEXT, level TEXT, file_name TEXT, message TEXT);
CREATE TABLE IF NOT EXISTS sent_emails (
  message_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, subject TEXT, sent_at TEXT, sent_via TEXT);
CREATE TABLE IF NOT EXISTS spelling_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scan_date TEXT, source_file TEXT, words_json TEXT,
  words_file TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS handled_replies (message_id TEXT PRIMARY KEY, handled_at TEXT, result TEXT);
"""


def normalize_text(s) -> str:
    """State.gs spoNormalizeText_."""
    return re.sub(r"[^a-z0-9]+", " ", str(s or "").lower()).strip()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class State:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def log(self, level: str, file_name: str, message: str) -> None:
        print(f"[{level}] {message}", flush=True)
        self.db.execute("INSERT INTO log VALUES (?,?,?,?)", (_now(), level, file_name, message))
        self.db.commit()

    # --- scans
    def hash_processed(self, sha: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM scans WHERE sha256=? AND status='processed'", (sha,)).fetchone() is not None

    def record_scan(self, sha, file_name, scan_date, status, message, outputs=()):
        self.db.execute("INSERT INTO scans VALUES (?,?,?,?,?,?,?)",
                        (sha, file_name, scan_date, _now(), status, message, json.dumps(list(outputs))))
        self.db.commit()

    # --- manifest (HomeworkManifest.gs, stored here instead of Script Properties)
    def save_manifest(self, manifest: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO manifest VALUES (1,?,?)", (json.dumps(manifest), _now()))
        self.db.commit()

    def load_manifest(self) -> dict | None:
        row = self.db.execute("SELECT json FROM manifest WHERE id=1").fetchone()
        return json.loads(row["json"]) if row else None

    # --- events (State.gs spoRegisterEvent_)
    def register_event(self, event: dict, source_file: str) -> str:
        """'new', 'updated' or 'duplicate' — see State.gs spoRegisterEvent_."""
        rows = [dict(r) for r in self.db.execute("SELECT rowid, * FROM events")]
        title_key = normalize_text(event["title"])
        seed = f"{title_key}|{event.get('date') or ''}|{event.get('start_time') or ''}|{1 if event.get('all_day') else 0}"
        signature = hashlib.sha256(seed.encode("utf-8")).hexdigest()
        hit = next((r for r in rows if r["signature"] == signature), None)
        kind = "same" if hit else None
        if not hit:
            known = [{"title": r["title"], "date": r["event_date"], "start_time": r["start_time"],
                      "all_day": bool(r["all_day"]), "needs_review": bool(r["needs_review"])} for r in rows]
            match = find_known_event(event, known)
            if match:
                hit, kind = rows[known.index(match[0])], match[1]

        now = _now()
        if kind == "same":
            self.db.execute("UPDATE events SET last_seen=? WHERE rowid=?", (now, hit["rowid"]))
            self.db.commit()
            self.log("INFO", source_file,
                     f'Already known event, not notifying again: "{event["title"]}" '
                     f'({event.get("date") or "no date"}) matches "{hit["title"]}"')
            return "duplicate"

        same_title = any(r["title_key"] == title_key for r in rows)
        self.db.execute("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)", (
            signature, title_key, event["title"], event.get("date") or "", event.get("start_time") or "",
            int(bool(event.get("all_day"))), now, now, source_file, int(bool(event.get("needs_review")))))
        self.db.commit()
        return "updated" if (kind or same_title) else "new"

    # --- sent emails / replies
    def record_sent(self, message_id: str, kind: str, ref, subject: str, via: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO sent_emails VALUES (?,?,?,?,?,?)",
                        (message_id, kind, None if ref is None else str(ref), subject, _now(), via))
        self.db.commit()

    def sent_message_ids(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT message_id FROM sent_emails")}

    def sent_lookup(self, message_ids: list[str]) -> dict | None:
        """The first of message_ids that we sent, as a row (kind, ref, subject)."""
        for mid in message_ids:
            row = self.db.execute("SELECT * FROM sent_emails WHERE message_id=?", (mid,)).fetchone()
            if row:
                return dict(row)
        return None

    def reply_handled(self, message_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM handled_replies WHERE message_id=?", (message_id,)).fetchone() is not None

    def mark_reply(self, message_id: str, result: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO handled_replies VALUES (?,?,?)", (message_id, _now(), result))
        self.db.commit()

    # --- spelling batches
    def new_spelling_batch(self, scan_date: str, source_file: str, words: list[dict]) -> int:
        cur = self.db.execute(
            "INSERT INTO spelling_batches (scan_date, source_file, words_json, created_at, updated_at) VALUES (?,?,?,?,?)",
            (scan_date, source_file, json.dumps(words), _now(), _now()))
        self.db.commit()
        return cur.lastrowid

    def get_spelling_batch(self, batch_id: int) -> dict | None:
        row = self.db.execute("SELECT * FROM spelling_batches WHERE id=?", (batch_id,)).fetchone()
        return dict(row, words=json.loads(row["words_json"])) if row else None

    def spelling_batches_between(self, first_date: str, last_date: str) -> list[dict]:
        """Batches with first_date <= scan_date <= last_date (ISO dates), newest first."""
        rows = self.db.execute(
            "SELECT * FROM spelling_batches WHERE scan_date BETWEEN ? AND ? ORDER BY scan_date DESC, id DESC",
            (first_date, last_date))
        return [dict(r, words=json.loads(r["words_json"])) for r in rows]

    def update_spelling_batch(self, batch_id: int, words: list[dict] | None = None, words_file: str | None = None) -> None:
        if words is not None:
            self.db.execute("UPDATE spelling_batches SET words_json=?, updated_at=? WHERE id=?",
                            (json.dumps(words), _now(), batch_id))
        if words_file is not None:
            self.db.execute("UPDATE spelling_batches SET words_file=? WHERE id=?", (words_file, batch_id))
        self.db.commit()

    # --- spelling (State.gs spoAddOrRefreshSpellingWord_)
    def add_or_refresh_spelling_word(self, word: str, seen_date: str, source_file: str) -> None:
        key = normalize_text(word)
        if not key:
            return
        row = self.db.execute("SELECT first_seen FROM spelling_words WHERE word_key=?", (key,)).fetchone()
        first = row["first_seen"] if row and row["first_seen"] else seen_date
        self.db.execute("INSERT OR REPLACE INTO spelling_words VALUES (?,?,?,?,1,?)",
                        (key, word, first, seen_date, source_file))
        self.db.commit()
