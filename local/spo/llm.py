"""Ollama call plumbing (replaces the Anthropic.gs UrlFetchApp call).

Structured output: the .gs JSON schema is passed as Ollama's `format`, then the
reply is re-validated here because grammar-constrained decoding is not a
guarantee of schema validity.
"""

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass

import jsonschema
import ollama

log = logging.getLogger(__name__)

DEFAULT_MODEL = "qwen2.5vl:7b"
DEFAULT_HOST = "http://127.0.0.1:11434"
# One page per call is ~4.7k tokens at 200 DPI (prompt ~500, image ~4k, answer ~120).
DEFAULT_NUM_CTX = 16384


class LlmError(RuntimeError):
    pass


def ollama_available(host: str = DEFAULT_HOST) -> bool:
    """True if the local Ollama server answers."""
    try:
        ollama.Client(host=host, timeout=5).list()
        return True
    except Exception:
        return False


@dataclass
class LlmResult:
    data: dict
    seconds: float
    attempts: int


def chat_json(
    prompt: str,
    schema: dict,
    images: list[bytes] | None = None,
    model: str = DEFAULT_MODEL,
    host: str = DEFAULT_HOST,
    retries: int = 3,
    num_ctx: int = DEFAULT_NUM_CTX,
    check: Callable[[dict], None] | None = None,
) -> LlmResult:
    """`check` runs after schema validation; a ValueError from it triggers a retry."""
    client = ollama.Client(host=host)
    message = {"role": "user", "content": prompt}
    if images:
        message["images"] = images

    start = time.perf_counter()
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        resp = client.chat(
            model=model,
            messages=[message],
            format=schema,
            options={"temperature": 0, "num_ctx": num_ctx},
        )
        text = (resp.message.content or "").strip()
        try:
            data = json.loads(text)
            jsonschema.validate(data, schema)
            if check:
                check(data)
            return LlmResult(data, time.perf_counter() - start, attempt)
        except (json.JSONDecodeError, jsonschema.ValidationError, ValueError) as e:
            last_error = e
            log.warning("attempt %d: invalid structured output: %s", attempt, str(e)[:300])

    raise LlmError(f"no valid JSON after {retries} attempts: {last_error}")
