"""JSON schemas, ported VERBATIM from the .gs files."""


def school_scan_schema() -> dict:
    """Anthropic.gs spoSchoolScanSchema_ (verbatim)."""
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "page_number": {"type": "integer"},
                        "category": {
                            "type": "string",
                            "enum": [
                                "homework_sheet",
                                "informational_flyer",
                                "spelling_word_sheet",
                                "school_work",
                                "other",
                                "unknown",
                            ],
                        },
                        "title": {"type": ["string", "null"]},
                        "document_code": {"type": ["string", "null"]},
                        "subject": {"type": ["string", "null"]},
                        "assignment_match": {"type": ["string", "null"]},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": [
                        "page_number",
                        "category",
                        "title",
                        "document_code",
                        "subject",
                        "assignment_match",
                        "confidence",
                        "reason",
                    ],
                },
            },
        },
        "required": ["pages"],
    }
