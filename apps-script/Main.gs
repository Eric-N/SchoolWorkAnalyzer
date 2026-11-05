function processInbox() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(1000)) {
    console.log('Another inbox run is already active.');
    return;
  }

  try {
    const config = spoAssertConfigured_();
    spoEnsureStateSheets_();
    const inbox = DriveApp.getFolderById(
      config.inboxFolderId
    );

    const files = inbox.getFiles();
    let processedCount = 0;

    while (
      files.hasNext() &&
      processedCount < SPO_DEFAULTS.MAX_FILES_PER_RUN
    ) {
      const file = files.next();

      if (file.getMimeType() !== MimeType.PDF) {
        continue;
      }

      if (spoFileAlreadyHandled_(file.getId())) {
        continue;
      }

      processOneInboxFile_(file, config);
      processedCount++;
    }

    console.log(
      `Inbox run finished. Attempted ${processedCount} new PDF(s).`
    );

    // Spelling corrections sent back by email reply (SpellingBatches.gs).
    try {
      const replies = checkSpellingReplies();
      if (replies) console.log(`Handled ${replies} spelling repl${replies === 1 ? 'y' : 'ies'}.`);
    } catch (e) {
      spoLog_('WARN', '', 'Checking spelling replies failed: ' + (e && e.stack ? e.stack : e));
    }

  } finally {
    lock.releaseLock();
  }
}


function processOneInboxFile_(file, config) {
  const scanDate = spoParseScanDate_(
    file,
    config.timezone
  );

  let hash = '';

  try {
    // Inbox originals are NEVER renamed, moved,
    // modified, or deleted.
    const blob = file.getBlob();

    hash = spoSha256Blob_(blob);

    // Failed before for a reason retrying won't fix, and already emailed
    // about. A changed file (new contents) is tried again.
    if (spoHashFailed_(hash)) {
      return;
    }

    if (blob.getBytes().length > SPO_DEFAULTS.MAX_SCAN_BYTES) {
      throw new SpoBadScan_(
        `It is ${(blob.getBytes().length / 1048576).toFixed(1)} MB; the most Claude can read is about ` +
        `${SPO_DEFAULTS.MAX_SCAN_BYTES / 1048576} MB. Scan it in two parts, or at a lower resolution.`
      );
    }

    if (spoHashAlreadyProcessed_(hash)) {
      spoRecordScan_(
        hash,
        file,
        scanDate,
        'duplicate',
        'Exact byte-for-byte duplicate of a previously processed scan.'
      );

      spoLog_(
        'INFO',
        file.getId(),
        'Duplicate upload skipped: ' + file.getName()
      );

      return;
    }

    spoLog_(
      'INFO',
      file.getId(),
      `Analyzing ${file.getName()} (${scanDate}) with Claude...`
    );

    // ------------------------------------------------
    // STAGE 1
    // General page classification.
    //
    // This stage is NOT allowed to classify current
    // homework.
    // ------------------------------------------------
    const analysis = spoAnalyzePdfWithClaude_(
      blob,
      scanDate,
      config
    );

    // ------------------------------------------------
    // STAGE 2
    // Specialized extraction and homework matching.
    // ------------------------------------------------
    spoEnrichAnalysis_(
      file,
      blob,
      scanDate,
      analysis,
      config
    );

    // ------------------------------------------------
    // STAGE 3
    // Create PDFs, update spreadsheet state,
    // send notifications, save JSON.
    // ------------------------------------------------
    const outputFileIds = spoProcessAnalysis_(
      file,
      hash,
      scanDate,
      analysis,
      config
    );

    spoRecordScan_(
      hash,
      file,
      scanDate,
      'processed',
      'OK',
      outputFileIds
    );

    (analysis.pages || []).forEach(p => {
      spoLog_(
        'INFO',
        file.getId(),
        `p.${p.page_number}: ${p.category} ` +
        `(${Number(p.confidence).toFixed(2)}) — ${p.reason}`
      );
    });

  } catch (e) {
    const detail = String(e && e.stack ? e.stack : e);
    const kind = spoErrorKind_(e);

    // 'error' rows are tried again on the next run; 'failed' rows are not
    // (until the file changes, or forceReprocessFile is run), so a broken
    // scan can't run up the Claude bill every 5 minutes.
    spoRecordScan_(hash, file, scanDate, kind === 'permanent' ? 'failed' : 'error', detail);
    spoLog_(kind === 'temporary' ? 'WARN' : 'ERROR', file.getId(), `${file.getName()}: ${detail}`);

    if (kind === 'permanent') {
      spoSendEmail_(config.notificationEmail, `PROBLEM: couldn't process ${file.getName()}`, [
        `The scan ${file.getName()} could not be processed:`, '',
        e instanceof SpoBadScan_ ? e.message : `Unexpected error: ${e && e.message ? e.message : e}`, '',
        'It will not be tried again automatically. If this was the wrong file, you can just delete it.',
        'To try again, upload a corrected copy to the Inbox folder.',
      ].join('\n'), []);
    } else if (kind === 'setup') {
      spoEmailSetupProblemOncePerDay_(config, file, e);
    }
    // 'temporary' (Claude busy, network hiccup): the next run tries again.
  }
}


/** A file that can't be (or almost certainly isn't) a school-paper scan. */
class SpoBadScan_ extends Error {}


/**
 * 'temporary' - Claude overloaded / rate limited / network trouble: retry.
 * 'setup'     - bad API key or no credit left: retry (after it's fixed) and
 *               email about it at most once a day.
 * 'permanent' - anything else: don't retry; email once.
 */
function spoErrorKind_(e) {
  const text = String(e && e.message ? e.message : e);
  if (e instanceof SpoBadScan_) return 'permanent';
  if (/Anthropic[^:]* API (401|403)\b/.test(text) || /credit balance/i.test(text)) return 'setup';
  if (/Anthropic[^:]* API (408|409|429|500|502|503|504|529)\b/.test(text)) return 'temporary';
  if (/Address unavailable|DNS error|timed out|Timeout|Exception: Bandwidth quota|Service unavailable/i.test(text)) {
    return 'temporary';
  }
  return 'permanent';
}

function spoEmailSetupProblemOncePerDay_(config, file, e) {
  const props = spoProps_();
  const today = Utilities.formatDate(new Date(), config.timezone, 'yyyy-MM-dd');
  if (props.getProperty('LAST_SETUP_PROBLEM_EMAIL') === today) return;
  props.setProperty('LAST_SETUP_PROBLEM_EMAIL', today);
  spoSendEmail_(config.notificationEmail, "PROBLEM: School Paper Organizer can't reach Claude", [
    `Claude turned down the request while processing ${file.getName()}:`, '',
    String(e && e.message ? e.message : e).slice(0, 1500), '',
    'This usually means the ANTHROPIC_API_KEY Script Property is wrong, or the',
    'Anthropic account is out of credit. Scans wait in the Inbox and are processed',
    'automatically once it is fixed.',
  ].join('\n'), []);
}


/**
 * Run specialized extraction after general page
 * classification.
 */
function spoEnrichAnalysis_(
  file,
  pdfBlob,
  scanDate,
  analysis,
  config
) {
  analysis.homework_sheets = [];
  analysis.informational_flyers = [];
  analysis.spelling_sheets = [];

  const pages = analysis.pages || [];

  const homeworkSheetPages = pages
    .filter(
      p => p.category === 'homework_sheet'
    )
    .map(
      p => p.page_number
    );

  const flyerPages = pages
    .filter(
      p => p.category === 'informational_flyer'
    )
    .map(
      p => p.page_number
    );

  const spellingPages = pages
    .filter(
      p => p.category === 'spelling_word_sheet'
    )
    .map(
      p => p.page_number
    );

  // ------------------------------------------
  // Extract homework-sheet contents.
  // ------------------------------------------
  if (homeworkSheetPages.length) {
    console.log(
      'Extracting homework data from pages: ' +
      homeworkSheetPages.join(', ')
    );

    analysis.homework_sheets =
      spoExtractHomeworkSheets_(
        pdfBlob,
        homeworkSheetPages,
        scanDate,
        config
      );

    analysis.homework_sheets.forEach(sheet =>
      (sheet.events || []).forEach(e => spoFixEventYear_(e, scanDate, file)));

    // A newly scanned homework sheet becomes the
    // current authoritative manifest.
    spoSaveHomeworkManifest_(
      analysis.homework_sheets,
      file,
      scanDate
    );
  }

  // ------------------------------------------
  // Extract informational flyer events.
  // ------------------------------------------
  if (flyerPages.length) {
    console.log(
      'Extracting flyer events from pages: ' +
      flyerPages.join(', ')
    );

    analysis.informational_flyers =
      spoExtractFlyers_(
        pdfBlob,
        flyerPages,
        scanDate,
        config
      );

    analysis.informational_flyers.forEach(flyer =>
      (flyer.events || []).forEach(e => spoFixEventYear_(e, scanDate, file)));
  }

  // ------------------------------------------
  // Extract spelling assessment/list details.
  // ------------------------------------------
  if (spellingPages.length) {
    console.log(
      'Extracting spelling words from pages: ' +
      spellingPages.join(', ')
    );

    analysis.spelling_sheets =
      spoExtractSpellingSheets_(
        pdfBlob,
        spellingPages,
        scanDate,
        config
      );
  }

  // ------------------------------------------
  // Finally determine CURRENT homework.
  //
  // This happens only after any new homework
  // manifest has been extracted and saved.
  // ------------------------------------------
  const homeworkMatches =
    spoMatchCurrentHomework_(
      pdfBlob,
      scanDate,
      analysis,
      config
    );

  spoApplyHomeworkMatches_(
    analysis,
    homeworkMatches
  );
}


/**
 * Claude sometimes picks the wrong year when none is printed (Veteran's Day
 * on an Oct 2026 sheet came back as 2024-11-11). See spoResolveYear_.
 */
function spoFixEventYear_(event, scanDate, file) {
  const fixed = spoResolveYear_(event.date, event.date_text, scanDate);
  if (fixed !== event.date) {
    spoLog_('INFO', file.getId(),
      `Event "${event.title}": no year printed, so ${event.date} -> ${fixed}`);
    event.date = fixed;
  }
}


/**
 * Manual retry helper.
 */
function retryErrors() {
  processInbox();
}


/**
 * Manual "rewind and redo" helper for a botched scan.
 *
 * Pass a Drive file_id or an exact file_name (both are matched against the
 * Scans sheet; every matching scan attempt is rewound). For each match:
 *   - every Drive file that run generated (homework/flyer/spelling PDFs,
 *     the JSON result) is moved to Trash, not permanently deleted
 *   - its Homework sheet rows are deleted
 *   - its Events sheet rows are deleted (so a corrected re-run emails
 *     fresh, correct calendar events instead of being seen as a dup)
 *   - the Scans row itself is deleted
 *
 * SpellingWords rows are NOT touched: unlike Homework/Events, a spelling
 * word is shared, upserted state that can be touched by multiple scans
 * over time, so deleting "this scan's" rows could destroy a word that
 * predates it. Instead, any spelling words this file last touched are
 * logged so you can review them by hand if needed.
 *
 * Inbox originals are never moved or deleted, so the source file itself
 * should still be sitting in the inbox folder, ready to be reprocessed.
 */
function forceReprocessFile(fileNameOrId) {
  const matchesFile = row =>
    String(row.file_id) === String(fileNameOrId) ||
    String(row.file_name) === String(fileNameOrId);

  const scanRows = spoRowsAsObjects_(SPO_SHEETS.SCANS).filter(matchesFile);

  if (!scanRows.length) {
    console.log(`No Scans row found matching "${fileNameOrId}".`);
    return 0;
  }

  scanRows.forEach(row => {
    const fileId = row.file_id;
    let trashed = 0;

    String(row.output_file_ids || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .forEach(id => {
        try {
          DriveApp.getFileById(id).setTrashed(true);
          trashed++;
        } catch (e) {
          console.log(`Could not trash output file ${id}: ${e}`);
        }
      });

    const homeworkRemoved = spoDeleteRowsWhere_(
      SPO_SHEETS.HOMEWORK,
      r => String(r.source_file_id) === String(fileId)
    );

    const eventsRemoved = spoDeleteRowsWhere_(
      SPO_SHEETS.EVENTS,
      r => String(r.source_file_id) === String(fileId)
    );

    // Its spelling batch goes too, or the re-run would take this scan's own
    // list for an earlier pre-test and file it as the final test.
    const batchesRemoved = spoDeleteRowsWhere_(
      SPO_SHEETS.SPELLING_BATCHES,
      r => String(r.source_file_id) === String(fileId)
    );

    const spellingTouched = spoRowsAsObjects_(SPO_SHEETS.SPELLING)
      .filter(r => String(r.source_file_id) === String(fileId));

    if (spellingTouched.length) {
      console.log(
        `NOTE: ${spellingTouched.length} spelling word row(s) were last touched by ` +
        `${row.file_name} and were NOT reverted (spelling words are shared state ` +
        'across scans) — review the SpellingWords sheet by hand if needed: ' +
        spellingTouched.map(r => r.display_word).join(', ')
      );
    }

    console.log(
      `Rewound ${row.file_name} (${fileId}): trashed ${trashed} output file(s), ` +
      `removed ${homeworkRemoved} homework row(s), ${eventsRemoved} event row(s), ` +
      `${batchesRemoved} spelling batch(es).`
    );
  });

  const scansRemoved = spoDeleteRowsWhere_(SPO_SHEETS.SCANS, matchesFile);

  console.log(
    `Removed ${scansRemoved} Scans row(s) matching "${fileNameOrId}". ` +
    'It will be fully reprocessed on the next processInbox() run.'
  );

  return scansRemoved;
}


/**
 * Scratch wrapper: the Apps Script editor's Run button can't
 * pass arguments, so edit the file name below, run this
 * function, then run processInbox().
 */
function forceReprocessScratch_() {
  forceReprocessFile('08-18-2026-homework copy.pdf');
}
