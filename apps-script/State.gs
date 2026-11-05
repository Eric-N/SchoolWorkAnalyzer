const SPO_SHEETS = Object.freeze({
  SCANS: 'Scans',
  EVENTS: 'Events',
  SPELLING: 'SpellingWords',
  HOMEWORK: 'Homework',
  LOG: 'Log',
  SPELLING_BATCHES: 'SpellingBatches',
  EMAIL_MESSAGES: 'EmailMessages',
});

const SPO_HEADERS = Object.freeze({
  Scans: ['sha256','file_id','file_name','scan_date','processed_at','status','message','output_file_ids'],
  Events: ['signature','title_key','title','event_date','start_time','all_day','first_seen','last_seen','source_file_id','needs_review'],
  SpellingWords: ['word_key','display_word','first_seen','last_seen','active','source_file_id'],
  Homework: ['source_file_id','source_name','scan_date','week_start','week_end','weekday','subject','assignment','source_pages','processed_at'],
  Log: ['timestamp','level','file_id','message'],
  // Added 2026-11-05 (spelling emails + reply corrections, SpellingBatches.gs).
  SpellingBatches: ['batch_id','scan_date','source_file_id','source_name','words_json','words_file_id','created_at','updated_at'],
  EmailMessages: ['gmail_id','rfc_message_id','kind','batch_id','thread_id','summary','at'],
});

function spoState_() {
  const id = spoProps_().getProperty(SPO_PROP.STATE_SPREADSHEET_ID);
  if (!id) throw new Error('No state spreadsheet. Run setupProject().');
  return SpreadsheetApp.openById(id);
}

function spoInitializeState_() {
  const ss = spoState_();
  Object.keys(SPO_HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const wanted = SPO_HEADERS[name];
    if (sh.getLastRow() === 0) {
      sh.appendRow(wanted);
    } else {
      // Additive migration: append any header this version expects that an
      // already-existing sheet doesn't have yet, without touching existing
      // columns or data.
      const existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      const missing = wanted.filter(h => existing.indexOf(h) === -1);
      if (missing.length) {
        sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
      }
    }
    sh.setFrozenRows(1);
  });
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);
}

function spoRowsAsObjects_(sheetName) {
  const sh = spoState_().getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  return values.slice(1).map(row => {
    const o = {};
    headers.forEach((h, i) => o[h] = row[i]);
    return o;
  });
}

function spoFileAlreadyHandled_(fileId) {
  return spoRowsAsObjects_(SPO_SHEETS.SCANS).some(r => String(r.file_id) === String(fileId) && ['processed','duplicate','failed'].includes(String(r.status)));
}

/** A scan that failed for a reason retrying won't fix (see Main.gs). */
function spoHashFailed_(hash) {
  return spoRowsAsObjects_(SPO_SHEETS.SCANS).some(r => String(r.sha256) === hash && String(r.status) === 'failed');
}

/** Sheets added after the first setup are created on the next run. */
function spoEnsureStateSheets_() {
  const ss = spoState_();
  if (Object.keys(SPO_HEADERS).some(name => !ss.getSheetByName(name))) spoInitializeState_();
}

function spoHashAlreadyProcessed_(hash) {
  return spoRowsAsObjects_(SPO_SHEETS.SCANS).some(r => String(r.sha256) === hash && String(r.status) === 'processed');
}

function spoRecordScan_(hash, file, scanDate, status, message, outputFileIds) {
  spoState_().getSheetByName(SPO_SHEETS.SCANS).appendRow([
    hash, file.getId(), file.getName(), scanDate, new Date(), status, message || '',
    (outputFileIds || []).join(',')
  ]);
}

/**
 * Delete every row in `sheetName` for which `matchFn(rowObject)` is true.
 * Deletes bottom-to-top so earlier row indices stay valid mid-loop.
 */
function spoDeleteRowsWhere_(sheetName, matchFn) {
  const sh = spoState_().getSheetByName(sheetName);
  const rows = spoRowsAsObjects_(sheetName);

  const toDelete = rows
    .map((row, i) => ({ row, sheetRow: i + 2 }))
    .filter(({ row }) => matchFn(row));

  toDelete
    .sort((a, b) => b.sheetRow - a.sheetRow)
    .forEach(({ sheetRow }) => sh.deleteRow(sheetRow));

  return toDelete.length;
}

function spoNormalizeText_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function spoSha256Text_(s) {
  return spoHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/**
 * Records an event in the Events sheet (the list of known events) and says
 * whether to notify: 'new', 'updated' (same event with more detail, or a
 * known title on a new date), or 'duplicate' (a repeat mention — no email).
 * Review-only events (no usable date) are recorded too, so their REVIEW
 * NEEDED email isn't repeated either. Matching rules: EventMatching.gs.
 */
function spoRegisterEvent_(event, sourceFileId) {
  const ss = spoState_();
  const sh = ss.getSheetByName(SPO_SHEETS.EVENTS);
  spoEnsureEventsHeader_(sh);
  const rows = spoRowsAsObjects_(SPO_SHEETS.EVENTS);
  const titleKey = spoNormalizeText_(event.title);
  const signature = spoSha256Text_(`${titleKey}|${event.date || ''}|${event.start_time || ''}|${event.all_day ? 1 : 0}`);
  let index = rows.findIndex(r => String(r.signature) === signature);
  let match = index >= 0 ? { kind: 'same' } : null;
  if (!match) {
    const tz = ss.getSpreadsheetTimeZone();
    const known = rows.map(r => spoKnownEventFromRow_(r, tz));
    match = spoFindKnownEvent_(event, known);
    if (match) index = known.indexOf(match.known);
  }

  const now = new Date();
  if (match && match.kind === 'same') {
    sh.getRange(index + 2, 8).setValue(now);
    spoLog_('INFO', sourceFileId,
      `Already known event, not notifying again: "${event.title}" (${event.date || 'no date'}) ` +
      `matches "${rows[index].title}"`);
    return 'duplicate';
  }

  const sameTitle = rows.some(r => String(r.title_key) === titleKey);
  sh.appendRow([signature,titleKey,event.title,event.date || '',event.start_time || '',!!event.all_day,now,now,sourceFileId,!!event.needs_review]);
  return match || sameTitle ? 'updated' : 'new';
}

/** Sheets turns "2026-10-29" / "14:30" into Date cells; turn them back. */
function spoKnownEventFromRow_(row, tz) {
  const asText = (v, fmt) => v instanceof Date ? Utilities.formatDate(v, tz, fmt) : String(v || '');
  const asBool = v => v === true || String(v).toLowerCase() === 'true';
  return {
    title: String(row.title || ''),
    date: asText(row.event_date, 'yyyy-MM-dd'),
    start_time: asText(row.start_time, 'HH:mm'),
    all_day: asBool(row.all_day),
    needs_review: asBool(row.needs_review),
  };
}

/** Sheets created before the needs_review column existed get its header. */
function spoEnsureEventsHeader_(sh) {
  const headers = SPO_HEADERS.Events;
  const col = headers.length;
  if (sh.getLastColumn() < col || sh.getRange(1, col).getValue() !== headers[col - 1]) {
    sh.getRange(1, col).setValue(headers[col - 1]);
  }
}

function spoAddOrRefreshSpellingWord_(word, seenDate, sourceFileId) {
  const key = spoNormalizeText_(word);
  if (!key) return false;
  const sh = spoState_().getSheetByName(SPO_SHEETS.SPELLING);
  const rows = spoRowsAsObjects_(SPO_SHEETS.SPELLING);
  const existing = rows.find(r => String(r.word_key) === key);
  if (existing) {
    const rowIndex = rows.indexOf(existing) + 2;
    const wasActive = String(existing.active).toLowerCase() === 'true';
    sh.getRange(rowIndex, 2, 1, 5).setValues([[word, existing.first_seen || seenDate, seenDate, true, sourceFileId]]);
    return !wasActive;
  }
  sh.appendRow([key,word,seenDate,seenDate,true,sourceFileId]);
  return true;
}

function spoAppendHomework_(analysis, file, scanDate) {
  const sh = spoState_().getSheetByName(SPO_SHEETS.HOMEWORK);
  const now = new Date();

  const sheets = analysis.homework_sheets || [];

  console.log(
    `Homework writer received ${sheets.length} homework sheet(s).`
  );

  sheets.forEach((sheet, sheetIndex) => {
    // New extractor uses source_page (singular).
    // Keep support for the older source_pages shape too.
    let sourcePages = '';

    if (Array.isArray(sheet.source_pages)) {
      sourcePages = sheet.source_pages.join(',');
    } else if (sheet.source_page) {
      sourcePages = String(sheet.source_page);
    }

    const homework = sheet.homework || {};

    console.log(
      `Homework sheet ${sheetIndex + 1}: ` +
      `page=${sourcePages || 'unknown'}, ` +
      `week=${sheet.week_date_text || 'unknown'}, ` +
      `days=${Object.keys(homework).join(',')}`
    );

    let rowsAdded = 0;

    Object.keys(homework).forEach(day => {
      const assignments = Array.isArray(homework[day])
        ? homework[day]
        : [];

      assignments.forEach(item => {
        sh.appendRow([
          file.getId(),
          file.getName(),
          scanDate,

          // We aren't extracting resolved week_start/week_end yet.
          sheet.week_start || '',
          sheet.week_end || '',

          day,
          item.subject || '',
          item.assignment || '',
          sourcePages,
          now
        ]);

        rowsAdded++;
      });
    });

    console.log(
      `Added ${rowsAdded} homework row(s) from homework sheet ${sheetIndex + 1}.`
    );
  });
}

function spoLog_(level, fileId, message) {
  console.log(`[${level}] ${message}`);
  try {
    spoState_().getSheetByName(SPO_SHEETS.LOG).appendRow([new Date(),level,fileId || '',message]);
  } catch (e) {
    console.log('Could not write log row: ' + e);
  }
}
