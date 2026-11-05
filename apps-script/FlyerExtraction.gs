function spoExtractFlyers_(pdfBlob, pageNumbers, scanDate, config) {
  const prompt = spoPromptPreamble_() + `
You are extracting calendar events and important dates from informational school flyers.

The original PDF pages classified as informational flyers are:
${pageNumbers.join(', ')}

Scan date:
${scanDate}

Analyze ONLY those pages.

Extract events that would reasonably belong on a parent's calendar.

STUDENT:
This is for a student in ${config.studentGrade}, class ${config.studentClass}.

GRADE / CLASS FILTER RULE:
A flyer sometimes lists different dates, times, or instructions for
different grades or classes (for example separate times for Kindergarten,
First Grade, and Second Grade, or separate rooms/classes).

- Only extract events that apply to THIS student: events explicitly scoped
  to ${config.studentGrade} or class ${config.studentClass}, or events that
  are not grade/class-specific (they apply to the whole school).
- Do NOT extract an event, date, or time slot that is explicitly scoped to
  a different grade or class.
- If it is unclear which grade/class a date or time applies to, include it
  but set needs_review to true.

SPECIAL FUNCTION UNIFORM RULE:
If an event's printed details say students should wear "special function
uniform" (or otherwise state a required uniform/dress code for that specific
event), create TWO separate entries in events:
1. The event itself, with its normal date/time.
2. A second, separate ALL-DAY event on the same date titled
   "{event title} - Special Function Uniform" (all_day: true) as a reminder
   to dress the student appropriately that day.

Rules:
- Do not invent events.
- Do not invent dates or times.
- Preserve the printed event title when practical.
- If a specific time is printed, extract it.
- If there is no specific time, make the event all-day.
- If the year is omitted but can be safely resolved from the scan date and surrounding context, resolve it.
- Use date format YYYY-MM-DD.
- Use 24-hour time HH:MM when a time is available.
- If an event date cannot be safely resolved, set date to null and needs_review to true.
- Include useful location information when printed.
- Include a short description when useful.
- Return one informational_flyers entry for each flyer page.
- If a flyer contains no calendar-worthy event, return that flyer with an empty events array.
`;

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
        schema: spoFlyerExtractionSchema_(),
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
      `Anthropic flyer extraction API ${code}: ${body.slice(0, 4000)}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Anthropic flyer response was invalid API JSON: ${body.slice(0, 4000)}`
    );
  }

  if (parsed.stop_reason === 'refusal') {
    throw new Error('Claude refused the flyer extraction request.');
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
      `Claude returned no flyer extraction text. ` +
      `stop_reason=${parsed.stop_reason || 'unknown'}`
    );
  }

  let result;

  try {
    result = JSON.parse(textBlocks.join('\n'));
  } catch (e) {
    throw new Error(
      `Claude flyer structured output could not be parsed: ${e.message}`
    );
  }

  return result.informational_flyers || [];
}


function spoFlyerExtractionSchema_() {
  return {
    type: 'object',
    additionalProperties: false,

    properties: {
      informational_flyers: {
        type: 'array',

        items: {
          type: 'object',
          additionalProperties: false,

          properties: {
            source_page: {
              type: 'integer',
            },

            title: {
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
            'title',
            'events',
          ],
        },
      },
    },

    required: [
      'informational_flyers',
    ],
  };
}