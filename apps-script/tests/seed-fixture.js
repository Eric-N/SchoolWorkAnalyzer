// Made-up stand-in for SeedData.gs (the real one holds personal data and is
// not in git). Same shape as tools/make_seed.py writes.
const w = (list, needsWork = []) => list.map((word, i) => ({
  number: i + 1, word, needs_work: needsWork.includes(word), unclear: false, note: null }));
const day = (...items) => items.map(([subject, assignment]) => ({ subject, assignment }));

module.exports = {
  manifests: [{
    source_file_name: 'homework sheet.pdf', scan_date: '2026-10-30', teacher: 'Teacher', grade: '1', room: '1',
    week_number: 12, week_date_text: 'November 2nd – November 6th',
    homework: {
      monday: day(['Grammar', 'WS 47'], ['Math', 'WS 55'], ['Spelling', 'Spelling pages 103']),
      tuesday: day(['Grammar', 'WS 48'], ['Math', 'WS 56'], ['Spelling', 'Spelling pages 105'], ['Reading', '15 Minutes of Reading']),
      wednesday: day(['Grammar', 'WS 49']), thursday: day(['Grammar', 'WS 50']), friday: [],
    },
  }],
  batches: [
    { id: 1, scan_date: '2026-10-29', source_name: 'oct29.pdf',
      words: w(['crook', 'cheek', 'garage', 'stood', 'brook', 'wooden', 'pudding', 'should'], ['cheek']) },
    { id: 2, scan_date: '2026-11-02', source_name: 'nov2.pdf', words: w(['cry', 'why', 'fly', 'sky', 'try']) },
  ],
  emails: [
    { rfc_message_id: '<pc-spelling-1@school-paper-organizer.local>', kind: 'spelling', batch_id: '1', summary: 'x' },
    { rfc_message_id: '<pc-spelling-2@school-paper-organizer.local>', kind: 'spelling', batch_id: '2', summary: 'x' },
  ],
  replies: [{ rfc_message_id: '<handled-reply-2@gmail.com>', summary: '1 change(s), 0 problem(s)' }],
  practice: [{ word: 'cheek', first_seen: '2026-10-29' }, { word: 'garage', first_seen: '2026-10-29' }],
};
