/**
 * Run once after setting Script Properties:
 *   ANTHROPIC_API_KEY
 *   NOTIFICATION_EMAIL
 * Optional:
 *   ANTHROPIC_MODEL
 *   STUDENT_GRADE (default "First Grade")
 *   STUDENT_CLASS (default "206")
 *   ROOT_FOLDER_ID (use an existing parent folder instead of creating "School Papers")
 *   PDF_SPLITTER_URL / PDF_SPLITTER_TOKEN
 *
 * Event times are always forced to America/Los_Angeles (see Config.gs);
 * there is no LOCAL_TIMEZONE property to set.
 */
function setupProject() {
  const p = spoProps_();
  let root;
  const rootId = p.getProperty(SPO_PROP.ROOT_FOLDER_ID);
  if (rootId) {
    root = DriveApp.getFolderById(rootId);
  } else {
    const matches = DriveApp.getFoldersByName(SPO_DEFAULTS.ROOT_FOLDER_NAME);
    root = matches.hasNext() ? matches.next() : DriveApp.createFolder(SPO_DEFAULTS.ROOT_FOLDER_NAME);
    p.setProperty(SPO_PROP.ROOT_FOLDER_ID, root.getId());
  }

  const folderMap = [
    [SPO_PROP.INBOX_FOLDER_ID, SPO_DEFAULTS.INBOX_FOLDER_NAME],
    [SPO_PROP.HOMEWORK_SHEETS_FOLDER_ID, SPO_DEFAULTS.HOMEWORK_SHEETS_FOLDER_NAME],
    [SPO_PROP.HOMEWORK_FOLDER_ID, SPO_DEFAULTS.HOMEWORK_FOLDER_NAME],
    [SPO_PROP.FLYERS_FOLDER_ID, SPO_DEFAULTS.FLYERS_FOLDER_NAME],
    [SPO_PROP.SPELLING_SHEETS_FOLDER_ID, SPO_DEFAULTS.SPELLING_SHEETS_FOLDER_NAME],
    [SPO_PROP.SUBJECTS_FOLDER_ID, SPO_DEFAULTS.SUBJECTS_FOLDER_NAME],
    [SPO_PROP.RESULTS_FOLDER_ID, SPO_DEFAULTS.RESULTS_FOLDER_NAME],
    [SPO_PROP.ORIGINALS_FOLDER_ID, SPO_DEFAULTS.ORIGINALS_FOLDER_NAME],
    [SPO_PROP.SPELLING_WORDS_FOLDER_ID, SPO_DEFAULTS.SPELLING_WORDS_FOLDER_NAME],
  ];

  folderMap.forEach(([propName, folderName]) => {
    let folder;
    const existingId = p.getProperty(propName);
    if (existingId) {
      folder = DriveApp.getFolderById(existingId);
    } else {
      folder = spoGetOrCreateChildFolder_(root, folderName);
      p.setProperty(propName, folder.getId());
    }
    console.log(folderName + ': ' + folder.getUrl());
  });

  let stateId = p.getProperty(SPO_PROP.STATE_SPREADSHEET_ID);
  if (!stateId) {
    const ss = SpreadsheetApp.create(SPO_DEFAULTS.STATE_FILE_NAME);
    stateId = ss.getId();
    const stateFile = DriveApp.getFileById(stateId);
    stateFile.moveTo(root);
    p.setProperty(SPO_PROP.STATE_SPREADSHEET_ID, stateId);
  }
  spoInitializeState_();

  // 'claude-sonnet-5' was the old default; move it to the newer model at the
  // same price. A model someone picked on purpose is left alone.
  const model = p.getProperty(SPO_PROP.ANTHROPIC_MODEL);
  if (!model || model === 'claude-sonnet-5') {
    p.setProperty(SPO_PROP.ANTHROPIC_MODEL, SPO_DEFAULTS.ANTHROPIC_MODEL);
  }
  console.log('Model: ' + p.getProperty(SPO_PROP.ANTHROPIC_MODEL));

  // One time only: carry over what the PC version knew (SeedFromLocal.gs).
  spoSeedFromLocal_();

  // Asks Gmail for permission now (spelling replies), not in the trigger.
  console.log('Gmail account: ' + Session.getEffectiveUser().getEmail() +
    ', ' + GmailApp.getInboxUnreadCount() + ' unread.');
  console.log('Setup complete. Put raw PDFs in the Inbox folder.');
  console.log('Root: ' + root.getUrl());
  console.log('State: ' + SpreadsheetApp.openById(stateId).getUrl());
}

function installInboxTrigger() {
  deleteInboxTriggers();
  ScriptApp.newTrigger('processInbox')
    .timeBased()
    .everyMinutes(5)
    .create();
  console.log('Installed a 5-minute inbox processing trigger.');
}

function deleteInboxTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
}

function showConfiguration() {
  const c = spoConfig_();
  const safe = Object.assign({}, c, {
    anthropicApiKey: c.anthropicApiKey ? '***set***' : '',
    pdfSplitterToken: c.pdfSplitterToken ? '***set***' : '',
  });
  console.log(JSON.stringify(safe, null, 2));
}
