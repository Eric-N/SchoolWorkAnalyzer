function spoIcsEscape_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function spoCompactDate_(iso) {
  return String(iso).replace(/-/g, '');
}

function spoNextIsoDate_(iso) {
  const [y,m,d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + 1));
  return Utilities.formatDate(date, 'UTC', 'yyyy-MM-dd');
}

/**
 * "14:30" -> "143000". Returns null when the value isn't a usable HH:MM, so a
 * garbled extraction degrades to an all-day event instead of a broken DTSTART.
 */
function spoCompactTime_(hhmm) {
  const match = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  const pad = n => ('0' + n).slice(-2);
  return `${pad(hours)}${pad(minutes)}00`;
}

/**
 * Default a one-hour duration when only a start time was printed. Clamps at
 * 23:59 rather than rolling past midnight, which would need a DTEND on the
 * following date.
 */
function spoPlusOneHour_(hhmm) {
  const match = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const pad = n => ('0' + n).slice(-2);

  if (hours >= 23) return '235900';
  return `${pad(hours + 1)}${pad(minutes)}00`;
}

/**
 * RFC 5545 requires content lines to be folded at 75 octets. A long flyer
 * DESCRIPTION otherwise produces a file some calendar clients reject outright.
 */
function spoFoldIcsLine_(line) {
  if (line.length <= 73) return line;

  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);

  while (rest.length > 72) {
    parts.push(' ' + rest.slice(0, 72));
    rest = rest.slice(72);
  }

  if (rest.length) parts.push(' ' + rest);

  return parts.join('\r\n');
}

function spoBuildIcs_(event, timezone) {
  if (!event.date) throw new Error('Cannot build ICS without a resolved date.');
  const uidSeed = `${event.title}|${event.date}|${event.start_time || ''}`;
  const uid = spoSha256Text_(uidSeed).slice(0,24) + '@school-paper-organizer';
  const now = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const lines = [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//School Paper Organizer//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'BEGIN:VEVENT',`UID:${uid}`,`DTSTAMP:${now}`
  ];

  const startTime = event.all_day ? null : spoCompactTime_(event.start_time);

  if (!startTime) {
    // All-day events take an exclusive DTEND on the following day.
    lines.push(`DTSTART;VALUE=DATE:${spoCompactDate_(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${spoCompactDate_(spoNextIsoDate_(event.date))}`);
  } else {
    const endTime =
      spoCompactTime_(event.end_time) || spoPlusOneHour_(event.start_time);

    const day = spoCompactDate_(event.date);

    lines.push(`DTSTART;TZID=${timezone}:${day}T${startTime}`);

    // Without a DTEND (or DURATION) many clients drop a timed event or render
    // it as zero-length, so always emit one.
    lines.push(`DTEND;TZID=${timezone}:${day}T${endTime || startTime}`);
  }

  lines.push(`SUMMARY:${spoIcsEscape_(event.title)}`);
  if (event.location) lines.push(`LOCATION:${spoIcsEscape_(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${spoIcsEscape_(event.description)}`);
  lines.push('END:VEVENT','END:VCALENDAR','');
  return lines.map(spoFoldIcsLine_).join('\r\n');
}
