/**
 * "Is this an event we already know about?"
 *
 * The same test or dress-up day is often mentioned several times (homework
 * sheet, then a flyer, then next week's sheet), worded a little differently
 * each time. Two mentions are the same event when:
 *   - their dates match (a mention with no date is compared on title alone),
 *   - their start times don't conflict (two different times on one day are
 *     two sessions), and
 *   - their titles match after dropping filler words: one title's words are
 *     all in the other ("Dress-Up Day" / "Halloween Dress-Up Day"), or one
 *     squashed title contains the other ("Dress Up" / "Dressup").
 * Different numbers ("Test #3" / "Test #4") or a uniform reminder vs the
 * event itself are never the same event.
 *
 * Pure functions so this can be checked with node; local/spo/events.py is a
 * port of this file — keep them in sync.
 */

// Words that don't tell two events apart.
const SPO_EVENT_FILLER = Object.freeze([
  'the', 'a', 'an', 'and', 'of', 'for', 'on', 'at', 'to', 'in', 'is', 'our', 'your',
  'all', 'day', 'reminder', 'event', 'annual', 'please', 'remember',
]);

// If only one title has one of these, they are different events.
const SPO_EVENT_MARKERS = Object.freeze(['uniform']);

const SPO_MIN_CONTAINED_LENGTH = 4;

function spoEventCore_(title) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/(\w)-(\w)/g, '$1$2') // "dress-up" -> "dressup"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w && SPO_EVENT_FILLER.indexOf(w) < 0)
    .map(w => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w));
  return {
    words,
    joined: words.join(''),
    numbers: words.filter(w => /^\d+$/.test(w)).sort().join(','),
    markers: SPO_EVENT_MARKERS.filter(m => words.indexOf(m) >= 0).join(','),
  };
}

function spoEventTitlesMatch_(a, b) {
  const x = spoEventCore_(a);
  const y = spoEventCore_(b);
  if (!x.words.length || !y.words.length) return false;
  if (x.markers !== y.markers) return false;
  if (x.numbers && y.numbers && x.numbers !== y.numbers) return false;
  const [small, big] = x.words.length <= y.words.length ? [x, y] : [y, x];
  if (small.words.every(w => big.words.indexOf(w) >= 0)) return true;
  const [shorter, longer] = x.joined.length <= y.joined.length ? [x.joined, y.joined] : [y.joined, x.joined];
  return shorter.length >= SPO_MIN_CONTAINED_LENGTH && longer.indexOf(shorter) >= 0;
}

function spoEventStartTime_(event) {
  return event.all_day ? '' : String(event.start_time || '');
}

/**
 * Compare a newly seen event with one known event (both shaped like the
 * extraction schema's events: title, date, start_time, all_day, and
 * needs_review). Returns:
 *   'same'        - a repeat; don't notify again
 *   'more_detail' - the same event, but this mention adds something (a
 *                   start time, or a usable version of a review-only one)
 *   null          - a different event
 */
function spoCompareEvents_(known, event) {
  if (event.date) {
    if (!known.date || String(known.date) !== String(event.date)) return null;
  }
  const knownTime = spoEventStartTime_(known);
  const eventTime = spoEventStartTime_(event);
  if (knownTime && eventTime && knownTime !== eventTime) return null;
  if (!spoEventTitlesMatch_(known.title, event.title)) return null;

  if (known.needs_review && !event.needs_review) return 'more_detail';
  if (!knownTime && eventTime) return 'more_detail';
  return 'same';
}

/** Best match for event among known events: {known, kind} or null. 'same' wins. */
function spoFindKnownEvent_(event, knownEvents) {
  let best = null;
  (knownEvents || []).forEach(known => {
    const kind = spoCompareEvents_(known, event);
    if (kind === 'same' && (!best || best.kind !== 'same')) best = { known, kind };
    else if (kind && !best) best = { known, kind };
  });
  return best;
}
