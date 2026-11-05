const SPO_DEFAULTS = Object.freeze({
  ROOT_FOLDER_NAME: 'School Papers',
  INBOX_FOLDER_NAME: 'Inbox',
  HOMEWORK_SHEETS_FOLDER_NAME: 'Homework Sheets',
  HOMEWORK_FOLDER_NAME: 'Homework',
  FLYERS_FOLDER_NAME: 'Informational Flyers',
  SPELLING_SHEETS_FOLDER_NAME: 'Spelling Sheets',
  SUBJECTS_FOLDER_NAME: 'Subjects',
  RESULTS_FOLDER_NAME: 'Results',
  // Added 2026-11-05 (ported from the local version): the scan as uploaded,
  // and the spelling word lists in their own folder.
  ORIGINALS_FOLDER_NAME: 'Original Scans',
  SPELLING_WORDS_FOLDER_NAME: 'Spelling Words',
  STATE_FILE_NAME: 'School Paper Organizer State',
  // Same price as claude-sonnet-5 ($2 / $10 per million tokens), newer.
  ANTHROPIC_MODEL: 'claude-sonnet-5-5',
  // Anthropic's request limit is 32 MB and the PDF is sent base64-encoded
  // (a third bigger), so anything over this can't be analysed.
  MAX_SCAN_BYTES: 20 * 1024 * 1024,
  LOCAL_TIMEZONE: 'America/Los_Angeles',
  MAX_FILES_PER_RUN: 5,
  ANTHROPIC_MAX_TOKENS: 16000,
  STUDENT_GRADE: 'First Grade',
  STUDENT_CLASS: '206',
});

const SPO_PROP = Object.freeze({
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY',
  ANTHROPIC_MODEL: 'ANTHROPIC_MODEL',
  NOTIFICATION_EMAIL: 'NOTIFICATION_EMAIL',
  LOCAL_TIMEZONE: 'LOCAL_TIMEZONE',
  STUDENT_GRADE: 'STUDENT_GRADE',
  STUDENT_CLASS: 'STUDENT_CLASS',
  ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
  INBOX_FOLDER_ID: 'INBOX_FOLDER_ID',
  HOMEWORK_SHEETS_FOLDER_ID: 'HOMEWORK_SHEETS_FOLDER_ID',
  HOMEWORK_FOLDER_ID: 'HOMEWORK_FOLDER_ID',
  FLYERS_FOLDER_ID: 'FLYERS_FOLDER_ID',
  SPELLING_SHEETS_FOLDER_ID: 'SPELLING_SHEETS_FOLDER_ID',
  SUBJECTS_FOLDER_ID: 'SUBJECTS_FOLDER_ID',
  RESULTS_FOLDER_ID: 'RESULTS_FOLDER_ID',
  ORIGINALS_FOLDER_ID: 'ORIGINALS_FOLDER_ID',
  SPELLING_WORDS_FOLDER_ID: 'SPELLING_WORDS_FOLDER_ID',
  STATE_SPREADSHEET_ID: 'STATE_SPREADSHEET_ID',
  PDF_SPLITTER_URL: 'PDF_SPLITTER_URL',
  PDF_SPLITTER_TOKEN: 'PDF_SPLITTER_TOKEN',
});

function spoProps_() {
  return PropertiesService.getScriptProperties();
}

function spoConfig_() {
  const p = spoProps_();
  return {
    anthropicApiKey: p.getProperty(SPO_PROP.ANTHROPIC_API_KEY) || '',
    anthropicModel: p.getProperty(SPO_PROP.ANTHROPIC_MODEL) || SPO_DEFAULTS.ANTHROPIC_MODEL,
    notificationEmail: p.getProperty(SPO_PROP.NOTIFICATION_EMAIL) || '',
    // Forced, not read from a property: the school is in California and
    // event times must never drift onto the Apps Script project's own
    // timezone setting.
    timezone: SPO_DEFAULTS.LOCAL_TIMEZONE,
    studentGrade: p.getProperty(SPO_PROP.STUDENT_GRADE) || SPO_DEFAULTS.STUDENT_GRADE,
    studentClass: p.getProperty(SPO_PROP.STUDENT_CLASS) || SPO_DEFAULTS.STUDENT_CLASS,
    rootFolderId: p.getProperty(SPO_PROP.ROOT_FOLDER_ID) || '',
    inboxFolderId: p.getProperty(SPO_PROP.INBOX_FOLDER_ID) || '',
    homeworkSheetsFolderId: p.getProperty(SPO_PROP.HOMEWORK_SHEETS_FOLDER_ID) || '',
    homeworkFolderId: p.getProperty(SPO_PROP.HOMEWORK_FOLDER_ID) || '',
    flyersFolderId: p.getProperty(SPO_PROP.FLYERS_FOLDER_ID) || '',
    spellingSheetsFolderId: p.getProperty(SPO_PROP.SPELLING_SHEETS_FOLDER_ID) || '',
    subjectsFolderId: p.getProperty(SPO_PROP.SUBJECTS_FOLDER_ID) || '',
    resultsFolderId: p.getProperty(SPO_PROP.RESULTS_FOLDER_ID) || '',
    originalsFolderId: p.getProperty(SPO_PROP.ORIGINALS_FOLDER_ID) || '',
    spellingWordsFolderId: p.getProperty(SPO_PROP.SPELLING_WORDS_FOLDER_ID) || '',
    stateSpreadsheetId: p.getProperty(SPO_PROP.STATE_SPREADSHEET_ID) || '',
    pdfSplitterUrl: p.getProperty(SPO_PROP.PDF_SPLITTER_URL) || '',
    pdfSplitterToken: p.getProperty(SPO_PROP.PDF_SPLITTER_TOKEN) || '',
  };
}

function spoAssertConfigured_() {
  const c = spoConfig_();
  const missing = [];
  if (!c.anthropicApiKey) missing.push(SPO_PROP.ANTHROPIC_API_KEY);
  if (!c.notificationEmail) missing.push(SPO_PROP.NOTIFICATION_EMAIL);
  if (!c.inboxFolderId) missing.push('setupProject() has not created the Drive folders');
  if (!c.stateSpreadsheetId) missing.push('setupProject() has not created the state spreadsheet');
  if (missing.length) {
    throw new Error('School Paper Organizer is not configured: ' + missing.join(', '));
  }
  return c;
}

/**
 * A folder under School Papers that older setups don't have yet: created on
 * first use and remembered in its Script Property.
 */
function spoLazyFolder_(config, configKey, propName, folderName) {
  if (config[configKey]) {
    try {
      return DriveApp.getFolderById(config[configKey]);
    } catch (e) {
      console.log(`${folderName} folder ${config[configKey]} is gone (${e}); making a new one.`);
    }
  }
  const root = DriveApp.getFolderById(config.rootFolderId);
  const folder = spoGetOrCreateChildFolder_(root, folderName);
  spoProps_().setProperty(propName, folder.getId());
  config[configKey] = folder.getId();
  return folder;
}
