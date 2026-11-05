function spoSaveHomeworkManifest_(
  homeworkSheets,
  file,
  scanDate
) {
  if (
    !Array.isArray(homeworkSheets) ||
    !homeworkSheets.length
  ) {
    return;
  }

  const props =
    PropertiesService.getScriptProperties();

  // Normally there is one weekly homework sheet.
  // If multiple are returned, use the final one.
  const sheet =
    homeworkSheets[homeworkSheets.length - 1];

  const manifest = {
    source_file_id: file.getId(),
    source_file_name: file.getName(),
    scan_date: scanDate,

    teacher:
      sheet.teacher || null,

    grade:
      sheet.grade || null,

    room:
      sheet.room || null,

    week_number:
      sheet.week_number || null,

    week_date_text:
      sheet.week_date_text || null,

    homework:
      sheet.homework || {},

    saved_at:
      new Date().toISOString(),
  };

  props.setProperty(
    'CURRENT_HOMEWORK_MANIFEST',
    JSON.stringify(manifest)
  );

  // Week-aware history (2026-11-05): the sheet for NEXT week often comes
  // home on Thursday/Friday, so the newest sheet isn't always today's.
  const history = spoManifestHistory_()
    .filter(m => m.week_date_text !== manifest.week_date_text || m.scan_date !== manifest.scan_date);
  history.push(manifest);
  spoStoreManifestHistory_(history);

  console.log(
    `Saved current homework manifest from ${file.getName()}`
  );

  console.log(
    `Manifest week: ${
      manifest.week_date_text || 'unknown'
    }`
  );
}


const SPO_MANIFEST_HISTORY_PROP = 'HOMEWORK_MANIFEST_HISTORY';
const SPO_MANIFEST_HISTORY_KEEP = 4;

function spoManifestHistory_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SPO_MANIFEST_HISTORY_PROP);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (e) {
    console.log('Could not parse ' + SPO_MANIFEST_HISTORY_PROP + ': ' + e);
    return [];
  }
}

function spoStoreManifestHistory_(list) {
  PropertiesService.getScriptProperties().setProperty(
    SPO_MANIFEST_HISTORY_PROP, JSON.stringify(list.slice(-SPO_MANIFEST_HISTORY_KEEP)));
}

/**
 * The manifest for scanDate's week, from newest to oldest:
 *   1. one whose printed week (Monday-Sunday) contains scanDate;
 *   2. else one with no readable week that was scanned in the 6 days before.
 * null when none fits, so homework matching is skipped rather than run
 * against an old week's assignments. Pure; checked with node.
 */
function spoPickManifest_(manifests, scanDate) {
  const list = (manifests || []).slice().reverse();
  const dayDiff = (a, b) => (Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
  for (const m of list) {
    const monday = spoWeekMonday_(m.week_date_text, m.scan_date || scanDate);
    if (monday && dayDiff(scanDate, monday) >= 0 && dayDiff(scanDate, monday) <= 6) return m;
  }
  for (const m of list) {
    if (spoWeekMonday_(m.week_date_text, m.scan_date || scanDate)) continue;
    const age = m.scan_date ? dayDiff(scanDate, m.scan_date) : NaN;
    if (age >= 0 && age <= 6) return m;
  }
  return null;
}

function spoLoadHomeworkManifest_(scanDate) {
  if (scanDate) {
    const history = spoManifestHistory_();
    if (history.length) return spoPickManifest_(history, scanDate);
  }
  const raw =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        'CURRENT_HOMEWORK_MANIFEST'
      );

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.log(
      'Could not parse CURRENT_HOMEWORK_MANIFEST: ' +
      e
    );

    return null;
  }
}


/**
 * Resolve the weekday's assignments from the
 * currently saved weekly homework manifest.
 */
function spoHomeworkForScanDate_(
  manifest,
  scanDate
) {
  if (
    !manifest ||
    !manifest.homework
  ) {
    return null;
  }

  const parts =
    String(scanDate).split('-');

  if (parts.length !== 3) {
    return null;
  }

  const year =
    Number(parts[0]);

  const month =
    Number(parts[1]) - 1;

  const day =
    Number(parts[2]);

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  // Noon avoids edge cases around midnight and DST.
  const d =
    new Date(
      year,
      month,
      day,
      12,
      0,
      0
    );

  const weekdayMap = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];

  const weekday =
    weekdayMap[d.getDay()];

  if (
    weekday === 'saturday' ||
    weekday === 'sunday'
  ) {
    return {
      date: scanDate,
      weekday,
      assignments: [],
    };
  }

  const assignments =
    Array.isArray(
      manifest.homework[weekday]
    )
      ? manifest.homework[weekday]
      : [];

  return {
    date: scanDate,
    weekday,
    assignments,
  };
}


/**
 * Useful manual debugging helper.
 *
 * Run this from the Apps Script editor if you
 * want to see the currently stored manifest.
 */
function debugCurrentHomeworkManifest() {
  const manifest =
    spoLoadHomeworkManifest_();

  if (!manifest) {
    console.log(
      'No current homework manifest is stored.'
    );

    return;
  }

  console.log(
    JSON.stringify(
      manifest,
      null,
      2
    )
  );
}
