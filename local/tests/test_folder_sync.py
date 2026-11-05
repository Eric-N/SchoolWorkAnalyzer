import os

from spo.drive_sync import DRIVE_ROOT_NAME
from spo.folder_sync import FolderSync, find_my_drive


def _tree(tmp_path):
    papers = tmp_path / "School Papers"
    (papers / "Spelling Sheets").mkdir(parents=True)
    (papers / "Inbox").mkdir()
    (papers / "Homework").mkdir()
    (papers / "Spelling Sheets" / "words.txt").write_text("a\n", encoding="utf-8")
    (papers / "Inbox" / "scan.pdf").write_bytes(b"%PDF")
    (papers / "Spelling Sheets" / "~lock.txt").write_text("x", encoding="utf-8")
    my_drive = tmp_path / "My Drive"
    my_drive.mkdir()
    return papers, my_drive


def test_copies_new_skips_unchanged_and_inbox(tmp_path):
    papers, my_drive = _tree(tmp_path)
    fs = FolderSync(papers, my_drive)
    assert fs.sync() == ["Spelling Sheets/words.txt"]
    root = my_drive / DRIVE_ROOT_NAME
    assert (root / "Spelling Sheets" / "words.txt").read_text(encoding="utf-8") == "a\n"
    assert (root / "Homework").is_dir()  # empty layout folders are shown too
    assert not (root / "Inbox").exists()
    assert not (root / "Spelling Sheets" / "~lock.txt").exists()
    assert fs.sync() == []


def test_changed_file_overwritten_and_deleted_copy_restored(tmp_path):
    papers, my_drive = _tree(tmp_path)
    fs = FolderSync(papers, my_drive)
    fs.sync()
    src = papers / "Spelling Sheets" / "words.txt"
    src.write_text("a\nb\n", encoding="utf-8")
    st = src.stat()
    os.utime(src, ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000_000))
    assert fs.sync() == ["Spelling Sheets/words.txt"]
    dest = my_drive / DRIVE_ROOT_NAME / "Spelling Sheets" / "words.txt"
    assert dest.read_text(encoding="utf-8") == "a\nb\n"
    dest.unlink()
    assert fs.sync() == ["Spelling Sheets/words.txt"]


def test_never_deletes_from_drive(tmp_path):
    papers, my_drive = _tree(tmp_path)
    fs = FolderSync(papers, my_drive)
    fs.sync()
    (papers / "Spelling Sheets" / "words.txt").unlink()
    fs.sync()
    assert (my_drive / DRIVE_ROOT_NAME / "Spelling Sheets" / "words.txt").exists()


def test_override_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SPO_MY_DRIVE", str(tmp_path))
    assert find_my_drive() == tmp_path
    monkeypatch.setenv("SPO_MY_DRIVE", str(tmp_path / "missing"))
    assert find_my_drive() is None
