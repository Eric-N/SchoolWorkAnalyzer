"""Drop-a-scan trigger: poll the drop folder and process each new PDF.

Polling (every few seconds) instead of filesystem events: the folder lives in
OneDrive, which writes and re-writes files in ways that make change events
noisy, and a scan is only processed once its size has stopped changing.
Only *.pdf directly in the drop folder count; subfolders are ignored.

Scans are processed one at a time, oldest drop first. Anything dropped while
a scan is running is picked up as soon as it finishes.
"""

import logging
import msvcrt
import time
from pathlib import Path

from . import llm
from .pipeline import BadScan, Pipeline, TransientError

log = logging.getLogger(__name__)

POLL_SECONDS = 5
STABLE_SECONDS = 10  # size + mtime unchanged this long = finished copying
RETRY_SECONDS = 60  # after the local model was unavailable
REPLY_CHECK_SECONDS = 120  # spelling-correction replies
DRIVE_SYNC_SECONDS = 600  # catch-up upload; also right after each scan / reply


def _signature(path: Path) -> tuple[int, float] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime


def _single_instance(lock_path: Path):
    """Hold an exclusive lock for the life of the process, or exit."""
    f = open(lock_path, "a+")
    f.seek(0)  # msvcrt locks from the current position; "a+" starts at the end
    try:
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        f.close()
        raise SystemExit(f"Another watcher is already running ({lock_path}).")
    return f  # keep a reference so the lock isn't released


def _other_files(inbox: Path) -> set[str]:
    return {p.name for p in inbox.iterdir() if p.is_file() and p.suffix.lower() != ".pdf"}


def watch(pipe: Pipeline) -> None:
    lock = _single_instance(pipe.s.root / "watcher.lock")  # noqa: F841
    inbox = pipe.s.inbox
    say = lambda msg: pipe.state.log("INFO", "", msg)
    pipe.sweep_work_dirs()
    say(f"Watching {inbox} for new scans.")

    ignored = _other_files(inbox)  # project files already there aren't news
    pipe.new_inbox_files()
    known_duplicates = {(p, _signature(p)) for p in pipe.already_processed}
    seen: dict[Path, tuple[tuple[int, float], float]] = {}  # path -> (signature, stable since)
    failed: dict[Path, tuple[int, float]] = {}  # don't retry a failure until the file changes
    model_down_until = 0.0
    model_down_reported = False
    next_reply_check = 0.0
    reply_error_reported = False
    next_drive_sync = 0.0
    drive_error_reported = False
    while True:
        try:
            now = time.monotonic()

            for name in sorted(_other_files(inbox) - ignored):
                say(f"Ignoring {name}: only PDF files are processed.")
                ignored.add(name)

            if time.monotonic() >= next_drive_sync:
                next_drive_sync = time.monotonic() + DRIVE_SYNC_SECONDS
                try:
                    pipe.sync_drive()
                    if drive_error_reported:
                        say("Uploading to Google Drive works again.")
                        drive_error_reported = False
                except Exception as e:  # offline, sign-in revoked; files stay local until it works
                    if not drive_error_reported:
                        pipe.state.log("WARN", "", f"Couldn't upload to Google Drive (will keep trying): {e!r}")
                        drive_error_reported = True
                    next_drive_sync = time.monotonic() + RETRY_SECONDS

            if time.monotonic() >= next_reply_check:
                next_reply_check = time.monotonic() + REPLY_CHECK_SECONDS
                try:
                    if pipe.check_replies():
                        next_drive_sync = 0.0  # upload the corrected word file
                    if reply_error_reported:
                        say("Checking email for replies works again.")
                        reply_error_reported = False
                except Exception as e:  # offline, Gmail hiccup, bad password
                    if not reply_error_reported:
                        pipe.state.log("WARN", "", f"Couldn't check email for replies (will keep trying): {e!r}")
                        reply_error_reported = True

            # Oldest drop first, so a batch is processed in the order it arrived.
            pending = sorted(pipe.new_inbox_files(), key=lambda p: (_signature(p) or (0, 0))[1])
            for p in pipe.already_processed:
                if (p, _signature(p)) not in known_duplicates:
                    say(f"Skipping {p.name}: this exact scan was already processed (under this or another name).")
                    known_duplicates.add((p, _signature(p)))
            for path in pending:
                sig = _signature(path)
                if sig is None or sig[0] == 0 or failed.get(path) == sig:
                    continue
                prev = seen.get(path)
                if not prev or prev[0] != sig:
                    if not prev:
                        say(f"Found {path.name}; waiting for it to finish copying.")
                    seen[path] = (sig, now)
                    continue
                if time.monotonic() - prev[1] < STABLE_SECONDS or time.monotonic() < model_down_until:
                    continue
                if not llm.ollama_available():
                    if not model_down_reported:
                        say(f"The local model (Ollama) isn't responding; {path.name} will start "
                            f"once it's back (checking every {RETRY_SECONDS}s).")
                        model_down_reported = True
                    model_down_until = time.monotonic() + RETRY_SECONDS
                    break
                if model_down_reported:
                    say("The local model is responding again.")
                    model_down_reported = False
                try:
                    pipe.process(path)
                    failed.pop(path, None)
                    known_duplicates.add((path, sig))  # it's now "processed"; not a duplicate drop
                except TransientError as e:
                    say(f"Will retry {path.name} in {RETRY_SECONDS}s: {e}")
                    model_down_until = time.monotonic() + RETRY_SECONDS
                    break
                except BadScan:
                    failed[path] = sig  # already logged and emailed; retried only if the file changes
                except Exception:
                    log.exception("Processing failed: %s (will retry if the file changes)", path.name)
                    failed[path] = sig
                seen.pop(path, None)
                next_drive_sync = 0.0  # upload this scan's output on the next pass
                pipe.sweep_work_dirs()  # a failed open can hold its copy until the error is handled
                break  # rescan after each scan, so new drops and replacements are seen
        except Exception:  # e.g. OneDrive briefly locking the folder; keep watching
            log.exception("Watcher loop error; continuing")
        time.sleep(POLL_SECONDS)
