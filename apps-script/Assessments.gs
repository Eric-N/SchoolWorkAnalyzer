/**
 * Upcoming tests from the weekly homework sheet, emailed as all-day .ics
 * events.
 *
 * Homework extraction gives each assessment only a weekday ("Friday") plus
 * the sheet's week text ("October 12 - October 16"), so the date is resolved
 * here: Monday of the sheet's week + the weekday, +7 days for next week's
 * list. Anything that can't be resolved safely is listed for review instead
 * of guessed.
 *
 * Pure date math (no Utilities) so it can be checked with node
 * (tests/run-tests.js). Ordinal dates and spoResolveYear_ were ported back
 * from the local version on 2026-11-05.
 */

const SPO_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SPO_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function spoIsoFromUtc_(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Monday (ISO yyyy-MM-dd) of the week named by week_date_text, or null.
 * Reads the FIRST date in the text: "October 12 - October 16", "Oct. 12-16",
 * "November 2nd - November 6th" or "10/12 - 10/16". The year comes from the scan date, picking whichever
 * of last/this/next year lands closest to it (a sheet scanned Dec 30 for
 * the week of Jan 4).
 */
function spoWeekMonday_(weekDateText, scanDate) {
  const text = String(weekDateText || '').toLowerCase();
  let month = null;
  let day = null;
  let m;
  const named = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g; // skips "week 9"
  while ((m = named.exec(text))) {
    if (SPO_MONTHS.indexOf(m[1]) >= 0) {
      month = SPO_MONTHS.indexOf(m[1]);
      day = Number(m[2]);
      break;
    }
  }
  if (month === null && (m = text.match(/\b(\d{1,2})\/(\d{1,2})\b/))) {
    month = Number(m[1]) - 1;
    day = Number(m[2]);
  }
  if (month === null || month > 11 || day < 1 || day > 31) return null;

  const [sy, sm, sd] = String(scanDate).split('-').map(Number);
  const scan = Date.UTC(sy, sm - 1, sd);
  let best = null;
  [sy - 1, sy, sy + 1].forEach(y => {
    const t = Date.UTC(y, month, day);
    if (new Date(t).getUTCDate() !== day) return; // e.g. Feb 30
    if (best === null || Math.abs(t - scan) < Math.abs(best - scan)) best = t;
  });
  if (best === null) return null;

  const mondayOffset = (new Date(best).getUTCDay() + 6) % 7;
  return spoIsoFromUtc_(new Date(best - mondayOffset * 86400000));
}

// An event announced with no year is taken to be upcoming; this much slack
// keeps one that just happened (a thank-you flyer) in the current year.
const SPO_PAST_SLACK_DAYS = 60;

/**
 * The model's event date with the year re-chosen when no year is printed in
 * date_text: the first year that doesn't put the date more than
 * SPO_PAST_SLACK_DAYS before the scan. (Veteran's Day on an Oct 2026 sheet
 * once came back as 2024-11-11.) Anything unparseable is returned as is.
 */
function spoResolveYear_(dateIso, dateText, scanDate) {
  if (/\b(?:19|20)\d{2}\b|\d{1,2}\/\d{1,2}\/\d{2}\b|'\d{2}\b/.test(String(dateText || ''))) return dateIso;
  const d = String(dateIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const s = String(scanDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d || !s) return dateIso;
  const month = Number(d[2]) - 1;
  const day = Number(d[3]);
  const scan = Date.UTC(Number(s[1]), Number(s[2]) - 1, Number(s[3]));
  for (let y = Number(s[1]) - 1; y <= Number(s[1]) + 1; y++) {
    const t = Date.UTC(y, month, day);
    if (new Date(t).getUTCDate() !== day) continue; // Feb 29 in a non-leap year
    if (t >= scan - SPO_PAST_SLACK_DAYS * 86400000) return spoIsoFromUtc_(new Date(t));
  }
  return dateIso;
}

/** ISO date for a weekday name in the week starting at mondayIso, or null. */
function spoWeekdayDate_(mondayIso, dayName, weekOffset) {
  const key = String(dayName || '').trim().toLowerCase().slice(0, 3);
  const index = SPO_WEEKDAYS.indexOf(key);
  if (!mondayIso || index < 0) return null;
  const [y, m, d] = mondayIso.split('-').map(Number);
  return spoIsoFromUtc_(new Date(Date.UTC(y, m - 1, d + index + 7 * weekOffset)));
}

/** Event objects (the shape spoBuildIcs_ takes) for one homework sheet's tests. */
function spoAssessmentEvents_(sheet, scanDate) {
  const monday = spoWeekMonday_(sheet.week_date_text, scanDate);
  const weekLabel = sheet.week_date_text || '(week not printed)';
  const events = [];
  [
    [sheet.assessments_this_week, 0, 'this week'],
    [sheet.assessments_next_week, 1, 'next week'],
  ].forEach(([list, weekOffset, when]) => {
    (list || []).forEach(a => {
      const title = String(a.assessment || '').trim();
      if (!title) return;
      const date = spoWeekdayDate_(monday, a.day, weekOffset);
      events.push({
        title,
        date_text: `${a.day || '(no day)'}, ${when} (homework sheet for ${weekLabel})`,
        date,
        time_text: null,
        start_time: null,
        end_time: null,
        all_day: true,
        location: null,
        description: `Listed under ${when}'s assessments on the homework sheet for ${weekLabel}.`,
        confidence: 1,
        needs_review: !date,
      });
    });
  });
  return events;
}

/**
 * One "Upcoming tests" email per scan, with an .ics per test that hasn't
 * been emailed before. Tests already known from the Events sheet (e.g. last
 * week's "next week" list, or a flyer about the same test) are skipped, and
 * so are review-only tests already listed once; no email if nothing is new.
 */
function spoSendAssessmentEmail_(analysis, file, scanDate, config) {
  const fresh = [];
  const review = [];
  (analysis.homework_sheets || []).forEach(sheet => {
    spoAssessmentEvents_(sheet, scanDate).forEach(event => {
      const status = spoRegisterEvent_(event, file.getId());
      if (status === 'duplicate') return;
      if (event.needs_review) {
        review.push(event);
        return;
      }
      fresh.push({ event, status });
    });
  });
  if (!fresh.length && !review.length) return;

  fresh.sort((a, b) => a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : 0);
  const attachments = fresh.map(({ event }) => Utilities.newBlob(
    spoBuildIcs_(event, config.timezone),
    'text/calendar',
    `${event.date}-${spoSafeSlug_(event.title)}.ics`
  ));

  const body = [];
  if (fresh.length) {
    body.push('Upcoming tests from the homework sheet (calendar invites attached):', '');
    fresh.forEach(({ event, status }) => {
      body.push(`- ${event.date}: ${event.title}${status === 'updated' ? ' [UPDATED]' : ''}`);
    });
    body.push('');
  }
  if (review.length) {
    body.push('REVIEW NEEDED: could not work out the date for these tests (no invite attached):', '');
    review.forEach(event => body.push(`- ${event.title} — ${event.date_text}`));
    body.push('');
  }
  body.push(`Source: ${file.getName()}`);

  const subject = fresh.length
    ? `Upcoming tests: ${fresh.length} new`
    : 'REVIEW NEEDED: upcoming tests';
  spoSendEmail_(config.notificationEmail, subject, body.join('\n'), attachments);
}
