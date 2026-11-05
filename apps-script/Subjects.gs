/**
 * Subject folders: School Papers/Subjects/<Subject>.
 *
 * Every worksheet page (class work, tonight's homework, spelling tests) is
 * also copied into one PDF per subject per scan. Stage 1's free-text
 * "subject" is normalized here so "Math", "Mathematics" and "First Grade
 * Math" all land in one folder. A subject like "Grammar / Spelling" goes
 * into BOTH folders. Anything that matches no known subject gets its own
 * folder, named from the model's answer.
 *
 * Ported back from the local version on 2026-11-05 (title rule below).
 */

// Pages in these categories get subject copies. The weekly homework sheet,
// flyers, blank/other and unknown pages do not.
const SPO_SUBJECT_CATEGORIES = Object.freeze([
  'school_work',
  'homework',
  'spelling_word_sheet',
]);

// A subject part is filed under EVERY alias it matches, in this order.
const SPO_SUBJECT_ALIASES = Object.freeze([
  ['Math', /math|arithmetic|addition|subtraction|multiplication|fraction|coins?\b|money/],
  ['Spelling', /spelling|phonics|vowel/],
  ['Grammar', /grammar|editing|punctuation|capitali[sz]ation|diagramming|parts of speech/],
  ['Literature', /literature|poetry|poems?\b/],
  ['Logic', /logic|pattern|puzzle/],
  ['Geography', /geography|\bmaps?\b/],
  ['Social Studies', /social studies|history|civics|community/],
  ['Science', /science|biology|physics|chemistry|environment/],
  ['Reading', /reading|comprehension/],
  ['Writing', /writing|composition/],
  ['Art', /\bart\b|drawing|coloring/],
]);

// Words that describe the kind of page, not its subject. A part that matches
// no alias and matches this is dropped instead of becoming a folder.
const SPO_NOT_A_SUBJECT = /board ?work|work ?sheet|homework|class ?work|practice|activity|general|unknown|^n\/?a$/;

// Pattern sheets also belong in Logic even when the model called them Math
// ("Worksheet #9: Patterns"). Only the title is checked, and only for these,
// so e.g. "My Addition to the Bookworm" doesn't become Math. (2026-11-03)
const SPO_TITLE_EXTRA_SUBJECTS = Object.freeze([
  ['Logic', /pattern|puzzle|logic/],
]);

const SPO_UNSORTED_SUBJECT = 'Unsorted';
const SPO_MAX_SUBJECTS_PER_PAGE = 3;

/** Normalize one free-text subject into a deduplicated list of folder names. */
function spoSubjectFolderNames_(subject) {
  const names = [];
  String(subject || '')
    .split(/\s*[\/,;&+]\s*|\s+and\s+/i)
    .forEach(raw => {
      const part = raw
        .replace(/\b(first|1st|second|2nd|third|3rd)\s+grade\b|\bgrade\s+\d\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!part) return;
      const lower = part.toLowerCase();
      let matched = SPO_SUBJECT_ALIASES.filter(([, re]) => re.test(lower)).map(([n]) => n);
      if (!matched.length && !SPO_NOT_A_SUBJECT.test(lower)) matched = [spoTitleCaseFolderName_(part)];
      matched.forEach(name => {
        if (name && names.indexOf(name) < 0) names.push(name);
      });
    });
  return names.slice(0, SPO_MAX_SUBJECTS_PER_PAGE);
}

function spoTitleCaseFolderName_(s) {
  return String(s)
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .toLowerCase()
    .replace(/\b[a-z]/g, c => c.toUpperCase());
}

/**
 * Subject folder names for one page, or [] if the page doesn't get subject
 * copies. A spelling sheet always lands in Spelling; a worksheet with no
 * usable subject goes to Unsorted so it isn't silently dropped.
 */
function spoPageSubjectFolders_(page) {
  if (SPO_SUBJECT_CATEGORIES.indexOf(page.category) < 0) return [];
  const names = spoSubjectFolderNames_(page.subject);
  if (page.category === 'spelling_word_sheet' && names.indexOf('Spelling') < 0) {
    names.unshift('Spelling');
  }
  const title = String(page.title || '').toLowerCase();
  SPO_TITLE_EXTRA_SUBJECTS.forEach(([name, re]) => {
    if (names.indexOf(name) < 0 && re.test(title)) names.push(name);
  });
  return names.length ? names : [SPO_UNSORTED_SUBJECT];
}

/** { "Math": [1, 2], "Grammar": [3] } for the pages of one analysis. */
function spoGroupPagesBySubject_(pages) {
  const bySubject = {};
  (pages || []).forEach(p => {
    spoPageSubjectFolders_(p).forEach(name => {
      if (!bySubject[name]) bySubject[name] = [];
      bySubject[name].push(p.page_number);
    });
  });
  return bySubject;
}

/**
 * The Subjects parent folder. Projects set up before subject sorting existed
 * don't have SUBJECTS_FOLDER_ID yet, so it's created on first use.
 */
function spoSubjectsFolder_(config) {
  if (config.subjectsFolderId) return DriveApp.getFolderById(config.subjectsFolderId);
  const root = DriveApp.getFolderById(config.rootFolderId);
  const folder = spoGetOrCreateChildFolder_(root, SPO_DEFAULTS.SUBJECTS_FOLDER_NAME);
  spoProps_().setProperty(SPO_PROP.SUBJECTS_FOLDER_ID, folder.getId());
  config.subjectsFolderId = folder.getId();
  return folder;
}

/** Creates one PDF per subject; returns the created files. */
function spoCreateSubjectPdfs_(file, sourceBlob, label, analysis, config) {
  const bySubject = spoGroupPagesBySubject_(analysis.pages);
  const subjects = Object.keys(bySubject);
  if (!subjects.length) return [];

  const parent = spoSubjectsFolder_(config);
  const created = [];
  subjects.forEach(name => {
    const folder = spoGetOrCreateChildFolder_(parent, name);
    const filename = `${label}-${spoSafeSlug_(name)}.pdf`;
    const out = spoExtractPdfPages_(sourceBlob, bySubject[name], folder.getId(), filename, config);
    if (out) {
      created.push(out);
      spoLog_('INFO', file.getId(), `Created Subjects/${name}/${out.getName()} from pages ${bySubject[name].join(',')}`);
    }
  });
  return created;
}
