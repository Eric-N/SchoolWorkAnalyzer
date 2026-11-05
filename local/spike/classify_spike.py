"""Step-1 accuracy spike: local stage-1 classification vs saved Claude results.

Usage (from local/):
    python spike/classify_spike.py [--model qwen2.5vl:7b] [--dpi 200] [--only 10-10-2026]

Reads  local/spike_data/<name>.pdf + <name>.expected.json
Writes local/spike_out/<model>-<dpi>/<name>.local.json and summary.json
"""

import argparse
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))

from spo import classify, llm  # noqa: E402


# The Results JSON holds post-stage-2 labels: HomeworkMatching.gs relabels a
# school_work page as "homework", and stage 1 never assigns "homework".
STAGE1_EQUIV = {"homework": "school_work"}


def stage1_category(category):
    return STAGE1_EQUIV.get(category, category)


def norm_code(code):
    return re.sub(r"[^a-z0-9]", "", (code or "").lower()) or None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=llm.DEFAULT_MODEL)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--num-ctx", type=int, default=llm.DEFAULT_NUM_CTX)
    ap.add_argument("--only", help="run a single scan by name stem")
    ap.add_argument("--tag", help="suffix for the output folder, to keep earlier runs")
    ap.add_argument("--rescore", action="store_true",
                    help="re-grade saved <name>.local.json files without calling the model")
    args = ap.parse_args()

    data_dir = LOCAL / "spike_data"
    run_name = f"{args.model.replace(':', '_')}-{args.dpi}"
    if args.num_ctx != llm.DEFAULT_NUM_CTX:
        run_name += f"-ctx{args.num_ctx}"
    if args.tag:
        run_name += f"-{args.tag}"
    out_dir = LOCAL / "spike_out" / run_name
    out_dir.mkdir(parents=True, exist_ok=True)

    pdfs = sorted(data_dir.glob("*.pdf"))
    if args.only:
        pdfs = [p for p in pdfs if p.stem == args.only]

    confusion = Counter()  # (expected, got)
    code_total = code_hits = 0
    page_seconds, retries = [], 0
    mismatches = []
    failures = []

    for pdf in pdfs:
        expected = json.loads((data_dir / f"{pdf.stem}.expected.json").read_text(encoding="utf-8"))
        scan_date = classify.parse_scan_date_from_name(pdf.name)
        local_json = out_dir / f"{pdf.stem}.local.json"
        t0 = time.perf_counter()
        if args.rescore:
            result = classify.ClassifyResult(json.loads(local_json.read_text(encoding="utf-8")))
        else:
            try:
                result = classify.classify_pdf(pdf, scan_date, model=args.model, dpi=args.dpi,
                                               num_ctx=args.num_ctx)
            except Exception as e:  # keep going so one bad scan doesn't sink the run
                failures.append(f"{pdf.stem}: {type(e).__name__}: {e}")
                print(f"{pdf.stem}: FAILED {e}", flush=True)
                continue
            local_json.write_text(json.dumps(result.analysis, indent=2), encoding="utf-8")
        elapsed = time.perf_counter() - t0

        exp_by_page = {p["page_number"]: p for p in expected["pages"]}
        correct = 0
        for got in result.analysis["pages"]:
            exp = exp_by_page.get(got["page_number"])
            if exp is None:
                continue
            exp_cat = stage1_category(exp["category"])
            confusion[(exp_cat, got["category"])] += 1
            if exp_cat == got["category"]:
                correct += 1
            else:
                mismatches.append(
                    f"{pdf.stem} p{got['page_number']}: expected {exp_cat}, got "
                    f"{got['category']} ({got['confidence']:.2f}) | exp title={exp.get('title')!r} "
                    f"| got reason={got['reason'][:120]!r}"
                )
            if norm_code(exp.get("document_code")):
                code_total += 1
                code_hits += norm_code(exp["document_code"]) == norm_code(got.get("document_code"))

        page_seconds += [t.seconds for t in result.timings]
        retries += sum(t.attempts - 1 for t in result.timings)
        n = len(result.analysis["pages"])
        print(f"{pdf.stem}: {correct}/{n} categories match, {elapsed:.0f}s ({elapsed / n:.1f}s/page)",
              flush=True)

    total = sum(confusion.values())
    right = sum(v for (e, g), v in confusion.items() if e == g)
    summary = {
        "model": args.model,
        "dpi": args.dpi,
        "num_ctx": args.num_ctx,
        "pages": total,
        "category_accuracy": round(right / total, 3) if total else None,
        "document_code_accuracy": round(code_hits / code_total, 3) if code_total else None,
        "document_codes_compared": code_total,
        "sec_per_page_avg": round(sum(page_seconds) / len(page_seconds), 2) if page_seconds else None,
        "sec_per_page_max": round(max(page_seconds), 2) if page_seconds else None,
        "schema_retries": retries,
        "confusion": {f"{e} -> {g}": v for (e, g), v in sorted(confusion.items())},
        "failures": failures,
        "mismatches": mismatches,
    }
    (out_dir / ("summary.rescore.json" if args.rescore else "summary.json")).write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "mismatches"}, indent=2))
    print("\nMismatches:")
    print("\n".join(mismatches) or "  none")


if __name__ == "__main__":
    main()
