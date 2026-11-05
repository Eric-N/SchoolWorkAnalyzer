"""Mirror the local output tree (<root>/School Papers) to Google Drive.

Uses the narrow drive.file scope: the organizer can see and change only the
files and folders it created itself, so it works in its own tree,
"School Papers (PC)" in My Drive, and never touches anything else (including
the old Apps Script "School Papers" folders and its Inbox).

Sync is a one-way upload: new local files are created in Drive, changed ones
(e.g. a spelling word file after a correction) are updated in place. Nothing
is ever deleted from Drive. Running it again is always safe; files that are
already up to date are skipped, so a failed run just catches up next time.

Sign-in: `spo.cli drive-login <client_secret.json>` once. The OAuth client
and the saved token live in %LOCALAPPDATA%\\SchoolPaperOrganizer (outside
OneDrive), not in the project folder.
"""

import hashlib
import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.file"]
APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "SchoolPaperOrganizer"
CLIENT_FILE = APP_DIR / "drive_client_secret.json"
TOKEN_FILE = APP_DIR / "drive_token.json"
DRIVE_ROOT_NAME = "School Papers (PC)"
FOLDER_MIME = "application/vnd.google-apps.folder"
SKIP_DIRS = {"Inbox"}  # the PC's drop folder is SchoolWork itself; no Drive Inbox
MIME_TYPES = {".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS drive_items (
  rel_path TEXT PRIMARY KEY, drive_id TEXT, is_folder INTEGER, sha256 TEXT,
  size INTEGER, mtime_ns INTEGER, synced_at TEXT);
"""


def login(client_secret: Path) -> str:
    """One-time browser sign-in. Returns the signed-in account's email."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    APP_DIR.mkdir(parents=True, exist_ok=True)
    if client_secret.resolve() != CLIENT_FILE.resolve():
        shutil.copyfile(client_secret, CLIENT_FILE)
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_FILE), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True,
                                  success_message="Signed in. You can close this tab and go back.")
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    about = _build(creds).about().get(fields="user(emailAddress)").execute()
    return about["user"]["emailAddress"]


def _credentials():
    """Saved credentials (refreshed if needed), or None if never signed in."""
    if not TOKEN_FILE.exists():
        return None
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if not creds.valid and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return creds


def _build(creds):
    from googleapiclient.discovery import build
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def signed_in() -> bool:
    return TOKEN_FILE.exists()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class DriveSync:
    def __init__(self, db, papers: Path, service=None):
        """db: the State sqlite connection. service: a Drive v3 client (tests
        pass a fake); by default one is built from the saved sign-in."""
        self.db = db
        self.db.executescript(SCHEMA)
        self.papers = papers
        self._service = service

    @property
    def service(self):
        if self._service is None:
            creds = _credentials()
            if creds is None:
                raise RuntimeError("not signed in to Google Drive (run: spo.cli drive-login)")
            self._service = _build(creds)
        return self._service

    # --- bookkeeping
    def _row(self, rel: str):
        return self.db.execute("SELECT * FROM drive_items WHERE rel_path=?", (rel,)).fetchone()

    def _save(self, rel, drive_id, is_folder, sha=None, size=None, mtime_ns=None):
        self.db.execute("INSERT OR REPLACE INTO drive_items VALUES (?,?,?,?,?,?,?)",
                        (rel, drive_id, int(is_folder), sha, size, mtime_ns, _now()))
        self.db.commit()

    def _forget_all(self):
        self.db.execute("DELETE FROM drive_items")
        self.db.commit()

    # --- folders
    def _usable(self, drive_id: str) -> bool:
        """False if the item is gone or in the trash (e.g. deleted in Drive)."""
        from googleapiclient.errors import HttpError
        try:
            meta = self.service.files().get(fileId=drive_id, fields="trashed").execute()
        except HttpError as e:
            if e.resp.status == 404:
                return False
            raise
        return not meta.get("trashed")

    def _create_folder(self, name: str, parent: str | None) -> str:
        body = {"name": name, "mimeType": FOLDER_MIME}
        if parent:
            body["parents"] = [parent]
        return self.service.files().create(body=body, fields="id").execute()["id"]

    def root_id(self) -> str:
        row = self._row("")
        if row and self._usable(row["drive_id"]):
            return row["drive_id"]
        # Root missing or trashed: start the whole mirror over.
        self._forget_all()
        drive_id = self._create_folder(DRIVE_ROOT_NAME, None)
        self._save("", drive_id, True)
        log.info('Created Drive folder "%s"', DRIVE_ROOT_NAME)
        return drive_id

    def folder_id(self, rel_dir: str) -> str:
        if rel_dir in ("", "."):
            return self.root_id()
        row = self._row(rel_dir)
        if row:
            return row["drive_id"]
        parent, _, name = rel_dir.rpartition("/")
        drive_id = self._create_folder(name, self.folder_id(parent))
        self._save(rel_dir, drive_id, True)
        return drive_id

    # --- files
    def _local_files(self):
        for p in sorted(self.papers.rglob("*")):
            rel = p.relative_to(self.papers).as_posix()
            if not p.is_file() or rel.split("/")[0] in SKIP_DIRS or p.name.startswith((".", "~")):
                continue
            yield p, rel

    def _upload(self, path: Path, rel: str, existing_id: str | None) -> str:
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload
        media = MediaFileUpload(str(path), mimetype=MIME_TYPES.get(path.suffix.lower(),
                                                                   "application/octet-stream"))
        files = self.service.files()
        if existing_id:
            try:
                return files.update(fileId=existing_id, media_body=media, fields="id").execute()["id"]
            except HttpError as e:
                if e.resp.status != 404:
                    raise
                # deleted in Drive since; upload it fresh below
        parent = self.folder_id(rel.rpartition("/")[0])
        return files.create(body={"name": path.name, "parents": [parent]},
                            media_body=media, fields="id").execute()["id"]

    def sync(self) -> list[str]:
        """Upload new and changed files. Returns the relative paths uploaded."""
        self.root_id()  # (re)creates the tree if it was deleted in Drive
        for key in ("Homework Sheets", "Homework", "Informational Flyers", "Spelling Sheets",
                    "Subjects", "Results"):
            if (self.papers / key).is_dir():
                self.folder_id(key)  # show the full layout even before it fills
        uploaded = []
        for path, rel in self._local_files():
            st = path.stat()
            row = self._row(rel)
            if row and row["size"] == st.st_size and row["mtime_ns"] == st.st_mtime_ns:
                continue
            sha = _sha256(path)
            if row and row["sha256"] == sha:
                self._save(rel, row["drive_id"], False, sha, st.st_size, st.st_mtime_ns)
                continue
            drive_id = self._upload(path, rel, row["drive_id"] if row else None)
            self._save(rel, drive_id, False, sha, st.st_size, st.st_mtime_ns)
            uploaded.append(rel)
        return uploaded

    def folder_url(self) -> str | None:
        row = self._row("")
        return f"https://drive.google.com/drive/folders/{row['drive_id']}" if row else None
