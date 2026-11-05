function spoAnalyzePdfWithClaude_(pdfBlob, scanDate, config) {
  const content = [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Utilities.base64Encode(pdfBlob.getBytes()),
      },
      title: pdfBlob.getName() || 'school scan.pdf',
    },
    {
      type: 'text',
      text: spoBuildScanPrompt_(scanDate) + spoNotSchoolPaperAddendum_(),
    },
  ];

  const payload = {
    model: config.anthropicModel,
    max_tokens: SPO_DEFAULTS.ANTHROPIC_MAX_TOKENS,

    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: spoSchoolScanSchema_(),
      },
    },

    messages: [
      {
        role: 'user',
        content: content,
      },
    ],
  };

  const resp = UrlFetchApp.fetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    }
  );

  const code = resp.getResponseCode();
  const body = resp.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(
      `Anthropic API ${code}: ${body.slice(0, 4000)}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Anthropic returned invalid API JSON: ${body.slice(0, 4000)}`
    );
  }

  console.log(
    JSON.stringify({
      id: parsed.id,
      model: parsed.model,
      stop_reason: parsed.stop_reason,
      stop_sequence: parsed.stop_sequence,
      usage: parsed.usage,
      content_types: (parsed.content || []).map(
        block => block.type
      ),
    })
  );

  if (parsed.stop_reason === 'refusal') {
    throw new Error(
      `Claude refused the request. Response: ${body.slice(0, 4000)}`
    );
  }

  const textBlocks = (parsed.content || [])
    .filter(
      block =>
        block.type === 'text' &&
        typeof block.text === 'string'
    )
    .map(block => block.text.trim())
    .filter(Boolean);

  if (!textBlocks.length) {
    throw new Error(
      'Claude returned no text response. ' +
      `stop_reason=${parsed.stop_reason || 'unknown'}, ` +
      `content_types=${
        (parsed.content || [])
          .map(b => b.type)
          .join(',') || 'none'
      }. ` +
      `Raw response: ${body.slice(0, 4000)}`
    );
  }

  const text = textBlocks.join('\n');

  let analysis;

  try {
    analysis = JSON.parse(text);
  } catch (e) {
    throw new Error(
      'Claude structured output could not be parsed as JSON: ' +
      e.message +
      '\nResponse: ' +
      text.slice(0, 4000)
    );
  }

  spoValidateAnalysis_(analysis);

  return analysis;
}


function spoBuildScanPrompt_(scanDate) {
  return spoPromptPreamble_() + `
You are classifying the pages in a daily stack of elementary-school papers.

SCAN DATE:
${scanDate}

Classify EVERY page in the attached PDF.

IMPORTANT:
This stage DOES NOT determine whether a worksheet is current homework.

NEVER classify a page as "homework".

Whether a worksheet is current homework will be determined later by comparing
it against the authoritative weekly homework sheet.

A page with the printed word "Homework" may be old homework that has already
been completed, graded, corrected, and returned to the student.

Use these categories:

1. homework_sheet

A weekly homework manifest or grid listing assignments by weekday.
These often contain Monday-Friday columns or rows and subjects such as Math,
Grammar, Spelling, and Reading.

2. spelling_word_sheet

Usually a handwritten numbered spelling-word list, often around 15 words.
It may contain colored teacher corrections, marks indicating incorrect
spellings, or corrected spellings written beside the student's answer.

A spelling assessment/list with teacher corrections is a spelling_word_sheet,
NOT current homework.

3. informational_flyer

School announcements, parent notices, event flyers, schedules, permission
information, reminders, or other informational material.

4. school_work

Student worksheets, class practice, completed assignments, graded work,
corrected work, tests, quizzes, or returned homework.

If a worksheet appears completed or corrected and it is not one of the special
document types above, school_work is usually appropriate.

5. other

A page that clearly does not fit another category.

6. unknown

Use only when the page cannot be classified confidently.

For each page also extract, when visible:

- title
- document_code or small serial/worksheet identifier
- subject
- confidence
- a short reason explaining the classification

For the subject, use a short school-subject name. Prefer one of:
Math, Science, Social Studies, Spelling, Grammar, Literature, Logic, Geography.
If none of these fits, use another short subject name (for example Reading).
If a page clearly covers two subjects, or you cannot decide between two, give
both separated by " / " (for example "Grammar / Spelling"). Use null when the
page has no school subject, such as a blank page or a drawing.

Do not invent information.

The small serial-number-like codes printed in page corners can be useful
identifiers, but a code alone does not determine document type.

Return one entry for every PDF page.
`;
}


function spoValidateAnalysis_(analysis) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('Claude analysis is not an object.');
  }

  if (!Array.isArray(analysis.pages)) {
    throw new Error(
      'Claude analysis is missing required "pages" array.'
    );
  }

  analysis.pages.forEach((page, index) => {
    if (
      !Number.isInteger(page.page_number) ||
      page.page_number < 1
    ) {
      throw new Error(
        `Page entry ${index} has invalid page_number.`
      );
    }

    if (!page.category) {
      throw new Error(
        `Page ${page.page_number} is missing category.`
      );
    }

    if (
      typeof page.confidence !== 'number' ||
      page.confidence < 0 ||
      page.confidence > 1
    ) {
      throw new Error(
        `Page ${page.page_number} has invalid confidence.`
      );
    }
  });
}


function spoSchoolScanSchema_() {
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

            category: {
              type: 'string',
              enum: [
                'homework_sheet',
                'informational_flyer',
                'spelling_word_sheet',
                'school_work',
                'other',
                'unknown',
              ],
            },

            title: {
              type: ['string', 'null'],
            },

            document_code: {
              type: ['string', 'null'],
            },

            subject: {
              type: ['string', 'null'],
            },

            assignment_match: {
              type: ['string', 'null'],
            },

            confidence: {
              type: 'number',
            },

            reason: {
              type: 'string',
            },
          },

          required: [
            'page_number',
            'category',
            'title',
            'document_code',
            'subject',
            'assignment_match',
            'confidence',
            'reason',
          ],
        },
      },
    },

    required: ['pages'],
  };
}


/**
 * Added 2026-11-05 (ported from the local version). Without it, a wrong file
 * in the Inbox gets squeezed into a school category: a utility bill became an
 * informational_flyer and its outage date a calendar event.
 */
function spoNotSchoolPaperAddendum_() {
  return `
PAPERS THAT ARE NOT FROM SCHOOL:
Every page should be something a student brought home from school. Anything
the school, teacher, PTA, or class sent home counts, including community events
the school passed along. A page that clearly comes from somewhere else, such as
a household bill, bank or utility statement, receipt, recipe, personal letter,
or product manual, is "other", with subject null, even if it contains dates,
instructions, or reminders.
`;
}
