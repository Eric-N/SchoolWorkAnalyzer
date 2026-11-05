"""Mirror the local output tree (<root>/School Papers) into the Google Drive
for desktop folder, e.g. G:\\My Drive\\School Papers (PC). The Drive app does
the actual uploading, so no Google Cloud project or sign-in is needed here.

Same rules as drive_sync.py: one-way, new files are copied, changed ones are
overwritten in place, nothing is ever deleted from Drive, and a file deleted
in Drive is copied again. A file is up to date when the copy has the same size
and modification time (copy2 keeps the original's mtime), so no state table
is needed. This is used instead of the Drive API whenever the Drive app's
"My Drive" folder is found.
"""

import os
import shutil
import string
from pathlib import Path

from .drive_sync import DRIVE_ROOT_NAME, SKIP_DIRS

MTIME_SLACK_NS = 2_000_000_000  # Drive's file system may round timestamps


def find_my_drive() -> Path | None:
    """The Drive for desktop "My Drive" folder, or None if the app isn't running.
    SPO_MY_DRIVE overrides the search (a folder path)."""
    override = os.environ.get("SPO_MY_DRIVE")
    if override:
        return Path(override) if Path(override).is_dir() else None
    for letter in string.ascii_uppercase:
        p = Path(f"{letter}:/My Drive")
        try:
            if p.is_dir():
                return p
        except OSError:  # empty card reader etc.
            continue
    return None


class FolderSync:
    def __init__(self, papers: Path, my_drive: Path):
        self.papers = papers
        self.dest_root = my_drive / DRIVE_ROOT_NAME

    def _local_files(self):
        for p in sorted(self.papers.rglob("*")):
            rel = p.relative_to(self.papers).as_posix()
            if not p.is_file() or rel.split("/")[0] in SKIP_DIRS or p.name.startswith((".", "~")):
                continue
            yield p, rel

    @staticmethod
    def _up_to_date(src: os.stat_result, dest: Path) -> bool:
        try:
            st = dest.stat()
        except FileNotFoundError:
            return False
        return st.st_size == src.st_size and abs(st.st_mtime_ns - src.st_mtime_ns) <= MTIME_SLACK_NS

    def sync(self) -> list[str]:
        """Copy new and changed files. Returns the relative paths copied."""
        self.dest_root.mkdir(exist_ok=True)
        for key in ("Homework Sheets", "Homework", "Informational Flyers", "Spelling Sheets",
                    "Subjects", "Results"):
            if (self.papers / key).is_dir():
                (self.dest_root / key).mkdir(exist_ok=True)  # show the full layout early
        copied = []
        for path, rel in self._local_files():
            dest = self.dest_root / rel
            if self._up_to_date(path.stat(), dest):
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            copied.append(rel)
        return copied

    def folder_url(self) -> str:
        return str(self.dest_root)
