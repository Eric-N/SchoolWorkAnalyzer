function spoMatchCurrentHomework_(
  pdfBlob,
  scanDate,
  analysis,
  config
) {
  const manifest =
    spoLoadHomeworkManifest_(scanDate);

  if (!manifest) {
    console.log(
      `No homework sheet for the week of ${scanDate}; ` +
      'no homework matching performed.'
    );

    return [];
  }

  const today =
    spoHomeworkForScanDate_(
      manifest,
      scanDate
    );

  if (!today) {
    console.log(
      'Could not resolve homework assignments ' +
      'for scan date.'
    );

    return [];
  }

  console.log(
    `Homework manifest for ${scanDate}: ` +
    `${today.weekday}, ` +
    `${today.assignments.length} assignment(s).`
  );

  console.log(
    JSON.stringify(
      today.assignments,
      null,
      2
    )
  );

  if (!today.assignments.length) {
    console.log(
      `No homework assignments listed for ${today.weekday}.`
    );

    return [];
  }

  // Special document types are NEVER candidates
  // for automatic current-homework matching.
  const candidatePages =
    (analysis.pages || [])
      .filter(
        p =>
          p.category !== 'homework_sheet' &&
          p.category !== 'informational_flyer' &&
          p.category !== 'spelling_word_sheet'
      )
      .map(
        p => ({
          page_number:
            p.page_number,

          title:
            p.title || null,

          document_code:
            p.document_code || null,

          subject:
            p.subject || null,

          current_category:
            p.category,
        })
      );

  if (!candidatePages.length) {
    console.log(
      'No candidate worksheet pages available ' +
      'for homework matching.'
    );

    return [];
  }

  const prompt = spoPromptPreamble_() + `
You are determining which worksheet pages in a student's daily school-paper
scan are CURRENT homework for ${scanDate}.

The weekly homework sheet is authoritative.

TODAY:
${today.weekday}

TODAY'S ASSIGNMENTS:
${JSON.stringify(today.assignments, null, 2)}

CANDIDATE PAGES:
${JSON.stringify(candidatePages, null, 2)}

Analyze the attached PDF visually.

Only these original PDF pages are candidates for current homework:
${candidatePages.map(p => p.page_number).join(', ')}

CRITICAL RULE:

A page is current homework ONLY if it corresponds to an assignment listed for
TODAY in the authoritative homework manifest.

The printed word "Homework" on a worksheet is NOT enough.

OLD HOMEWORK:

Previously assigned homework is often returned after it has been completed,
graded, or corrected.

That page WAS homework on a previous night, but it is NOT current homework.

Evidence suggesting a page is old or returned homework includes:

- completed student answers
- teacher corrections
- colored grading marks
- check marks or score marks
- a written date from a previous day
- worksheet identifiers that do not match today's assignment
- workbook page numbers that do not match today's assignment
- a worksheet code from an older assignment

Strong evidence for CURRENT homework includes:

- exact worksheet identifier matching today's assignment, such as WS7
- exact spelling workbook page number matching today's assignment
- matching subject and worksheet title
- matching document/serial code, but only together with a printed "Homework"
  heading (see CLASSWORK RULE below) — the code alone is not enough
- a blank or substantially uncompleted worksheet matching today's assignment

CLASSWORK RULE:

Many worksheet packets print two pages that share the same document/serial
code: one page headed "Class Practice" or "Classwork" (done in class) and a
separate page headed "Homework" (assigned to take home). The two pages look
nearly identical and carry the identical code, but only one of them is
homework.

A matching document/serial code alone does NOT make a page current homework.

Always read the page's own printed heading:
- If the heading says "Class Practice" or "Classwork", the page is NOT
  homework, even if its serial code matches today's assignment exactly.
- Only a page whose own heading says "Homework" is a candidate for current
  homework.

SPELLING WORD LIST RULE:

A handwritten numbered spelling-word assessment/list with teacher corrections
is NOT current homework.

It is a spelling_word_sheet, even if today's homework also includes spelling.

READING RULE:

An instruction such as "15 minutes of reading" may not have a physical page in
the scan. Do not invent a homework page for it.

MATCHING RULE:

Do not force every assignment to have a matching worksheet.

Some homework assignments may not have a physical paper.

Do not force every worksheet to match an assignment.

For every candidate page, determine whether it is current homework.

If it is current homework:
- identify the matched subject
- identify the matched assignment

If it is not current homework:
- matched_subject must be null
- matched_assignment must be null

Explain the decision briefly.
`;

  const content = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data:
          Utilities.base64Encode(
            pdfBlob.getBytes()
          ),
      },
      title:
        pdfBlob.getName() ||
        'school scan.pdf',
    },

    {
      type: 'text',
      text: prompt,
    },
  ];

  const payload = {
    model:
      config.anthropicModel,

    max_tokens:
      SPO_DEFAULTS.ANTHROPIC_MAX_TOKENS,

    output_config: {
      // This decision deserves more reasoning than
      // general page-type classification.
      effort: 'medium',

      format: {
        type: 'json_schema',
        schema:
          spoHomeworkMatchingSchema_(),
      },
    },

    messages: [
      {
        role: 'user',
        content,
      },
    ],
  };

  const response =
    UrlFetchApp.fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'post',
        contentType: 'application/json',

        headers: {
          'x-api-key':
            config.anthropicApiKey,

          'anthropic-version':
            '2023-06-01',
        },

        payload:
          JSON.stringify(payload),

        muteHttpExceptions:
          true,
      }
    );

  const code =
    response.getResponseCode();

  const body =
    response.getContentText();

  if (
    code < 200 ||
    code >= 300
  ) {
    throw new Error(
      `Anthropic homework matching API ${code}: ` +
      body.slice(0, 4000)
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(body);
  } catch (e) {
    throw new Error(
      'Anthropic homework matching response ' +
      'was invalid API JSON: ' +
      body.slice(0, 4000)
    );
  }

  console.log(
    JSON.stringify({
      stage:
        'homework_matching',

      id:
        parsed.id,

      model:
        parsed.model,

      stop_reason:
        parsed.stop_reason,

      usage:
        parsed.usage,

      content_types:
        (parsed.content || [])
          .map(
            b => b.type
          ),
    })
  );

  if (
    parsed.stop_reason === 'refusal'
  ) {
    throw new Error(
      'Claude refused the homework-matching request.'
    );
  }

  const textBlocks =
    (parsed.content || [])
      .filter(
        b =>
          b.type === 'text' &&
          typeof b.text === 'string'
      )
      .map(
        b => b.text.trim()
      )
      .filter(Boolean);

  if (!textBlocks.length) {
    throw new Error(
      'Claude returned no homework matching result.'
    );
  }

  let result;

  try {
    result =
      JSON.parse(
        textBlocks.join('\n')
      );
  } catch (e) {
    throw new Error(
      'Claude homework matching output ' +
      'could not be parsed: ' +
      e.message
    );
  }

  const matches =
    result.pages || [];

  // Deterministic double-check of every YES (see spoHomeworkConflict_).
  const todayTexts = today.assignments.map(a => String((a && a.assignment) || ''));
  matches.forEach(match => {
    if (!match.is_current_homework) return;
    const page = candidatePages.find(p => p.page_number === match.page_number);
    const why = page && spoHomeworkConflict_(page.document_code, match.matched_assignment, todayTexts);
    if (!why) return;
    console.log(`Homework match p.${match.page_number} overruled: ${why}`);
    match.reason = `Not current homework: ${why}. (Model said yes: ${match.reason})`;
    match.is_current_homework = false;
    match.matched_subject = null;
    match.matched_assignment = null;
  });

  matches.forEach(
    match => {
      console.log(
        `Homework match p.${match.page_number}: ` +
        `${match.is_current_homework ? 'YES' : 'NO'} — ` +
        `${match.reason}`
      );
    }
  );

  return matches;
}


function spoHomeworkMatchingSchema_() {
  return {
    type: 'object',
    additionalProperties: false,

    properties: {
      pages: {
        type: 'array',

        items: {
          type: 'object',
          additionalProperties: false,

          properties: {
            page_number: {
              type: 'integer',
            },

            is_current_homework: {
              type: 'boolean',
            },

            matched_subject: {
              type: [
                'string',
                'null',
              ],
            },

            matched_assignment: {
              type: [
                'string',
                'null',
              ],
            },

            confidence: {
              type: 'number',
            },

            appears_completed: {
              type: 'boolean',
            },

            appears_corrected: {
              type: 'boolean',
            },

            reason: {
              type: 'string',
            },
          },

          required: [
            'page_number',
            'is_current_homework',
            'matched_subject',
            'matched_assignment',
            'confidence',
            'appears_completed',
            'appears_corrected',
            'reason',
          ],
        },
      },
    },

    required: [
      'pages',
    ],
  };
}


function spoApplyHomeworkMatches_(
  analysis,
  matches
) {
  const byPage = {};

  (matches || []).forEach(
    match => {
      byPage[
        match.page_number
      ] = match;
    }
  );

  (analysis.pages || []).forEach(
    page => {
      const match =
        byPage[
          page.page_number
        ];

      if (!match) {
        return;
      }

      page.homework_match =
        match.is_current_homework;

      page.matched_assignment =
        match.matched_assignment ||
        null;

      page.homework_match_reason =
        match.reason ||
        null;

      page.appears_completed =
        match.appears_completed;

      page.appears_corrected =
        match.appears_corrected;

      if (
        match.is_current_homework
      ) {
        page.category =
          'homework';

        if (
          match.matched_subject
        ) {
          page.subject =
            match.matched_subject;
        }

        if (
          match.matched_assignment
        ) {
          page.assignment_match =
            match.matched_assignment;
        }

        page.confidence =
          match.confidence;

        page.reason =
          'Current homework match: ' +
          match.reason;
      }
    }
  );
}



// ---------------------------------------------------------------------------
// Homework double-checks (ported from the local version, 2026-11-05).
// Pure functions, checked with node (tests/run-tests.js).
//
// 1. Worksheet identifiers such as "WS 55" / "MF55" in a page's document code
//    must agree with the assignment. On 11-02 an "Addition" math-facts sheet
//    (code ..._G1_MF55) was matched to "Math: WS 55" on the shared number.
//    "G1" is the grade, not an identifier.
// 2. Workbook page numbers. On 11-03 blank workbook page 106 (code "106") was
//    matched to "Spelling pages 105" because it had the same title. A bare
//    page-number code must be one of the pages the assignment names.
// Pages whose code has neither are left to the model.
// ---------------------------------------------------------------------------

function spoWorksheetIds_(text) {
  const ids = [];
  const re = /(?<![A-Za-z])([A-Za-z]{1,4})[\s_#.\-]*(\d{1,4})(?!\d)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const prefix = m[1].toUpperCase();
    if (prefix === 'G') continue;
    const id = `${prefix} ${Number(m[2])}`;
    if (ids.indexOf(id) < 0) ids.push(id);
  }
  return ids;
}

/** Why the page can't be any of these assignments, or null if it can. */
function spoWorksheetIdConflict_(documentCode, assignments) {
  const pageIds = spoWorksheetIds_(documentCode);
  const wanted = [];
  (assignments || []).forEach(a => spoWorksheetIds_(a).forEach(id => {
    if (wanted.indexOf(id) < 0) wanted.push(id);
  }));
  if (!pageIds.length || !wanted.length || pageIds.some(id => wanted.indexOf(id) >= 0)) return null;
  return `its code "${documentCode}" has ${pageIds.sort().join(', ')}, not ${wanted.sort().join(', ')}`;
}

/** Page numbers an assignment names: "pages 105", "pp. 105-106", "105 & 106". */
function spoAssignmentPages_(text) {
  const pages = [];
  const add = n => { if (pages.indexOf(n) < 0) pages.push(n); };
  const list = /\b(?:pages?|pgs?|pp?)\.?\s*(\d{1,4}(?:\s*(?:-|–|—|,|&|and|to)\s*\d{1,4})*)/gi;
  let m;
  while ((m = list.exec(String(text || '')))) {
    const item = /(\d+)(?:\s*(?:-|–|—|to)\s*(\d+))?/g;
    let r;
    while ((r = item.exec(m[1]))) {
      const lo = Number(r[1]);
      const hi = Number(r[2] || r[1]);
      if (hi - lo >= 0 && hi - lo <= 20) {
        for (let n = lo; n <= hi; n++) add(n);
      } else {
        add(lo);
        add(hi);
      }
    }
  }
  return pages;
}

/** Why a page whose code is just a page number can't be these assignments. */
function spoPageNumberConflict_(documentCode, assignments) {
  const m = String(documentCode || '').match(/^\s*(?:(?:pages?|pgs?|pp?)\.?\s*)?(\d{1,4})\s*$/i);
  const wanted = [];
  (assignments || []).forEach(a => spoAssignmentPages_(a).forEach(n => {
    if (wanted.indexOf(n) < 0) wanted.push(n);
  }));
  if (!m || !wanted.length || wanted.indexOf(Number(m[1])) >= 0) return null;
  return `it is page ${Number(m[1])}, not page ${wanted.sort((a, b) => a - b).join(', ')}`;
}

/**
 * Both checks, against the matched assignment when it names an identifier /
 * page, else against all of today's assignments. Returns a reason or null.
 */
function spoHomeworkConflict_(documentCode, matched, todayAssignments) {
  const ids = spoWorksheetIds_(matched).length ? [matched] : todayAssignments;
  const pages = spoAssignmentPages_(matched).length ? [matched] : todayAssignments;
  return spoWorksheetIdConflict_(documentCode, ids) || spoPageNumberConflict_(documentCode, pages);
}
