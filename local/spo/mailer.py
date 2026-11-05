"""Email transport: the project Gmail account (SMTP + IMAP, app password), or
a local outbox folder when no credential is stored.

The app password lives in Windows Credential Manager as a generic credential:
  address:   School Paper Organizer Gmail
  user name: the account's Gmail address
  password:  the 16-character app password
It's looked up on every send, so adding it switches to real email without a
restart. Emails always go to the account itself (it's shared by the family).
"""

import email
import imaplib
import logging
import re
import smtplib
from dataclasses import dataclass
from datetime import datetime
from email import policy
from email.message import EmailMessage
from email.utils import make_msgid
from pathlib import Path

log = logging.getLogger(__name__)

CREDENTIAL_TARGET = "School Paper Organizer Gmail"
SENDER_NAME = "School Paper Organizer"
MSGID_DOMAIN = "school-paper-organizer.local"
REPLY_LOOKBACK_DAYS = 30


@dataclass
class Incoming:
    message_id: str
    in_reply_to: str
    references: str
    subject: str
    body: str


def credential():
    """(address, app_password) from Windows Credential Manager, or None."""
    try:
        import keyring
        cred = keyring.get_credential(CREDENTIAL_TARGET, None)
    except Exception as e:  # no backend / vault unavailable
        log.warning("Credential Manager lookup failed: %s", e)
        return None
    if not cred or not cred.username or not cred.password:
        return None
    return cred.username.strip(), cred.password.replace(" ", "")


def build_message(sender: str, to: str, subject: str, body: str, attachments=(),
                  in_reply_to: str | None = None, references: str | None = None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f"{SENDER_NAME} <{sender}>" if "@" in sender else sender
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=MSGID_DOMAIN)
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = f"{references or ''} {in_reply_to}".strip()
    msg.set_content(body)
    for filename, ics in attachments:
        msg.add_attachment(ics.encode("utf-8"), maintype="text", subtype="calendar", filename=filename)
    return msg


def body_text(msg) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    text = part.get_content()
    if part.get_content_type() == "text/html":
        text = re.sub(r"(?i)<br\s*/?>|</p>|</div>", "\n", text)
        text = re.sub(r"(?is)<blockquote.*", "", text)  # quoted original
        text = re.sub(r"<[^>]+>", "", text)
    return text


def _incoming(raw: bytes) -> Incoming:
    msg = email.message_from_bytes(raw, policy=policy.default)
    return Incoming(
        message_id=str(msg.get("Message-ID", "")).strip(),
        in_reply_to=str(msg.get("In-Reply-To", "")).strip(),
        references=str(msg.get("References", "")).strip(),
        subject=str(msg.get("Subject", "")),
        body=body_text(msg),
    )


class Mailer:
    """Picks Gmail or the outbox per call, based on the stored credential."""

    def __init__(self, outbox: Path, simulated_replies: Path):
        self.outbox = outbox
        self.simulated_replies = simulated_replies

    @property
    def live(self) -> bool:
        return credential() is not None

    def send(self, subject, body, attachments=(), in_reply_to=None, references=None) -> tuple[str, str]:
        """Returns (message_id, where) — where is 'gmail' or the .eml path."""
        cred = credential()
        if cred:
            addr, pw = cred
            msg = build_message(addr, addr, subject, body, attachments, in_reply_to, references)
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60) as s:
                s.login(addr, pw)
                s.send_message(msg)
            return msg["Message-ID"], "gmail"
        msg = build_message(SENDER_NAME, "(test run - not sent)", subject, body, attachments, in_reply_to, references)
        self.outbox.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
        slug = (re.sub(r"[^a-z0-9]+", "-", subject.lower()).strip("-") or "email")[:60]
        out = self.outbox / f"{stamp}-{slug}.eml"
        out.write_bytes(bytes(msg))
        return msg["Message-ID"], str(out)

    def fetch_candidate_replies(self) -> list[Incoming]:
        """Recent messages the family SENT from the account that might be
        replies to the organizer. Only Sent mail counts, so nobody outside
        the account can feed corrections in by spoofing the address."""
        cred = credential()
        if not cred:
            return [_incoming(p.read_bytes()) for p in sorted(self.simulated_replies.glob("*.eml"))]
        addr, pw = cred
        out = []
        with imaplib.IMAP4_SSL("imap.gmail.com", timeout=60) as m:
            m.login(addr, pw)
            box = _all_mail_box(m)
            m.select(box, readonly=True)
            # "spelling" matches the reply's subject ("Re: This week's spelling
            # words") or its quoted body (which carries the spelling-ref token).
            query = f"in:sent newer_than:{REPLY_LOOKBACK_DAYS}d spelling"
            typ, data = m.uid("SEARCH", "X-GM-RAW", f'"{query}"')
            if typ != "OK":
                raise RuntimeError(f"IMAP search failed: {data}")
            for uid in (data[0] or b"").split():
                typ, parts = m.uid("FETCH", uid, "(BODY.PEEK[])")
                raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
                if raw:
                    out.append(_incoming(raw))
        return out


def _all_mail_box(m: imaplib.IMAP4_SSL) -> str:
    """The All Mail folder (its name depends on the account's language)."""
    typ, boxes = m.list()
    for line in boxes or []:
        s = line.decode("utf-8", "replace")
        if "\\All" in s:
            name = s.rsplit(' "/" ', 1)[-1].strip()
            return name if name.startswith('"') else f'"{name}"'
    return '"[Gmail]/All Mail"'
