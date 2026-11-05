"""Test-phase command line.

Run from local/:
  .venv/Scripts/python.exe -m spo.cli watch           # process each PDF dropped into SchoolWork
  .venv/Scripts/python.exe -m spo.cli process-inbox   # one pass over new PDFs, then exit
  .venv/Scripts/python.exe -m spo.cli setup           # just create the folders
  .venv/Scripts/python.exe -m spo.cli email-status    # which mail mode is active
  .venv/Scripts/python.exe -m spo.cli test-email      # send one "connected" email
  .venv/Scripts/python.exe -m spo.cli check-replies   # apply spelling replies now
  .venv/Scripts/python.exe -m spo.cli resend-spelling RESULTS.json  # new batch from a saved scan
  .venv/Scripts/python.exe -m spo.cli drive-login CLIENT.json   # one-time Google Drive sign-in
  .venv/Scripts/python.exe -m spo.cli drive-sync      # upload new/changed output now
"""

import argparse
import logging
import sys
from pathlib import Path

from .pipeline import Pipeline, Settings

PROJECT_DIR = Path(__file__).resolve().parents[2]  # the SchoolWork folder
DEFAULT_ROOT = PROJECT_DIR / "Local Test"
LOG_MAX_BYTES = 5_000_000


def _log_to_file_if_hidden(root: Path) -> None:
    """Started by Task Scheduler with pythonw.exe there is no console, so send
    print() and logging to <root>/watcher.log (rolled over to .old when big)."""
    if sys.stdout is not None:
        return
    root.mkdir(parents=True, exist_ok=True)
    log_path = root / "watcher.log"
    if log_path.exists() and log_path.stat().st_size > LOG_MAX_BYTES:
        log_path.replace(log_path.with_suffix(".log.old"))
    sys.stdout = sys.stderr = open(log_path, "a", encoding="utf-8", buffering=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["setup", "process-inbox", "watch", "email-status", "test-email", "check-replies", "resend-spelling",
                                        "drive-login", "drive-sync"])
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--inbox", type=Path, default=PROJECT_DIR, help="drop folder (default: SchoolWork)")
    ap.add_argument("--model", default="qwen2.5vl:32b")
    ap.add_argument("--num-ctx", type=int, default=8192)
    ap.add_argument("results", nargs="?", type=Path, help="resend-spelling: a Results/*-analysis.json; drive-login: the OAuth client JSON")
    args = ap.parse_args()
    _log_to_file_if_hidden(args.root)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s",
                        datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    pipe = Pipeline(Settings(root=args.root, model=args.model, num_ctx=args.num_ctx, inbox=args.inbox))
    if args.command == "setup":
        print(f"Folders ready under {args.root}")
        return
    if args.command == "email-status":
        from .mailer import CREDENTIAL_TARGET, credential
        cred = credential()
        print(f"Real email via Gmail as {cred[0]}" if cred else
              f'Test mode: no "{CREDENTIAL_TARGET}" credential in Windows Credential Manager; '
              f"emails are saved to {pipe.s.outbox}")
        return
    if args.command == "test-email":
        pipe.email("School Paper Organizer is connected",
                   "This is a test email from the School Paper Organizer on your PC.\n\n"
                   "Real emails (school events, upcoming tests, spelling words) will now arrive here.")
        return
    if args.command == "check-replies":
        print(f"Handled {pipe.check_replies()} reply(ies).")
        return
    if args.command == "resend-spelling":
        import json
        analysis = json.loads(args.results.read_text(encoding="utf-8"))
        stem = args.results.name.split("-")[:3]
        scan_date = f"{stem[2]}-{stem[0]}-{stem[1]}"  # MM-DD-YYYY-... -> ISO
        source = args.results.name.split("-analysis")[0]
        pipe.send_spelling_emails(analysis, Path(source + ".pdf"), scan_date, detect_final_test=False)
        return
    if args.command == "drive-login":
        from . import drive_sync
        if not args.results:
            raise SystemExit("Give the downloaded OAuth client file: drive-login <path to client_secret.json>")
        print("A browser window will open; sign in and click Allow.", flush=True)
        print(f"Signed in to Google Drive as {drive_sync.login(args.results)}", flush=True)
        args.command = "drive-sync"
    if args.command == "drive-sync":
        uploaded = pipe.sync_drive()
        if uploaded is None:
            print("Google Drive for desktop isn't running and no drive-login was done.")
        else:
            print(f"{len(uploaded)} file(s) uploaded. Folder: {pipe._drive.folder_url()}")
        return
    if args.command == "watch":
        from .watcher import watch
        watch(pipe)
        return
    files = pipe.new_inbox_files()
    print(f"{len(files)} new PDF(s) in {pipe.s.inbox}", flush=True)
    try:
        for f in files:
            pipe.process(f)
    finally:
        pipe.sweep_work_dirs()
    pipe.sync_drive()
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
