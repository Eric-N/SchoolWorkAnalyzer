/**
 * Spelling batches, the Drive / Gmail / Sheet side (ported back from the
 * local version on 2026-11-05; the pure logic is in Spelling.gs).
 *
 *  - A new week's list (the pre-test) becomes a batch (SpellingBatches sheet),
 *    a text file Spelling Words/MM-DD-YYYY-spelling-words.txt with ??? for
 *    unclear words, and ONE email "This week's spelling words (MM-DD-YYYY)".
 *  - The same list scanned again within 14 days is the final test: its pages
 *    are filed as -spelling-test.pdf with a -spelling-test.txt results file,
 *    and there is no batch, no email and no needs-help words.
 *  - checkSpellingReplies() (run at the end of every processInbox) reads
 *    replies such as "18 = garage", fixes the batch and its text file, and
 *    answers in the same thread with the updated list. Each reply is
 *    handled once (EmailMessages sheet).
 */

// --- Sheet helpers. Every value is stored as plain text, so Sheets doesn't
// turn "2026-11-02" into a date or "1" into a number.

function spoAppendTextRow_(sheetName, values) {
  const sh = spoState_().getSheetByName(sheetName);
  const row = sh.getLastRow() + 1;
  const range = sh.getRange(row, 1, 1, values.length);
  range.setNumberFormat('@');
  range.setValues([values.map(v => (v === null || v === undefined ? '' : String(v)))]);
}

function spoSetTextCells_(sheetName, sheetRow, fields) {
  const sh = spoState_().getSheetByName(sheetName);
  const headers = SPO_HEADERS[sheetName];
  Object.keys(fields).forEach(k => {
    const col = headers.indexOf(k) + 1;
    if (col < 1) throw new Error(`No column ${k} in ${sheetName}`);
    sh.getRange(sheetRow, col).setNumberFormat('@').setValue(String(fields[k] ?? ''));
  });
}

function spoAsIsoText_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, SPO_DEFAULTS.LOCAL_TIMEZONE, 'yyyy-MM-dd');
  return String(v || '');
}

// --- batches

function spoSpellingBatches_() {
  return spoRowsAsObjects_(SPO_SHEETS.SPELLING_BATCHES).map((r, i) => ({
    id: Number(r.batch_id),
    scan_date: spoAsIsoText_(r.scan_date),
    source_file_id: String(r.source_file_id || ''),
    source_name: String(r.source_name || ''),
    words: JSON.parse(String(r.words_json || '[]')),
    words_file_id: String(r.words_file_id || ''),
    sheetRow: i + 2,
  }));
}

function spoSpellingBatch_(batchId) {
  return spoSpellingBatches_().find(b => b.id === Number(batchId)) || null;
}

function spoNewSpellingBatch_(scanDate, file, words) {
  const ids = spoSpellingBatches_().map(b => b.id).filter(Number.isFinite);
  const id = Math.max(0, ...ids) + 1;
  const now = new Date().toISOString();
  spoAppendTextRow_(SPO_SHEETS.SPELLING_BATCHES,
    [id, scanDate, file.getId(), file.getName(), JSON.stringify(words), '', now, now]);
  return spoSpellingBatch_(id);
}

function spoUpdateSpellingBatch_(batch, fields) {
  spoSetTextCells_(SPO_SHEETS.SPELLING_BATCHES, batch.sheetRow,
    Object.assign({}, fields, { updated_at: new Date().toISOString() }));
}

function spoSpellingWordsFolder_(config) {
  return spoLazyFolder_(config, 'spellingWordsFolderId', SPO_PROP.SPELLING_WORDS_FOLDER_ID,
    SPO_DEFAULTS.SPELLING_WORDS_FOLDER_NAME);
}

/** Creates the batch's text file, or rewrites it in place after a correction. */
function spoWriteWordsFile_(batch, words, config) {
  const text = spoRenderWordsFile_(words, spoDateLabel_(batch.scan_date), batch.source_name);
  if (batch.words_file_id) {
    try {
      const existing = DriveApp.getFileById(batch.words_file_id);
      if (!existing.isTrashed()) {
        existing.setContent(text);
        return existing;
      }
    } catch (e) {
      console.log(`Words file for batch ${batch.id} is gone (${e}); making a new one.`);
    }
  }
  const folder = spoSpellingWordsFolder_(config);
  const name = spoVersionedName_(folder, `${spoDateLabel_(batch.scan_date)}-spelling-words.txt`);
  const created = folder.createFile(name, text, MimeType.PLAIN_TEXT);
  spoUpdateSpellingBatch_(batch, { words_file_id: created.getId() });
  batch.words_file_id = created.getId();
  return created;
}

/**
 * The pre-test batch this scan's spelling sheet is the final test of, or null
 * for a new week's pre-test. Worked out once and kept in the analysis (and
 * so in the Results JSON) as spelling_final_test_of.
 */
function spoSpellingFinalTestOf_(analysis, scanDate, file) {
  if (Object.prototype.hasOwnProperty.call(analysis, 'spelling_final_test_of')) {
    return analysis.spelling_final_test_of;
  }
  const words = spoWordsFromSheets_(analysis.spelling_sheets);
  let match = null;
  if (words.length) {
    const first = spoIsoFromUtc_(new Date(Date.parse(scanDate + 'T00:00:00Z') - SPO_PRETEST_WINDOW_DAYS * 86400000));
    const recent = spoSpellingBatches_()
      .filter(b => b.scan_date >= first && b.scan_date <= scanDate)
      .sort((a, b) => b.id - a.id);
    for (const batch of recent) {
      if (spoIsSameList_(words, batch.words)) {
        match = {
          batch_id: batch.id,
          pretest_scan_date: batch.scan_date,
          pretest_source: batch.source_name,
          shared_words: spoSharedWords_(words, batch.words),
        };
        spoLog_('INFO', file.getId(),
          `Spelling sheet is the final test for the ${spoDateLabel_(batch.scan_date)} pre-test ` +
          `(batch ${batch.id}, ${match.shared_words} shared words); filing it without an email`);
        break;
      }
    }
  }
  analysis.spelling_final_test_of = match;
  return match;
}

/** Returns the Drive files it created. */
function spoSendSpellingEmails_(analysis, file, scanDate, config) {
  const words = spoWordsFromSheets_(analysis.spelling_sheets);
  if (!words.length) return [];
  const label = spoDateLabel_(scanDate);

  const finalTest = spoSpellingFinalTestOf_(analysis, scanDate, file);
  if (finalTest) {
    const folder = spoSpellingWordsFolder_(config);
    const name = spoVersionedName_(folder, `${label}-spelling-test.txt`);
    const text = spoRenderTestFile_(words, label, spoDateLabel_(finalTest.pretest_scan_date), file.getName());
    const out = folder.createFile(name, text, MimeType.PLAIN_TEXT);
    spoLog_('INFO', file.getId(), `Wrote Spelling Words/${name}`);
    return [out];
  }

  const batch = spoNewSpellingBatch_(scanDate, file, words);
  const wordsFile = spoWriteWordsFile_(batch, words, config);
  spoLog_('INFO', file.getId(), `Wrote Spelling Words/${wordsFile.getName()} (batch ${batch.id})`);
  words.forEach(w => {
    if (w.needs_work && !w.unclear) spoAddOrRefreshSpellingWord_(w.word, scanDate, file.getId());
  });
  spoSendTrackedEmail_(config, `This week's spelling words (${label})`,
    spoRenderSpellingEmail_(words, file.getName(), batch.id), 'spelling', batch.id, null);
  return [wordsFile];
}

// --- email that can be replied to

/**
 * Sends through Gmail (a draft that is sent at once, which hands back the
 * message) so replies can be matched to it later. With replyTo, answers in
 * that message's thread. Records the message as ours in EmailMessages.
 */
function spoSendTrackedEmail_(config, subject, body, kind, batchId, replyTo) {
  const options = { name: 'School Paper Organizer' };
  const draft = replyTo
    ? replyTo.createDraftReply(body, options)
    : GmailApp.createDraft(config.notificationEmail, subject, body, options);
  const sent = draft.send();
  let rfcId = '';
  try {
    rfcId = sent.getHeader('Message-ID') || '';
  } catch (e) {
    console.log('Could not read the sent Message-ID: ' + e);
  }
  spoRecordEmail_(sent.getId(), rfcId, kind, batchId, sent.getThread().getId(), sent.getSubject());
  console.log(`Emailed ${config.notificationEmail}: ${sent.getSubject()}`);
  return sent;
}

function spoRecordEmail_(gmailId, rfcId, kind, batchId, threadId, summary) {
  spoAppendTextRow_(SPO_SHEETS.EMAIL_MESSAGES,
    [gmailId || '', rfcId || '', kind, batchId ?? '', threadId || '', summary || '', new Date().toISOString()]);
}

// --- replies

/**
 * Apply corrections from replies to spelling emails. Returns how many
 * replies were handled. Safe to run any time; processInbox runs it every
 * 5 minutes.
 *
 * A reply counts when it's a message in the last 30 days that:
 *  - wasn't sent by the organizer (our messages are recorded, and they are
 *    all sent under the name "School Paper Organizer"),
 *  - comes from this account or the NOTIFICATION_EMAIL address, and
 *  - answers a spelling email (by its In-Reply-To/References headers, its
 *    thread, or the "(spelling-ref-N)" token in the quoted text).
 */
function checkSpellingReplies() {
  const config = spoConfig_();
  const records = spoRowsAsObjects_(SPO_SHEETS.EMAIL_MESSAGES);
  if (!records.some(r => String(r.kind) === 'spelling')) return 0;

  const known = {};
  const batchByRfc = {};
  const batchByThread = {};
  records.forEach(r => {
    if (r.gmail_id) known[String(r.gmail_id)] = true;
    if (r.rfc_message_id) known[String(r.rfc_message_id)] = true;
    if (['spelling', 'spelling-update'].indexOf(String(r.kind)) >= 0 && r.batch_id !== '') {
      if (r.rfc_message_id) batchByRfc[String(r.rfc_message_id)] = Number(r.batch_id);
      if (r.thread_id) batchByThread[String(r.thread_id)] = Number(r.batch_id);
    }
  });

  const allowed = [Session.getEffectiveUser().getEmail()]
    .concat(String(config.notificationEmail || '').split(','))
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // Threads with nothing new since the last look are skipped, which keeps
  // this 5-minute check well inside Gmail's daily read quota.
  const props = spoProps_();
  let seen = {};
  try {
    seen = JSON.parse(props.getProperty('SPELLING_THREADS_SEEN') || '{}');
  } catch (e) {
    seen = {};
  }

  let handled = 0;
  GmailApp.search('newer_than:30d spelling', 0, 50).forEach(thread => {
    const last = thread.getLastMessageDate().getTime();
    if (seen[thread.getId()] && seen[thread.getId()] >= last) return;
    seen[thread.getId()] = last; // our own answer below makes it look new once more; that's fine
    thread.getMessages().forEach(msg => {
      if (known[msg.getId()]) return;
      const from = String(msg.getFrom() || '');
      if (/school paper organizer/i.test(from)) return;
      const address = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
      if (allowed.indexOf(address) < 0) return;
      const rfcId = String(msg.getHeader('Message-ID') || '');
      if (rfcId && known[rfcId]) return;

      const refs = (String(msg.getHeader('In-Reply-To') || '') + ' ' + String(msg.getHeader('References') || ''))
        .split(/\s+/).filter(Boolean);
      let batchId = refs.map(r => batchByRfc[r]).find(Boolean) || batchByThread[thread.getId()] || null;
      const body = msg.getPlainBody() || '';
      if (!batchId) {
        const m = body.match(/spelling-ref-(\d+)/);
        batchId = m ? Number(m[1]) : null;
      }
      const batch = batchId ? spoSpellingBatch_(batchId) : null;
      if (!batch) return; // not a reply to a spelling email; leave it alone

      const result = spoApplyReply_(batch.words, body);
      spoUpdateSpellingBatch_(batch, { words_json: JSON.stringify(batch.words) });
      spoWriteWordsFile_(batch, batch.words, config);
      result.changes.forEach(([n, , value]) => {
        const w = batch.words.find(x => x.number === n);
        if (w && w.needs_work) spoAddOrRefreshSpellingWord_(value, batch.scan_date, batch.source_file_id);
      });
      const summary = `${result.changes.length} change(s), ${result.problems.length} problem(s)`;
      // Mark it handled BEFORE answering, so a failure while sending can't
      // make the next run apply the same reply twice.
      spoRecordEmail_(msg.getId(), rfcId, 'reply-handled', batch.id, thread.getId(), summary);
      known[msg.getId()] = true;
      spoSendTrackedEmail_(config, null,
        spoRenderUpdateEmail_(batch.words, result, batch.source_name, batch.id),
        'spelling-update', batch.id, msg);
      spoLog_('INFO', batch.source_file_id, `Spelling reply for batch ${batch.id}: ${summary}`);
      handled++;
    });
  });

  const cutoff = Date.now() - 31 * 86400000;
  Object.keys(seen).forEach(k => { if (seen[k] < cutoff) delete seen[k]; });
  props.setProperty('SPELLING_THREADS_SEEN', JSON.stringify(seen));
  return handled;
}
