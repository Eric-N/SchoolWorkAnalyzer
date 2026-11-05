function spoExtractHomeworkSheets_(pdfBlob, pageNumbers, scanDate, config) {
  const prompt = spoPromptPreamble_() + `
You are extracting structured homework information from a school scan.

Only use the homework-sheet pages identified by these original PDF page numbers:
${pageNumbers.join(', ')}

Scan date:
${scanDate}

Extract the weekly homework sheet information.

Important rules:
- Do not invent dates, assignments, assessments, or notes.
- Preserve worksheet identifiers such as WS1, WS2, etc.
- If a subject explicitly says "None", preserve "None".
- Homework should be grouped by weekday.
- Extract assessments for this week and next week separately.
- Extract a short notes summary.
- Extract important calendar events from the homework sheet.
- If an event has a specific time, include it.
- If no time is stated, set all_day to true.
- If an event's details say students should wear "special function uniform"
  (or otherwise state a required uniform/dress code for that event), also
  add a second, separate ALL-DAY event on the same date titled
  "{event title} - Special Function Uniform" as a dress-code reminder.
- If the year is not printed but can be safely resolved from scan context, use the resolved date.
- If the date is ambiguous, set date to null and needs_review to true.
` + spoHomeworkSheetLayoutAddendum_();

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
      text: prompt,
    },
  ];

  const payload = {
    model: config.anthropicModel,
    max_tokens: SPO_DEFAULTS.ANTHROPIC_MAX_TOKENS,

    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: spoHomeworkExtractionSchema_(),
      },
    },

    messages: [
      {
        role: 'user',
        content: content,
      },
    ],
  };

  const response = UrlFetchApp.fetch(
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

  const code = response.getResponseCode();
  const body = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error(
      `Anthropic homework extraction API ${code}: ${body.slice(0, 4000)}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Anthropic homework response was invalid API JSON: ${body.slice(0, 4000)}`
    );
  }

  if (parsed.stop_reason === 'refusal') {
    throw new Error('Claude refused the homework extraction request.');
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
      'Claude returned no homework extraction text.'
    );
  }

  let result;

  try {
    result = JSON.parse(textBlocks.join('\n'));
  } catch (e) {
    throw new Error(
      `Claude homework structured output could not be parsed: ${e.message}`
    );
  }

  return result.homework_sheets || [];
}


function spoHomeworkExtractionSchema_() {
  return {
    type: 'object',
    additionalProperties: false,

    properties: {
      homework_sheets: {
        type: 'array',

        items: {
          type: 'object',
          additionalProperties: false,

          properties: {
            source_page: {
              type: 'integer',
            },

            teacher: {
              type: ['string', 'null'],
            },

            grade: {
              type: ['string', 'null'],
            },

            room: {
              type: ['string', 'null'],
            },

            week_number: {
              type: ['integer', 'null'],
            },

            week_date_text: {
              type: ['string', 'null'],
            },

            homework: {
              type: 'object',
              additionalProperties: false,

              properties: {
                monday: {
                  type: 'array',
                  items: spoHomeworkAssignmentSchema_(),
                },

                tuesday: {
                  type: 'array',
                  items: spoHomeworkAssignmentSchema_(),
                },

                wednesday: {
                  type: 'array',
                  items: spoHomeworkAssignmentSchema_(),
                },

                thursday: {
                  type: 'array',
                  items: spoHomeworkAssignmentSchema_(),
                },

                friday: {
                  type: 'array',
                  items: spoHomeworkAssignmentSchema_(),
                },
              },

              required: [
                'monday',
                'tuesday',
                'wednesday',
                'thursday',
                'friday',
              ],
            },

            assessments_this_week: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,

                properties: {
                  day: {
                    type: ['string', 'null'],
                  },

                  assessment: {
                    type: 'string',
                  },
                },

                required: [
                  'day',
                  'assessment',
                ],
              },
            },

            assessments_next_week: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,

                properties: {
                  day: {
                    type: ['string', 'null'],
                  },

                  assessment: {
                    type: 'string',
                  },
                },

                required: [
                  'day',
                  'assessment',
                ],
              },
            },

            notes_summary: {
              type: ['string', 'null'],
            },

            events: {
              type: 'array',

              items: {
                type: 'object',
                additionalProperties: false,

                properties: {
                  title: {
                    type: 'string',
                  },

                  date_text: {
                    type: ['string', 'null'],
                  },

                  date: {
                    type: ['string', 'null'],
                  },

                  time_text: {
                    type: ['string', 'null'],
                  },

                  start_time: {
                    type: ['string', 'null'],
                  },

                  end_time: {
                    type: ['string', 'null'],
                  },

                  all_day: {
                    type: 'boolean',
                  },

                  location: {
                    type: ['string', 'null'],
                  },

                  description: {
                    type: ['string', 'null'],
                  },

                  confidence: {
                    type: 'number',
                  },

                  needs_review: {
                    type: 'boolean',
                  },
                },

                required: [
                  'title',
                  'date_text',
                  'date',
                  'time_text',
                  'start_time',
                  'end_time',
                  'all_day',
                  'location',
                  'description',
                  'confidence',
                  'needs_review',
                ],
              },
            },
          },

          required: [
            'source_page',
            'teacher',
            'grade',
            'room',
            'week_number',
            'week_date_text',
            'homework',
            'assessments_this_week',
            'assessments_next_week',
            'notes_summary',
            'events',
          ],
        },
      },
    },

    required: [
      'homework_sheets',
    ],
  };
}


function spoHomeworkAssignmentSchema_() {
  return {
    type: 'object',
    additionalProperties: false,

    properties: {
      subject: {
        type: 'string',
      },

      assignment: {
        type: 'string',
      },
    },

    required: [
      'subject',
      'assignment',
    ],
  };
}


/**
 * Added 2026-11-05: the sheet's layout, as described by the family on
 * 2026-11-01. Tests were being put under the wrong day (mostly Friday).
 */
function spoHomeworkSheetLayoutAddendum_() {
  return `
HOMEWORK SHEET LAYOUT:
The week's date range is printed at the top. The sheet is a table: a label
column on the left, then one column per weekday, Monday to Friday, with the day
names in the top row. The rows are Grammar, Math, Spelling, 15 Minutes of
Reading, This Week's Assessments, Next Week's Assessments, and Notes and
Reminders.

Each assessment is written in the box under the day it happens. Take each
assessment's day from the column its box is in. Do not default to Friday or
to the last day of the week. "This week" is the printed date range; "next
week" is the week after it. If an assessment's writing crosses a column line
so you can't tell which day it belongs to, set its day to null.
`;
}
