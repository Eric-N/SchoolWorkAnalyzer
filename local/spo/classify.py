"""Stage 1: page classification (Anthropic.gs spoAnalyzePdfWithClaude_).

Claude read the whole PDF in one call; the local model classifies one page per
call with the same prompt and schema, and the per-page results are merged.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import llm, render
from .prompts import build_scan_prompt, not_school_paper_addendum, single_page_addendum
from .schemas import school_scan_schema


def parse_scan_date_from_name(name: str) -> str | None:
    """Filename half of DriveUtils.gs spoParseScanDate_ -> ISO yyyy-MM-dd."""
    m = re.search(r"(?:^|\D)(\d{2})-(\d{2})-(\d{4})(?:\D|$)", name)
    if m:
        return f"{m[3]}-{m[1]}-{m[2]}"
    m = re.search(r"(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)", name)
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}"
    return None


def validate_analysis(analysis: dict) -> None:
    """Anthropic.gs spoValidateAnalysis_."""
    if not isinstance(analysis, dict):
        raise ValueError("analysis is not an object.")
    if not isinstance(analysis.get("pages"), list):
        raise ValueError('analysis is missing required "pages" array.')
    for index, page in enumerate(analysis["pages"]):
        pn = page.get("page_number")
        if not isinstance(pn, int) or isinstance(pn, bool) or pn < 1:
            raise ValueError(f"Page entry {index} has invalid page_number.")
        if not page.get("category"):
            raise ValueError(f"Page {pn} is missing category.")
        c = page.get("confidence")
        if not isinstance(c, (int, float)) or isinstance(c, bool) or c < 0 or c > 1:
            raise ValueError(f"Page {pn} has invalid confidence.")


def _check_single_page(data: dict) -> None:
    """Per-call version of validate_analysis, so a bad reply is retried.

    The schema doesn't bound confidence, and qwen2.5vl:32b sometimes answers on
    a 0-100 scale (e.g. 100), so percentages are rescaled to 0-1 in place.
    """
    if not data["pages"]:
        raise ValueError("model returned no page entry")
    page = data["pages"][0]
    c = page.get("confidence")
    if isinstance(c, (int, float)) and not isinstance(c, bool) and 1 < c <= 100:
        page["confidence"] = c / 100
    validate_analysis({"pages": [dict(data["pages"][0], page_number=1)]})


@dataclass
class PageTiming:
    page_number: int
    seconds: float
    attempts: int


@dataclass
class ClassifyResult:
    analysis: dict
    timings: list[PageTiming] = field(default_factory=list)


def classify_pdf(
    pdf_path: Path,
    scan_date: str,
    model: str = llm.DEFAULT_MODEL,
    dpi: int = render.DEFAULT_DPI,
    num_ctx: int = llm.DEFAULT_NUM_CTX,
) -> ClassifyResult:
    images = render.render_pages(pdf_path, dpi=dpi)
    base_prompt = build_scan_prompt(scan_date) + not_school_paper_addendum()
    schema = school_scan_schema()

    pages, timings = [], []
    for i, png in enumerate(images, start=1):
        prompt = base_prompt + single_page_addendum(i, len(images))
        result = llm.chat_json(prompt, schema, images=[png], model=model, num_ctx=num_ctx,
                               check=_check_single_page)
        # One image per call: trust our page index, not the model's numbering.
        entry = dict(result.data["pages"][0], page_number=i)
        pages.append(entry)
        timings.append(PageTiming(i, result.seconds, result.attempts))

    analysis = {"pages": pages}
    validate_analysis(analysis)
    return ClassifyResult(analysis, timings)
