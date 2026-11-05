// Checks the Apps Script code with node, using small fakes of the Google
// services (Sheets, Drive, Gmail, Properties). Not pushed to Apps Script
// (.claspignore only sends *.gs and appsscript.json).
//
// Run from the apps-script folder:   node tests/run-tests.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- fakes

function makeServices() {
  let nextId = 1;
  const id = prefix => `${prefix}${nextId++}`;

  // --- Sheets
  function makeSheet(name) {
    const rows = [];
    const cell = (r, c) => (rows[r - 1] || [])[c - 1] ?? '';
    const setCell = (r, c, v) => {
      while (rows.length < r) rows.push([]);
      rows[r - 1][c - 1] = v;
    };
    const range = (r, c, nr = 1, nc = 1) => ({
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
      setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => setCell(r + i, c + j, v))); return range(r, c, nr, nc); },
      setValue: v => { setCell(r, c, v); return range(r, c, nr, nc); },
      getValue: () => cell(r, c),
      setNumberFormat: () => range(r, c, nr, nc),
    });
    return {
      name, rows,
      getLastRow: () => rows.length,
      getLastColumn: () => Math.max(0, ...rows.map(r => r.length)),
      appendRow: vals => { rows.push(vals.slice()); },
      getRange: range,
      getDataRange: () => range(1, 1, rows.length, Math.max(0, ...rows.map(r => r.length))),
      deleteRow: r => { rows.splice(r - 1, 1); },
      setFrozenRows: () => {},
    };
  }
  const sheets = {};
  const spreadsheet = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    deleteSheet: s => { delete sheets[s.name]; },
    getSpreadsheetTimeZone: () => 'America/Los_Angeles',
    getId: () => 'state-sheet',
  };
  const SpreadsheetApp = {
    openById: () => spreadsheet,
    create: () => { spreadsheet.insertSheet('Sheet1'); return spreadsheet; },
  };
  spreadsheet.getUrl = () => 'https://sheet';

  // --- Properties
  const props = {};
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
    }),
  };

  // --- Drive
  const files = {};
  const folders = {};
  function makeFile(name, content, folderId) {
    const f = {
      id: id('file'), name, content, folderId, trashed: false,
      getId: () => f.id,
      getName: () => f.name,
      getBlob: () => makeBlob(f.content, f.name),
      setContent: c => { f.content = c; return f; },
      isTrashed: () => f.trashed,
      setTrashed: t => { f.trashed = t; },
      makeCopy: (n, folder) => folder.createFile(n, f.content),
      getMimeType: () => 'application/pdf',
      moveTo: folder => { f.folderId = folder.id; },
      getDateCreated: () => new Date('2026-11-05T12:00:00Z'),
    };
    files[f.id] = f;
    return f;
  }
  function makeFolder(name) {
    const folder = {
      id: id('folder'), name,
      getId: () => folder.id,
      getUrl: () => 'https://drive/' + folder.id,
      getFilesByName: n => iter(Object.values(files).filter(f => f.folderId === folder.id && f.name === n && !f.trashed)),
      getFoldersByName: n => iter(Object.values(folders).filter(x => x.parent === folder.id && x.name === n)),
      createFolder: n => { const c = makeFolder(n); c.parent = folder.id; return c; },
      createFile: (nameOrBlob, content) => typeof nameOrBlob === 'string'
        ? makeFile(nameOrBlob, content, folder.id)
        : makeFile(nameOrBlob.getName(), nameOrBlob.content, folder.id),
      getFiles: () => iter(Object.values(files).filter(f => f.folderId === folder.id && !f.trashed)),
    };
    folders[folder.id] = folder;
    return folder;
  }
  const iter = list => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
  const DriveApp = {
    getFolderById: x => { if (!folders[x]) throw new Error('No folder ' + x); return folders[x]; },
    getFileById: x => {
      if (x === 'state-sheet') return { moveTo: () => {} };
      if (!files[x]) throw new Error('No file ' + x);
      return files[x];
    },
    getFoldersByName: n => iter(Object.values(folders).filter(f => f.name === n)),
    createFolder: makeFolder,
  };

  // --- Gmail (one account; family@ is both the script owner and NOTIFICATION_EMAIL)
  const me = 'family@gmail.com';
  const threads = {};
  const sent = [];
  function makeMessage(thread, { from, subject, body, headers = {} }) {
    const m = {
      id: id('msg'), date: new Date(Date.UTC(2026, 10, 1) + nextId * 60000), from, subject, body, headers: Object.assign({ 'Message-ID': `<${nextId}@mail>` }, headers),
      getId: () => m.id,
      getFrom: () => m.from,
      getSubject: () => m.subject,
      getPlainBody: () => m.body,
      getHeader: h => m.headers[h] || '',
      getThread: () => thread,
      createDraftReply: (b, opts) => ({
        send: () => {
          const reply = makeMessage(thread, {
            from: `${opts.name} <${me}>`, subject: 'Re: ' + thread.subject.replace(/^Re: /, ''), body: b,
            headers: { 'In-Reply-To': m.headers['Message-ID'] },
          });
          sent.push(reply);
          return reply;
        },
      }),
    };
    thread.messages.push(m);
    return m;
  }
  function makeThread(subject) {
    const t = { id: id('thread'), subject, messages: [], getId: () => t.id, getMessages: () => t.messages.slice(),
      getLastMessageDate: () => t.messages[t.messages.length - 1].date };
    threads[t.id] = t;
    return t;
  }
  const GmailApp = {
    createDraft: (to, subject, body, opts) => ({
      send: () => {
        const m = makeMessage(makeThread(subject), { from: `${opts.name} <${me}>`, subject, body });
        sent.push(m);
        return m;
      },
    }),
    search: q => Object.values(threads).filter(t => /spelling/i.test(t.subject + t.messages.map(m => m.body).join(' '))),
    getInboxUnreadCount: () => 0,
  };
  const Session = { getEffectiveUser: () => ({ getEmail: () => me }) };
  const mailAppSent = [];
  const MailApp = { sendEmail: o => mailAppSent.push(o) };

  // --- Utilities
  function makeBlob(content, name) {
    const b = {
      content, name,
      getBytes: () => Array.from(Buffer.from(String(content))).map(x => (x > 127 ? x - 256 : x)),
      getName: () => b.name,
      setName: n => { b.name = n; return b; },
      setContentType: () => b,
    };
    return b;
  }
  const Utilities = {
    formatDate: (d, tz, fmt) => {
      const iso = new Date(d).toISOString();
      if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
      if (fmt === 'HH:mm') return iso.slice(11, 16);
      return iso;
    },
    computeDigest: (alg, data) => Array.from(crypto.createHash('sha256')
      .update(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.map(x => (x + 256) % 256))).digest())
      .map(x => (x > 127 ? x - 256 : x)),
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    newBlob: (content, type, name) => makeBlob(content, name),
    base64Encode: () => 'BASE64',
  };
  const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  const MimeType = { PDF: 'application/pdf', PLAIN_TEXT: 'text/plain' };

  return {
    globals: { SpreadsheetApp, PropertiesService, DriveApp, GmailApp, Session, MailApp, Utilities, LockService, MimeType,
      UrlFetchApp: { fetch: () => { throw new Error('no network in tests'); } } },
    sheets, props, files, folders, threads, sent, mailAppSent, makeThread, makeMessage, makeFolder, makeFile, me,
  };
}

function loadProject() {
  const services = makeServices();
  const logs = [];
  const context = vm.createContext(Object.assign({
    console: { log: (...a) => logs.push(a.join(' ')) },
  }, services.globals));
  // SeedData.gs holds personal data (not in git); a made-up fixture stands in.
  context.SPO_LOCAL_SEED = JSON.parse(JSON.stringify(require('./seed-fixture')));
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.gs') && f !== 'SeedData.gs').sort();
  // Apps Script puts every file's top-level names in one shared scope.
  const source = files.map(f => `// ---- ${f}\n` + fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  vm.runInContext(source + '\n;this.__exports = {' +
    [...source.matchAll(/^(?:function|class|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]).join(',') + '};', context,
    { filename: 'project.gs' });
  return { gs: context.__exports, context, services, logs };
}

// ---------------------------------------------------------------- tests

// vm objects come from another realm, so compare them as JSON.
const same = (a, b, msg) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('every .gs file parses on its own', () => {
  fs.readdirSync(ROOT).filter(f => f.endsWith('.gs')).forEach(f => {
    new vm.Script(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  });
});

test('no top-level name is defined twice', () => {
  const seen = {};
  fs.readdirSync(ROOT).filter(f => f.endsWith('.gs')).forEach(f => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/^(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      assert(!seen[m[1]], `${m[1]} is defined in both ${seen[m[1]]} and ${f}`);
      seen[m[1]] = f;
    }
  });
});

test('worksheet-ID check (11-02 MF55 vs WS 55)', () => {
  const { gs } = loadProject();
  const TODAY = ['WS 47', 'WS 55', 'Spelling pages 103', '15 Minutes of Reading'];
  [
    ['28-261.03-23_G1_MF55', true], ['28-261.03-23_G1_MF1', true], ['28-221.17-19 G1 WS 46', true],
    ['28-221.19-19 G1 WS 47', false], ['28-261.41-23_G1_WS55', false], ['28-181.03-22', false],
  ].forEach(([code, conflict]) => assert.strictEqual(!!gs.spoWorksheetIdConflict_(code, TODAY), conflict, code));
});

test('page-number check (11-03 page 106 vs pages 105)', () => {
  const { gs } = loadProject();
  [
    ['106', ['Spelling pages 105'], true], ['105', ['Spelling pages 105'], false],
    ['104', ['Spelling pages 105'], true], ['106', ['Spelling pages 105-106'], false],
    ['106', ['Spelling pp. 105 & 106'], false], ['p. 107', ['Spelling pages 105, 106'], true],
    ['28-261.43-23_G1_WS56', ['Spelling pages 105'], false], ['106', ['WS 48'], false],
  ].forEach(([code, a, conflict]) => assert.strictEqual(!!gs.spoPageNumberConflict_(code, a), conflict, code + ' ' + a));
  const today = ['WS 48', 'WS 56', 'Spelling pages 105', '15 Minutes of Reading'];
  assert(gs.spoHomeworkConflict_('106', 'Spelling pages 105', today));
  assert(!gs.spoHomeworkConflict_('105', 'Spelling pages 105', today));
  assert(!gs.spoHomeworkConflict_('28-261.43-23_G1_WS56', 'WS 56', today));
  assert(gs.spoHomeworkConflict_('28-261.03-23_G1_MF56', 'WS 56', today));
});

test('pattern sheets also go in Logic', () => {
  const { gs } = loadProject();
  const f = p => Array.from(gs.spoPageSubjectFolders_(p));
  same(f({ category: 'school_work', subject: 'Math', title: 'Worksheet #9: Patterns' }), ['Math', 'Logic']);
  same(f({ category: 'school_work', subject: 'Math', title: 'My Addition to the Bookworm' }), ['Math']);
  same(f({ category: 'informational_flyer', subject: null, title: 'Puzzle night' }), []);
});

test('ordinal week dates and year fix', () => {
  const { gs } = loadProject();
  assert.strictEqual(gs.spoWeekMonday_('November 2nd – November 6th', '2026-10-30'), '2026-11-02');
  assert.strictEqual(gs.spoWeekMonday_('Oct. 12-16', '2026-10-09'), '2026-10-12');
  assert.strictEqual(gs.spoResolveYear_('2024-11-11', 'November 11', '2026-10-30'), '2026-11-11');
  assert.strictEqual(gs.spoResolveYear_('2024-11-11', 'November 11, 2024', '2026-10-30'), '2024-11-11');
  assert.strictEqual(gs.spoResolveYear_('2026-10-20', 'Oct 20', '2026-11-05'), '2026-10-20'); // just happened
  assert.strictEqual(gs.spoResolveYear_('2026-01-08', 'Jan 8', '2026-12-20'), '2027-01-08');
  assert.strictEqual(gs.spoResolveYear_(null, 'TBD', '2026-11-05'), null);
});

test('homework sheet for the right week', () => {
  const { gs } = loadProject();
  const thisWeek = { week_date_text: 'October 26th - October 30th', scan_date: '2026-10-23', homework: {} };
  const nextWeek = { week_date_text: 'November 2nd – November 6th', scan_date: '2026-10-30', homework: {} };
  const list = [thisWeek, nextWeek];
  assert.strictEqual(gs.spoPickManifest_(list, '2026-10-30'), thisWeek); // Friday: next week's sheet came home
  assert.strictEqual(gs.spoPickManifest_(list, '2026-11-03'), nextWeek);
  assert.strictEqual(gs.spoPickManifest_(list, '2026-11-12'), null); // stale: skip matching
  assert.strictEqual(gs.spoPickManifest_([{ week_date_text: null, scan_date: '2026-11-02' }], '2026-11-04').scan_date, '2026-11-02');
});

const SHEETS = [{ source_page: 2, words: [
  { word_number: 1, student_spelling: 'crook', correct_spelling: 'crook', needs_work: false, needs_review: false },
  { word_number: 16, student_spelling: 'cheeck', correct_spelling: 'cheek', needs_work: true, needs_review: false },
  { word_number: 18, student_spelling: 'big garage', correct_spelling: 'big garage', needs_work: true, needs_review: false },
  { word_number: 19, student_spelling: null, correct_spelling: null, needs_work: false, needs_review: true },
] }];
const GMAIL_REPLY = '18 = garage\n19 = some\n\nOn Thu, Oct 29, 2026 at 2:15 PM School Paper Organizer <family@gmail.com>\nwrote:\n\n> All words\n>     18 = garage\n';

test('spelling: unclear words, file and email text', () => {
  const { gs } = loadProject();
  const words = gs.spoWordsFromSheets_(SHEETS);
  const byN = Object.fromEntries(words.map(w => [w.number, w]));
  assert(!byN[1].unclear && !byN[16].unclear && byN[16].needs_work);
  assert(byN[18].unclear && /single word/.test(byN[18].note));
  assert(byN[19].unclear && byN[19].word === null);
  const text = gs.spoRenderWordsFile_(words, '10-29-2026', 'scan.pdf');
  assert(text.includes('16. cheek   * needs help'));
  assert(text.includes('18. ???   (looked like "big garage"'));
  const body = gs.spoRenderSpellingEmail_(words, 'scan.pdf', 7);
  assert(body.includes('#18, #19') && body.includes('18 = garage') && body.includes('spelling-ref-7'));
});

test('spelling: reply parsing', () => {
  const { gs } = loadProject();
  assert.strictEqual(gs.spoNewText_(GMAIL_REPLY), '18 = garage\n19 = some');
  assert.strictEqual(gs.spoNewText_('garage\n\n> quoted'), 'garage');
  assert.strictEqual(gs.spoNewText_('ok\n-----Original Message-----\nFrom: x'), 'ok');
  [
    [GMAIL_REPLY, { 18: 'garage', 19: 'some' }],
    ['#18: garage', { 18: 'garage' }],
    ['18 is garage, 19 - some', { 18: 'garage', 19: 'some' }],
    ['Hi!\n18 = "garage".\nThanks', { 18: 'garage' }],
  ].forEach(([reply, expected]) => {
    const words = gs.spoWordsFromSheets_(SHEETS);
    const r = gs.spoApplyReply_(words, reply);
    same(Object.fromEntries(r.changes.map(([n, , v]) => [n, v])), expected, reply);
    same(Array.from(r.problems), [], reply);
  });
  let words = gs.spoWordsFromSheets_(SHEETS);
  same(gs.spoApplyReply_(words, '16 ok').changes.map(c => Array.from(c)).slice(), [[16, 'cheek', 'cheek']]);
  let r = gs.spoApplyReply_(words, 'garage'); // two words still unclear
  assert(!r.changes.length && r.problems.length);
  gs.spoApplyReply_(words, '19 = some');
  r = gs.spoApplyReply_(words, 'garage');
  same(r.changes.map(c => Array.from(c)).slice(), [[18, 'big garage', 'garage']]);
  words = gs.spoWordsFromSheets_(SHEETS);
  r = gs.spoApplyReply_(words, '42 = dog\n18 = big garage\n19 ok');
  assert(!r.changes.length && r.problems.length === 3);
});

const sheet = (words, needsWork = []) => [{ source_page: 1, words: words.map((w, i) => ({
  word_number: i + 1, student_spelling: w, correct_spelling: w, needs_work: needsWork.includes(w), needs_review: false })) }];
const PRETEST = ['crook', 'cheek', 'garage', 'stood', 'brook', 'wooden', 'pudding', 'should'];

test('spelling: same list tolerates one misread letter', () => {
  const { gs } = loadProject();
  const pre = gs.spoWordsFromSheets_(sheet(PRETEST));
  const fin = gs.spoWordsFromSheets_(sheet(['crook', 'cheek', 'garaje', 'stood', 'brock', 'woodn', 'shud']));
  assert.strictEqual(gs.spoSharedWords_(fin, pre), 6);
  assert(gs.spoIsSameList_(fin, pre));
  assert(!gs.spoIsSameList_(gs.spoWordsFromSheets_(sheet(['cheek', 'plane', 'train', 'brain', 'chain', 'stain'])), pre));
});

function setUpProject() {
  const p = loadProject();
  const { gs, services } = p;
  const props = services.globals.PropertiesService.getScriptProperties();
  props.setProperty('ANTHROPIC_API_KEY', 'test-key');
  props.setProperty('NOTIFICATION_EMAIL', services.me);
  props.setProperty('ANTHROPIC_MODEL', 'claude-sonnet-5');
  gs.setupProject();
  return p;
}

test('setupProject: new folders, sheets, model, one-time seed', () => {
  const { gs, services } = setUpProject();
  const props = services.props;
  assert(props.ORIGINALS_FOLDER_ID && props.SPELLING_WORDS_FOLDER_ID);
  assert.strictEqual(props.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
  assert(services.sheets.SpellingBatches && services.sheets.EmailMessages);
  const batches = gs.spoSpellingBatches_();
  same(batches.map(b => b.id), [1, 2]);
  assert.strictEqual(batches[1].scan_date, '2026-11-02');
  assert(gs.spoManifestHistory_().length >= 1);
  gs.setupProject(); // second run doesn't seed again
  assert.strictEqual(gs.spoSpellingBatches_().length, 2);
  // The seeded homework sheet is used for this week's scans.
  assert(gs.spoLoadHomeworkManifest_('2026-11-05'));
});

function fakeFile(services, name) {
  const inbox = services.globals.DriveApp.getFolderById(services.props.INBOX_FOLDER_ID);
  return inbox.createFile(name, 'PDF bytes of ' + name);
}

test('spelling: new list -> batch, file, email; reply fixes it once', () => {
  const { gs, services } = setUpProject();
  const config = gs.spoConfig_();
  const file = fakeFile(services, '11-09-2026 scan.pdf');
  const analysis = { spelling_sheets: SHEETS };
  const created = gs.spoSendSpellingEmails_(analysis, file, '2026-11-09', config);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].getName(), '11-09-2026-spelling-words.txt');
  assert.strictEqual(analysis.spelling_final_test_of, null);
  const email = services.sent[services.sent.length - 1];
  assert.strictEqual(email.subject, "This week's spelling words (11-09-2026)");
  assert(email.body.includes('(spelling-ref-3)')); // numbering continues after the PC's batches
  assert(gs.spoSpellingBatch_(3));
  assert(gs.spoRowsAsObjects_('SpellingWords').some(r => r.display_word === 'cheek'));

  // The family replies in the thread.
  services.makeMessage(email.getThread(), {
    from: `Family <${services.me}>`, subject: "Re: This week's spelling words (11-09-2026)",
    body: GMAIL_REPLY, headers: { 'In-Reply-To': email.headers['Message-ID'] },
  });
  assert.strictEqual(gs.checkSpellingReplies(), 1);
  assert.strictEqual(gs.checkSpellingReplies(), 0); // handled once only
  const text = created[0].content;
  assert(text.includes('18. garage   * needs help') && text.includes('19. some') && !text.includes('???'), text);
  const confirmation = services.sent[services.sent.length - 1];
  assert.strictEqual(confirmation.subject, "Re: This week's spelling words (11-09-2026)");
  assert(confirmation.body.includes('#18: garage   (was "big garage")'));
  assert(gs.spoRowsAsObjects_('SpellingWords').some(r => r.display_word === 'garage'));
});

test('spelling: replies to the PC version\'s emails', () => {
  const { gs, services } = setUpProject();
  // The PC's own email (in the mailbox already) and the reply it already handled.
  const t = services.makeThread("This week's spelling words (11-02-2026)");
  const pcEmail = services.makeMessage(t, { from: `School Paper Organizer <${services.me}>`,
    subject: t.subject, body: 'words...\n(spelling-ref-2)',
    headers: { 'Message-ID': '<pc-spelling-2@school-paper-organizer.local>' } });
  services.makeMessage(t, { from: `Family <${services.me}>`, subject: 'Re: ' + t.subject, body: '5 = fly\n> (spelling-ref-2)',
    headers: { 'Message-ID': '<handled-reply-2@gmail.com>', 'In-Reply-To': pcEmail.headers['Message-ID'] } });
  assert.strictEqual(gs.checkSpellingReplies(), 0); // already handled on the PC
  services.makeMessage(t, { from: `Family <${services.me}>`, subject: 'Re: ' + t.subject, body: '1 ok\n> (spelling-ref-2)',
    headers: { 'In-Reply-To': pcEmail.headers['Message-ID'] } });
  assert.strictEqual(gs.checkSpellingReplies(), 1); // a new one is handled
  // Someone else's mail that mentions spelling is ignored.
  services.makeMessage(t, { from: 'Stranger <x@example.com>', subject: 'spelling', body: '1 = hacked (spelling-ref-2)' });
  assert.strictEqual(gs.checkSpellingReplies(), 0);
});

test('spelling: the final test is filed without an email', () => {
  const { gs, services } = setUpProject();
  const config = gs.spoConfig_();
  const pre = { spelling_sheets: sheet(PRETEST, ['cheek']) };
  gs.spoSendSpellingEmails_(pre, fakeFile(services, 'mon.pdf'), '2026-11-20', config); // after the seeded 10-29 list's window
  const emails = services.sent.length;
  const fin = { spelling_sheets: sheet(['crook', 'cheek', 'garaje', 'stood', 'brock', 'woodn', 'shud'], ['stood']) };
  const out = gs.spoSendSpellingEmails_(fin, fakeFile(services, 'fri.pdf'), '2026-11-24', config);
  assert.strictEqual(out[0].getName(), '11-24-2026-spelling-test.txt');
  assert(out[0].content.includes('same words as the 11-20-2026 pre-test'));
  assert.strictEqual(fin.spelling_final_test_of.batch_id, 3);
  assert.strictEqual(services.sent.length, emails);
  assert(!gs.spoRowsAsObjects_('SpellingWords').some(r => r.display_word === 'stood'));
  // Within 14 days of the seeded 10-29 list, the same words are its final test.
  const again = { spelling_sheets: sheet(PRETEST) };
  gs.spoSendSpellingEmails_(again, fakeFile(services, 'nov2.pdf'), '2026-11-02', config);
  assert.strictEqual(again.spelling_final_test_of.batch_id, 1);
  assert.strictEqual(services.sent.length, emails);
  // A new week's list three weeks later is a new batch with an email.
  gs.spoSendSpellingEmails_({ spelling_sheets: sheet(PRETEST) }, fakeFile(services, 'later.pdf'), '2026-12-15', config);
  assert.strictEqual(services.sent.length, emails + 1);
});

function runInbox(p, analyze) {
  p.context.spoAnalyzePdfWithClaude_ = analyze;
  p.gs.processInbox();
}

test('inbox: temporary errors retry, other errors email once and stop', () => {
  const p = setUpProject();
  const { gs, services } = p;
  fakeFile(services, '11-09-2026.pdf');
  let calls = 0;
  runInbox(p, () => { calls++; throw new Error('Anthropic API 529: overloaded'); });
  runInbox(p, () => { calls++; throw new Error('Anthropic API 529: overloaded'); });
  assert.strictEqual(calls, 2);
  assert.strictEqual(services.mailAppSent.length, 0);
  runInbox(p, () => { calls++; throw new Error('Anthropic API 400: could not process PDF'); });
  runInbox(p, () => { calls++; throw new Error('should not be called'); });
  assert.strictEqual(calls, 3);
  assert.strictEqual(services.mailAppSent.length, 1);
  assert(/PROBLEM: couldn't process 11-09-2026.pdf/.test(services.mailAppSent[0].subject));
  const statuses = gs.spoRowsAsObjects_('Scans').map(r => r.status);
  same(statuses, ['error', 'error', 'failed']);
});

test('inbox: a bad API key emails at most once a day', () => {
  const p = setUpProject();
  fakeFile(p.services, 'a.pdf');
  runInbox(p, () => { throw new Error('Anthropic API 401: invalid x-api-key'); });
  runInbox(p, () => { throw new Error('Anthropic API 401: invalid x-api-key'); });
  assert.strictEqual(p.services.mailAppSent.length, 1);
  assert(/can't reach Claude/.test(p.services.mailAppSent[0].subject));
});

test('inbox: a whole scan end to end (Claude faked)', () => {
  const p = setUpProject();
  const { gs, services, context } = p;
  const file = fakeFile(services, '11-03-2026.pdf');
  context.spoExtractHomeworkSheets_ = () => [];
  context.spoExtractFlyers_ = () => [{ source_page: 3, title: 'Veterans Day', events: [{
    title: "Veteran's Day Assembly", date_text: 'November 11', date: '2024-11-11', time_text: null,
    start_time: null, end_time: null, all_day: true, location: null, description: null, confidence: 0.9, needs_review: false }] }];
  context.spoExtractSpellingSheets_ = () => sheet(['plane', 'train', 'brain', 'chain']);
  context.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ pages: [
      { page_number: 1, is_current_homework: true, matched_subject: 'Spelling', matched_assignment: 'Spelling pages 105',
        confidence: 0.9, appears_completed: false, appears_corrected: false, reason: 'same title' },
      { page_number: 2, is_current_homework: true, matched_subject: 'Spelling', matched_assignment: 'Spelling pages 105',
        confidence: 0.9, appears_completed: false, appears_corrected: false, reason: 'page 105' },
    ] }) }] }) }) };
  runInbox(p, () => ({ pages: [
    { page_number: 1, category: 'school_work', title: 'Spelling', document_code: '106', subject: 'Spelling', assignment_match: null, confidence: 0.9, reason: 'x' },
    { page_number: 2, category: 'school_work', title: 'Spelling', document_code: '105', subject: 'Spelling', assignment_match: null, confidence: 0.9, reason: 'x' },
    { page_number: 3, category: 'informational_flyer', title: 'Veterans Day', document_code: null, subject: null, assignment_match: null, confidence: 0.9, reason: 'x' },
    { page_number: 4, category: 'spelling_word_sheet', title: null, document_code: null, subject: 'Spelling', assignment_match: null, confidence: 0.9, reason: 'x' },
    { page_number: 5, category: 'school_work', title: 'Worksheet #9: Patterns', document_code: null, subject: 'Math', assignment_match: null, confidence: 0.9, reason: 'x' },
  ] }));
  const scans = gs.spoRowsAsObjects_('Scans');
  assert.strictEqual(scans.length, 1);
  assert.strictEqual(scans[0].status, 'processed', scans[0].message);
  const result = JSON.parse(Object.values(services.files).find(f => /-analysis\.json$/.test(f.name)).content);
  const page = n => result.pages.find(x => x.page_number === n);
  assert.strictEqual(page(1).category, 'school_work'); // page 106 overruled
  assert(/it is page 106, not page 105/.test(page(1).homework_match_reason));
  assert.strictEqual(page(2).category, 'homework');
  assert.strictEqual(result.informational_flyers[0].events[0].date, '2026-11-11'); // year fixed
  assert(Object.values(services.files).some(f => f.name === '11-03-2026-original-scan.pdf'));
  assert(Object.values(services.files).some(f => f.name === '11-03-2026-spelling-words.txt'));
  assert(services.mailAppSent.some(m => /School Event: Veteran's Day Assembly — 2026-11-11/.test(m.subject)));
  assert(services.sent.some(m => m.subject === "This week's spelling words (11-03-2026)"));
  // The same file isn't processed twice.
  runInbox(p, () => { throw new Error('should not be called'); });
  assert.strictEqual(gs.spoRowsAsObjects_('Scans').length, 1);
  // Original in the Inbox untouched.
  assert.strictEqual(file.name, '11-03-2026.pdf');
  assert(!file.trashed);
});

// ---------------------------------------------------------------- run

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log('ok   ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + '\n     ' + String(e && e.stack ? e.stack : e).split('\n').slice(0, 6).join('\n     '));
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
