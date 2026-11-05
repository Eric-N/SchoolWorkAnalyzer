function spoSafeSlug_(s) {
  const x = String(s || '').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-|-$/g,'').toLowerCase();
  return (x || 'event').slice(0,60);
}

function spoSendEvent_(event, file, config) {
  if (event.needs_review || !event.date) {
    if (spoRegisterEvent_(Object.assign({}, event, { needs_review: true }), file.getId()) === 'duplicate') return;
    const subject = `REVIEW NEEDED: school event — ${event.title}`;
    const body = [
      `I found a possible school event in ${file.getName()}, but the date could not be resolved safely.`, '',
      `Event: ${event.title}`,
      `Printed date: ${event.date_text || '(none)'}`,
      `Printed time: ${event.time_text || '(none)'}`,
      `Source: ${file.getName()}`,
    ].join('\n');
    spoSendEmail_(config.notificationEmail, subject, body, []);
    return;
  }

  const status = spoRegisterEvent_(event, file.getId());
  if (status === 'duplicate') return;
  const label = status === 'updated' ? 'UPDATED School Event' : 'School Event';
  const subject = `${label}: ${event.title} — ${event.date}`;
  const timeLine = event.all_day ? 'All day' : (event.start_time || event.time_text || 'Time stated on source');
  let body = `Event: ${event.title}\nDate: ${event.date}\nTime: ${timeLine}\nSource: ${file.getName()}\n`;
  if (event.location) body += `Location: ${event.location}\n`;
  if (event.description) body += `\n${event.description}\n`;
  const ics = spoBuildIcs_(event, config.timezone);
  const attachment = Utilities.newBlob(ics, 'text/calendar', `${spoSafeSlug_(event.title)}.ics`);
  spoSendEmail_(config.notificationEmail, subject, body, [attachment]);
}

function spoSendEmail_(to, subject, body, attachments) {
  MailApp.sendEmail({
    to,
    subject,
    body,
    name: 'School Paper Organizer',
    attachments: attachments || [],
  });
  console.log(`Emailed ${to}: ${subject}`);
}

function spoProcessAnalysis_(file, fileHash, scanDate, analysis, config) {
  const sourceBlob = file.getBlob();
  const label = spoDateLabel_(scanDate);
  const byCategory = {};
  (analysis.pages || []).forEach(p => {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p.page_number);
  });

  const outputFileIds = [];

  // An unchanged copy of the scan in Original Scans (the Inbox file itself is
  // never renamed, moved or modified).
  const original = spoSaveOriginal_(file, label, config);
  outputFileIds.push(original.getId());

  // The same spelling list scanned again (the end-of-week test) is filed as a
  // test, with no email (SpellingBatches.gs).
  const finalTest = spoSpellingFinalTestOf_(analysis, scanDate, file);

  const outputs = [
    ['homework_sheet', config.homeworkSheetsFolderId, `${label}-homework-sheet.pdf`],
    ['homework', config.homeworkFolderId, `${label}-homework.pdf`],
    ['spelling_word_sheet', config.spellingSheetsFolderId, `${label}-spelling-${finalTest ? 'test' : 'sheet'}.pdf`],
  ];
  outputs.forEach(([cat, folderId, filename]) => {
    const pages = byCategory[cat] || [];
    if (pages.length) {
      const created = spoExtractPdfPages_(sourceBlob, pages, folderId, filename, config);
      if (created) {
        outputFileIds.push(created.getId());
        spoLog_('INFO', file.getId(), `Created ${created.getName()} from pages ${pages.join(',')}`);
      }
    }
  });

  // Each informational flyer gets its own PDF, named from its extracted
  // title instead of a generic bundled "informational-flyers.pdf" — makes
  // flyers about different things (parent night, picture day, ...)
  // findable in Drive by name.
  (analysis.informational_flyers || []).forEach(flyer => {
    const page = flyer.source_page;
    if (!page) return;
    const titleSlug = spoSafeSlug_(flyer.title || 'flyer');
    const filename = `${label}-${titleSlug}.pdf`;
    const created = spoExtractPdfPages_(sourceBlob, [page], config.flyersFolderId, filename, config);
    if (created) {
      outputFileIds.push(created.getId());
      spoLog_('INFO', file.getId(), `Created ${created.getName()} from page ${page}`);
    }
  });

  // Copies of every worksheet page, one PDF per subject (Subjects.gs).
  // These duplicate the Homework / Spelling Sheets PDFs above on purpose.
  spoCreateSubjectPdfs_(file, sourceBlob, label, analysis, config)
    .forEach(f => outputFileIds.push(f.getId()));

  (analysis.homework_sheets || []).forEach(sheet => (sheet.events || []).forEach(e => spoSendEvent_(e, file, config)));
  (analysis.informational_flyers || []).forEach(flyer => (flyer.events || []).forEach(e => spoSendEvent_(e, file, config)));
  spoSendAssessmentEmail_(analysis, file, scanDate, config);

  // Spelling: word file + one email that asks for corrections by reply, or
  // just a results file for a final test (SpellingBatches.gs).
  spoSendSpellingEmails_(analysis, file, scanDate, config)
    .forEach(f => outputFileIds.push(f.getId()));

  spoAppendHomework_(analysis, file, scanDate);
  const jsonFile = spoCreateJsonResult_(analysis, scanDate, fileHash, config.resultsFolderId);
  outputFileIds.push(jsonFile.getId());
  spoLog_('INFO', file.getId(), 'Saved analysis JSON: ' + jsonFile.getName());

  return outputFileIds;
}


function spoSaveOriginal_(file, label, config) {
  const folder = spoLazyFolder_(config, 'originalsFolderId', SPO_PROP.ORIGINALS_FOLDER_ID,
    SPO_DEFAULTS.ORIGINALS_FOLDER_NAME);
  const copy = file.makeCopy(spoVersionedName_(folder, `${label}-original-scan.pdf`), folder);
  spoLog_('INFO', file.getId(), `Saved original scan as Original Scans/${copy.getName()}`);
  return copy;
}
