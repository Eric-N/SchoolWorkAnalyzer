/**
 * Spelling batches: the quick-reference word file, the weekly email, and
 * corrections sent back by email reply ("18 = garage").
 *
 * Ported back from the local version (local/spo/spelling.py) on 2026-11-05.
 * Everything in this file is pure (no Apps Script services) so it can be
 * checked with node (tests/run-tests.js). The Drive / Gmail / Sheet side is
 * SpellingBatches.gs.
 *
 * A batch is one scan's spelling words. A word is UNCLEAR when the model said
 * it needs review, couldn't read it, or read something that isn't a single
 * word (e.g. "big garage"). Unclear words show as ??? until someone replies
 * with the right word; "18 ok" confirms the model's reading as-is.
 */

const SPO_WORD_RE = /^[A-Za-z][A-Za-z'\-]*$/;

/** Model output (spelling_sheets[].words[]) -> sorted, numbered word list. */
function spoWordsFromSheets_(spellingSheets) {
  const words = [];
  const used = [];
  (spellingSheets || []).forEach(sheet => {
    (sheet.words || []).forEach(item => {
      const text = String(item.correct_spelling || item.student_spelling || '').trim() || null;
      let n = item.word_number;
      if (!Number.isInteger(n) || used.indexOf(n) >= 0) n = Math.max(0, ...used) + 1;
      used.push(n);
      let unclear = false;
      let note = null;
      if (item.needs_review) {
        unclear = true;
        note = 'the handwriting or correction was ambiguous';
      } else if (text === null) {
        unclear = true;
        note = 'unreadable';
      } else if (!SPO_WORD_RE.test(text)) {
        unclear = true;
        note = "doesn't look like a single word";
      }
      words.push({ number: n, word: text, needs_work: !!item.needs_work, unclear, note });
    });
  });
  return words.sort((a, b) => a.number - b.number);
}

function spoPad2_(n) {
  return (String(n).length < 2 ? ' ' : '') + n;
}

function spoWordLine_(w) {
  if (w.unclear) {
    const seen = w.word ? `looked like "${w.word}"` : "couldn't read it";
    return `${spoPad2_(w.number)}. ???   (${seen} — reply with the right word)`;
  }
  return `${spoPad2_(w.number)}. ${w.word}${w.needs_work ? '   * needs help' : ''}`;
}

function spoRenderWordsFile_(words, scanLabel, source) {
  const unclear = words.filter(w => w.unclear);
  const lines = [`Spelling words — scan of ${scanLabel}`, ''];
  words.forEach(w => lines.push(spoWordLine_(w)));
  lines.push('', '* = marked incorrect on the sheet (needs practice)');
  if (unclear.length) {
    lines.push(`??? = not confirmed yet (${unclear.length} word${unclear.length !== 1 ? 's' : ''})`);
  }
  lines.push('', `Source: ${source}`, '');
  return lines.join('\n');
}

// --- pre-test vs final test
// The week's words come home twice: on the pre-test early in the week and on
// the final test later. Only the pre-test starts a batch (file, email,
// needs-help words). A sheet whose words mostly match a batch from the last
// SPO_PRETEST_WINDOW_DAYS is that batch's final test: it's filed, nothing else.

const SPO_PRETEST_WINDOW_DAYS = 14;
const SPO_MIN_SHARED_WORDS = 3;
const SPO_MIN_SHARED_FRACTION = 0.5; // of the shorter list's words

function spoWordKey_(text) {
  return String(text || '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Same word, allowing one misread letter in words of 5+ letters. */
function spoWordsClose_(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0; i < long.length; i++) {
    if (long.slice(0, i) + long.slice(i + 1) === short) return true;
  }
  return false;
}

/** How many of words' readings also appear (or nearly) in other. */
function spoSharedWords_(words, other) {
  const theirs = other.map(w => spoWordKey_(w.word)).filter(Boolean);
  return words
    .map(w => spoWordKey_(w.word))
    .filter(Boolean)
    .filter(k => theirs.some(t => spoWordsClose_(k, t)))
    .length;
}

function spoIsSameList_(words, other) {
  const n = spoSharedWords_(words, other);
  const count = list => list.filter(w => spoWordKey_(w.word)).length;
  const shorter = Math.min(count(words), count(other));
  return n >= SPO_MIN_SHARED_WORDS && n >= SPO_MIN_SHARED_FRACTION * shorter;
}

function spoRenderTestFile_(words, scanLabel, pretestLabel, source) {
  const missed = words.filter(w => w.needs_work);
  const lines = [
    `Spelling final test — scan of ${scanLabel}`,
    `(same words as the ${pretestLabel} pre-test; no email is sent for the final test)`,
    '',
  ];
  words.forEach(w => lines.push(
    `${spoPad2_(w.number)}. ${w.word || '(unreadable)'}${w.needs_work ? '   * marked incorrect' : ''}` +
    (w.unclear && w.word ? '   (unclear reading)' : '')
  ));
  lines.push('', `Marked incorrect: ${missed.length} of ${words.length}`, '', `Source: ${source}`, '');
  return lines.join('\n');
}

/**
 * Printed in each spelling email; lets a reply be matched to its batch even
 * if the thread can't be. Batch numbers continue the local version's, so
 * tokens in older emails still point at the same week.
 */
function spoRefToken_(batchId) {
  return `spelling-ref-${batchId}`;
}

function spoRenderSpellingEmail_(words, source, batchId) {
  const unclear = words.filter(w => w.unclear);
  const needsHelp = [];
  words.forEach(w => {
    if (w.needs_work && !w.unclear && w.word && needsHelp.indexOf(w.word) < 0) needsHelp.push(w.word);
  });
  const body = ["All words from this week's spelling sheet:", ''];
  words.forEach(w => body.push(spoWordLine_(w)));
  body.push('', needsHelp.length
    ? `Needs help with: ${needsHelp.join(', ')}`
    : 'No words were marked incorrect this time.');
  if (unclear.length) {
    const example = unclear[0];
    body.push(
      '',
      `I couldn't confirm ${unclear.length} word${unclear.length !== 1 ? 's' : ''}: ` +
        unclear.map(w => `#${w.number}`).join(', ') + '.',
      'To fix one, just reply to this email with the number and the right word, one per line:',
      '',
      `    ${example.number || 1} = garage`,
      '',
      `If my reading was actually right, reply "${example.number} ok".`
    );
  }
  body.push('', `Source: ${source}`, `(${spoRefToken_(batchId)})`);
  return body.join('\n');
}

// --- replies

const SPO_QUOTE_START = [
  /^On .*wrote:\s*$/,
  /^-+\s*Original Message\s*-+/i,
  /^From:\s/,
  /^_{10,}/,
];
const SPO_CORRECTION = /^#?\s*(\d{1,3})\s*(?:=|:|-|–|—|\)|\.|\bis\b)?\s*(.+?)\s*$/i;
const SPO_SKIP_LINES = /^(sent from my .*|get outlook for .*|thanks?!*|thank you!*)$/i;

/** The part of a reply the person typed, without the quoted original. */
function spoNewText_(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (s.startsWith('>') || SPO_QUOTE_START.some(re => re.test(s))) break;
    if (s.startsWith('On ') && next.endsWith('wrote:')) break; // "On Thu, … <x@gmail.com>\nwrote:"
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/**
 * Apply "18 = garage" / "18 ok" lines (or a bare word when exactly one word
 * is unclear) to words, in place. Returns {changes: [[n, old, new]], problems}.
 */
function spoApplyReply_(words, body) {
  const byNumber = {};
  words.forEach(w => { byNumber[w.number] = w; });
  const unclear = words.filter(w => w.unclear);
  const changes = [];
  const problems = [];
  const unparsed = [];
  const entries = [];
  spoNewText_(body).split('\n').forEach(line => line.split(/[,;]/).forEach(e => {
    e = e.trim();
    if (e && !SPO_SKIP_LINES.test(e)) entries.push(e);
  }));

  const setWord = (w, value, typed) => {
    const v = value.trim().replace(/^["'.!]+|["'.!]+$/g, '').trim();
    if (!SPO_WORD_RE.test(v)) {
      problems.push(`"${typed}": "${v}" doesn't look like a single word, so I left #${w.number} alone.`);
      return;
    }
    changes.push([w.number, w.word, v]);
    w.word = v;
    w.unclear = false;
    w.note = 'confirmed by email reply';
  };

  entries.forEach(e => {
    const m = e.match(SPO_CORRECTION);
    if (m) {
      const n = Number(m[1]);
      const rest = m[2];
      const w = byNumber[n];
      if (!w) {
        problems.push(`"${e}": there's no word #${n} on this list.`);
      } else if (['ok', 'okay', 'correct', 'right', 'yes'].indexOf(rest.toLowerCase()) >= 0) {
        if (w.word && SPO_WORD_RE.test(w.word)) {
          changes.push([n, w.word, w.word]);
          w.unclear = false;
          w.note = 'confirmed by email reply';
        } else {
          problems.push(`"${e}": I don't have a usable reading for #${n}; please reply with the word.`);
        }
      } else {
        setWord(w, rest, e);
      }
    } else if (unclear.length === 1 && entries.length === 1 &&
               SPO_WORD_RE.test(e.replace(/^["'.! ]+|["'.! ]+$/g, ''))) {
      setWord(unclear[0], e, e);
    } else {
      unparsed.push(e);
    }
  });
  // Chatty lines ("Hi", "Looks right to me") only matter if nothing else worked.
  if (unparsed.length && !changes.length && !problems.length) {
    unparsed.forEach(e => problems.push(`"${e}": I didn't understand this line. Use the form "18 = garage".`));
  }
  return { changes, problems };
}

function spoRenderUpdateEmail_(words, result, source, batchId) {
  const body = [];
  if (result.changes.length) {
    body.push('Thanks — the spelling list is updated:', '');
    result.changes.forEach(([n, old, value]) => {
      body.push(`  #${n}: ${value}` + (old && old !== value ? `   (was "${old}")` : '   (confirmed)'));
    });
    body.push('');
  }
  if (result.problems.length) {
    body.push("I couldn't use part of your reply:", '');
    result.problems.forEach(p => body.push(`  - ${p}`));
    body.push('');
  }
  body.push('Current list:', '');
  words.forEach(w => body.push(spoWordLine_(w)));
  const remaining = words.filter(w => w.unclear);
  if (remaining.length) {
    body.push('', 'Still unconfirmed: ' + remaining.map(w => `#${w.number}`).join(', ') +
      '. Reply to this email the same way to fix them.');
  }
  body.push('', `Source: ${source}`, `(${spoRefToken_(batchId)})`);
  return body.join('\n');
}
