import os
import sqlite3

from googleapiclient.errors import HttpError

from spo.drive_sync import DRIVE_ROOT_NAME, FOLDER_MIME, DriveSync


class _Resp(dict):
    def __init__(self, status):
        super().__init__()
        self.status = status
        self.reason = "fake"


class _Call:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class FakeDrive:
    """Just enough of files().create/update/get for DriveSync."""

    def __init__(self):
        self.items = {}  # id -> {name, parent, folder, trashed, content}
        self.n = 0

    def files(self):
        return self

    def _missing(self, file_id):
        if file_id not in self.items:
            raise HttpError(_Resp(404), b"not found")

    def create(self, body, fields, media_body=None):
        def run():
            self.n += 1
            fid = f"id{self.n}"
            self.items[fid] = {"name": body["name"], "parent": (body.get("parents") or [None])[0],
                               "folder": body.get("mimeType") == FOLDER_MIME, "trashed": False,
                               "content": open(media_body._filename, "rb").read() if media_body else None}
            return {"id": fid}
        return _Call(run)

    def update(self, fileId, media_body, fields):
        def run():
            self._missing(fileId)
            self.items[fileId]["content"] = open(media_body._filename, "rb").read()
            return {"id": fileId}
        return _Call(run)

    def get(self, fileId, fields):
        def run():
            self._missing(fileId)
            return {"trashed": self.items[fileId]["trashed"]}
        return _Call(run)

    def path_of(self, fid):
        parts = []
        while fid:
            parts.append(self.items[fid]["name"])
            fid = self.items[fid]["parent"]
        return "/".join(reversed(parts))

    def files_by_path(self):
        return {self.path_of(i): v["content"] for i, v in self.items.items() if not v["folder"]}


def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row  # as in State
    return conn


def make_tree(papers):
    (papers / "Inbox").mkdir(parents=True)
    (papers / "Inbox" / "ignored.pdf").write_bytes(b"x")
    (papers / "Spelling Sheets").mkdir()
    (papers / "Spelling Sheets" / "words.txt").write_text("18. ???")
    (papers / "Subjects" / "Math").mkdir(parents=True)
    (papers / "Subjects" / "Math" / "math.pdf").write_bytes(b"%PDF math")


def test_uploads_new_then_only_changed(tmp_path):
    papers = tmp_path / "School Papers"
    make_tree(papers)
    drive = FakeDrive()
    sync = DriveSync(db(), papers, service=drive)

    assert sorted(sync.sync()) == ["Spelling Sheets/words.txt", "Subjects/Math/math.pdf"]
    root = DRIVE_ROOT_NAME
    assert drive.files_by_path() == {f"{root}/Spelling Sheets/words.txt": b"18. ???",
                                     f"{root}/Subjects/Math/math.pdf": b"%PDF math"}
    assert not any("Inbox" in drive.path_of(i) for i in drive.items)

    assert sync.sync() == []  # nothing changed
    words = papers / "Spelling Sheets" / "words.txt"
    words.write_text("18. garage")
    os.utime(words, ns=(1, 1))  # make sure the mtime differs
    count = len(drive.items)
    assert sync.sync() == ["Spelling Sheets/words.txt"]
    assert len(drive.items) == count  # updated in place, not a second copy
    assert drive.files_by_path()[f"{root}/Spelling Sheets/words.txt"] == b"18. garage"


def test_recovers_when_things_are_deleted_in_drive(tmp_path):
    papers = tmp_path / "School Papers"
    make_tree(papers)
    drive = FakeDrive()
    sync = DriveSync(db(), papers, service=drive)
    sync.sync()

    # A file deleted in Drive is uploaded again when it next changes.
    fid = next(i for i, v in drive.items.items() if v["name"] == "words.txt")
    del drive.items[fid]
    words = papers / "Spelling Sheets" / "words.txt"
    words.write_text("changed")
    os.utime(words, ns=(2, 2))
    assert sync.sync() == ["Spelling Sheets/words.txt"]
    assert drive.files_by_path()[f"{DRIVE_ROOT_NAME}/Spelling Sheets/words.txt"] == b"changed"

    # The whole tree trashed: everything is rebuilt in a new root folder.
    for v in drive.items.values():
        if v["name"] == DRIVE_ROOT_NAME:
            v["trashed"] = True
    assert sorted(sync.sync()) == ["Spelling Sheets/words.txt", "Subjects/Math/math.pdf"]
    live_roots = [v for v in drive.items.values() if v["name"] == DRIVE_ROOT_NAME and not v["trashed"]]
    assert len(live_roots) == 1
