function spoExtractSpellingSheets_(pdfBlob, pageNumbers, scanDate, config) {
  const prompt = spoPromptPreamble_() + `
You are extracting spelling practice information from a child's school spelling sheets.

The original PDF pages classified as spelling word sheets are:
${pageNumbers.join(', ')}

Scan date:
${scanDate}

Analyze ONLY those pages.

These sheets are usually handwritten numbered word lists, often around 15 words.
Teacher corrections may appear in colored ink or colored marks.

For each word:
- Extract the student's written spelling when readable.
- Extract the intended/correct spelling when it can be determined safely.
- Colored teacher corrections are strong evidence of the correct spelling.
- Set needs_work to true when the student's spelling was corrected or otherwise marked incorrect.
- Set needs_work to false when the word appears correct.
- If the handwriting or correction is ambiguous, set needs_review to true.
- Do NOT guess an unreadable corrected spelling.
- When uncertain, use null rather than inventing a word.
- Preserve the original word number when visible.
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
        schema: spoSpellingExtractionSchema_(),
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
      `Anthropic spelling extraction API ${code}: ${body.slice(0, 4000)}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(
      `Anthropic spelling response was invalid API JSON: ${body.slice(0, 4000)}`
    );
  }

  if (parsed.stop_reason === 'refusal') {
    throw new Error('Claude refused the spelling extraction request.');
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
      `Claude returned no spelling extraction text. ` +
      `stop_reason=${parsed.stop_reason || 'unknown'}`
    );
  }

  let result;

  try {
    result = JSON.parse(textBlocks.join('\n'));
  } catch (e) {
    throw new Error(
      `Claude spelling structured output could not be parsed: ${e.message}`
    );
  }

  return result.spelling_sheets || [];
}


function spoSpellingExtractionSchema_() {
  return {
    type: 'object',
    additionalProperties: false,

    properties: {
      spelling_sheets: {
        type: 'array',

        items: {
          type: 'object',
          additionalProperties: false,

          properties: {
            source_page: {
              type: 'integer',
            },

            confidence: {
              type: 'number',
            },

            words: {
              type: 'array',

              items: {
                type: 'object',
                additionalProperties: false,

                properties: {
                  word_number: {
                    type: ['integer', 'null'],
                  },

                  student_spelling: {
                    type: ['string', 'null'],
                  },

                  correct_spelling: {
                    type: ['string', 'null'],
                  },

                  needs_work: {
                    type: 'boolean',
                  },

                  needs_review: {
                    type: 'boolean',
                  },
                },

                required: [
                  'word_number',
                  'student_spelling',
                  'correct_spelling',
                  'needs_work',
                  'needs_review',
                ],
              },
            },
          },

          required: [
            'source_page',
            'confidence',
            'words',
          ],
        },
      },
    },

    required: [
      'spelling_sheets',
    ],
  };
}