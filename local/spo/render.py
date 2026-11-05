"""PDF -> per-page PNG. Local vision models can't read PDFs directly."""

from pathlib import Path

import pymupdf

DEFAULT_DPI = 200


def page_count(pdf_path: Path) -> int:
    with pymupdf.open(pdf_path) as doc:
        return doc.page_count


def render_pages(pdf_path: Path, dpi: int = DEFAULT_DPI) -> list[bytes]:
    """Return one PNG per page, in page order. The source PDF is only read."""
    with pymupdf.open(pdf_path) as doc:
        return [page.get_pixmap(dpi=dpi).tobytes("png") for page in doc]
