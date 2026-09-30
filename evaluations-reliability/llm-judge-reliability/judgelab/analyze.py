"""Compare each judge's verdicts with the known verdicts; write results/report.md and report.json."""

from collections import Counter

from judgelab import prompts, stats, store


def compare(items, judgments):
    graded = [i for i in items if i["id"] in judgments]
    truth = [i["expected"] for i in graded]
    verdicts = [judgments[i["id"]]["verdict"] for i in graded]
    right = sum(t == v for t, v in zip(truth, verdicts))
    matrix = stats.confusion(truth, verdicts)
    return {
        "n": len(graded),
        "accuracy": stats.agreement(truth, verdicts),
        "accuracy_ci": stats.wilson(right, len(graded)),
        "kappa": stats.cohen_kappa(truth, verdicts),
        "kappa_ci": stats.bootstrap(truth, verdicts, stats.cohen_kappa),
        **matrix,
        "false_pass_ci": stats.wilson(matrix["false_pass"], matrix["false_pass"] + matrix["true_fail"]),
        "wrong": [i["id"] for i, v in zip(graded, verdicts) if i["expected"] != v],
        # Jev only: how sure the judge was when it passed an answer with a mistake.
        "false_pass_p": sorted(
            (judgments[i["id"]]["p_pass"] for i, v in zip(graded, verdicts)
             if i["expected"] == "fail" and v == "pass" and judgments[i["id"]].get("p_pass") is not None),
            reverse=True,
        ),
    }


def by_error(items, judgments):
    """Share of wrong answers the judge caught, per kind of mistake."""
    result = {}
    for error, count in sorted(Counter(i["error"] for i in items if i["error"]).items()):
        group = [i for i in items if i["error"] == error and i["id"] in judgments]
        caught = sum(judgments[i["id"]]["verdict"] == "fail" for i in group)
        result[error] = {
            "n": len(group),
            "caught": caught,
            "rate": caught / len(group) if group else None,
            "missed": [i["id"] for i in group if judgments[i["id"]]["verdict"] == "pass"],
        }
    return result


def usage_summary(records):
    records = list(records)
    ms = sorted(r["ms"] for r in records if r.get("ms") is not None)
    costs = [r.get("usd") for r in records]
    return {
        "calls": len(records),
        "median_ms": ms[len(ms) // 2] if ms else None,
        "input_tokens": sum(r.get("input_tokens") or 0 for r in records),
        "output_tokens": sum(r.get("output_tokens") or 0 for r in records),
        "usd": round(sum(costs), 6) if records and None not in costs else None,
        "models": sorted({r.get("model") for r in records if r.get("model")}),
    }


def reliability(items, repeats):
    common = [i["id"] for i in items if all(i["id"] in rep for rep in repeats)]
    unstable = [cid for cid in common if len({rep[cid]["verdict"] for rep in repeats}) > 1]
    return {
        "repeats": len(repeats),
        "n": len(common),
        "unstable": unstable,
        "unstable_rate": len(unstable) / len(common) if common else None,
        "unstable_ci": stats.wilson(len(unstable), len(common)),
    }


def length_bias(items, original, padded):
    bias = {}
    for label in ("pass", "fail"):
        group = [i["id"] for i in items if i["expected"] == label and i["id"] in original and i["id"] in padded]
        before = sum(original[i]["verdict"] == "pass" for i in group)
        after = sum(padded[i]["verdict"] == "pass" for i in group)
        bias[f"expected_{label}"] = {
            "n": len(group),
            "pass_rate_original": before / len(group) if group else None,
            "pass_rate_padded": after / len(group) if group else None,
            "flipped_to_pass": [i for i in group if original[i]["verdict"] == "fail" and padded[i]["verdict"] == "pass"],
            "flipped_to_fail": [i for i in group if original[i]["verdict"] == "pass" and padded[i]["verdict"] == "fail"],
        }
    return bias


def analyze(items, runs):
    report = {
        "items": len(items),
        "expected_pass": sum(i["expected"] == "pass" for i in items),
        "expected_fail": sum(i["expected"] == "fail" for i in items),
        "errors": dict(Counter(i["error"] for i in items if i["error"])),
        "variants": {},
    }
    for variant in prompts.VARIANTS:
        first = store.load_judgments(variant, "original", 1, runs)
        if not first:
            continue
        result = {
            "all": compare(items, first),
            "dev": compare([i for i in items if i["split"] == "dev"], first),
            "holdout": compare([i for i in items if i["split"] == "holdout"], first),
            "by_error": by_error(items, first),
            "usage": usage_summary(first.values()),
        }
        # When the judge and the label disagree, which one does the review side with?
        disputed = [i for i in items if i["id"] in first and first[i["id"]]["verdict"] != i["expected"]]
        reviewed = [i for i in disputed if i["review"]]
        if reviewed:
            judge_right = [i["id"] for i in reviewed
                           if (i["review"]["read"] == "problem") == (first[i["id"]]["verdict"] == "fail")
                           and i["review"]["read"] != "debatable"]
            debatable = [i["id"] for i in reviewed if i["review"]["read"] == "debatable"]
            result["disputes"] = {
                "n": len(disputed), "reviewed": len(reviewed),
                "judge_right": judge_right, "debatable": debatable,
                "label_right": [i["id"] for i in reviewed if i["id"] not in judge_right and i["id"] not in debatable],
            }
        # Unsupported details that happen to be true in the real world: does the judge check the passage
        # or its own knowledge?
        world = [i for i in items if i["world_true"] and i["id"] in first]
        if world:
            caught = sum(first[i["id"]]["verdict"] == "fail" for i in world)
            result["world_true"] = {"n": len(world), "caught": caught, "rate": caught / len(world),
                                    "missed": [i["id"] for i in world if first[i["id"]]["verdict"] == "pass"]}
        repeats, r = [first], 2
        while more := store.load_judgments(variant, "original", r, runs):
            repeats.append(more)
            r += 1
        if len(repeats) > 1:
            result["reliability"] = reliability(items, repeats)
        padded = store.load_judgments(variant, "padded", 1, runs)
        if padded:
            result["length_bias"] = length_bias(items, first, padded)
        probs = {
            label: [first[i["id"]]["p_pass"] for i in items
                    if i["expected"] == label and first.get(i["id"], {}).get("p_pass") is not None]
            for label in ("pass", "fail")
        }
        if probs["pass"] or probs["fail"]:
            result["mean_p_pass"] = {k: sum(v) / len(v) if v else None for k, v in probs.items()}
        report["variants"][variant] = result
    return report


def _pct(value):
    return "n/a" if value is None else f"{value * 100:.0f}%"


def _ci(interval, percent=True):
    if interval is None:
        return "n/a"
    lo, hi = interval
    return f"{lo * 100:.0f}–{hi * 100:.0f}%" if percent else f"{lo:.2f} to {hi:.2f}"


def _num(value):
    return "n/a" if value is None else f"{value:.2f}"


def markdown(report):
    lines = ["# LLM judge results", "",
             f"{report['items']} answers: {report['expected_pass']} correct, {report['expected_fail']} with a known mistake."]
    variants = report["variants"]
    if not variants:
        return "\n".join(lines + ["", "No judge runs yet."]) + "\n"

    lines += ["", "## Agreement with the known verdicts (repeat 1)", "",
              "| Judge | n | Accuracy (95% CI) | Kappa (95% CI) | False pass | False fail | Dev kappa | Hold-out kappa |",
              "|---|---|---|---|---|---|---|---|"]
    for name, v in variants.items():
        a = v["all"]
        lines.append(
            f"| {name} | {a['n']} | {_pct(a['accuracy'])} ({_ci(a['accuracy_ci'])}) | "
            f"{_num(a['kappa'])} ({_ci(a['kappa_ci'], False)}) | "
            f"{a['false_pass']}/{a['false_pass'] + a['true_fail']} ({_pct(a['false_pass_rate'])}) | "
            f"{a['false_fail']}/{a['false_fail'] + a['true_pass']} ({_pct(a['false_fail_rate'])}) | "
            f"{_num(v['dev']['kappa'])} | {_num(v['holdout']['kappa'])} |"
        )
    lines += ["", "False pass: the judge passed an answer with a mistake. False fail: it failed a correct answer."]

    errors = sorted(report["errors"])
    lines += ["", "## Mistakes caught, by type", "", "| Judge | " + " | ".join(errors) + " |",
              "|---|" + "---|" * len(errors)]
    for name, v in variants.items():
        cells = [f"{v['by_error'][e]['caught']}/{v['by_error'][e]['n']}" if e in v["by_error"] else "–" for e in errors]
        lines.append(f"| {name} | " + " | ".join(cells) + " |")

    disputes = {k: v["disputes"] for k, v in variants.items() if "disputes" in v}
    if disputes:
        lines += ["", "## When the judge and the label disagree", "",
                  "Disagreements reviewed by reading each answer against its passages (see data/ragtruth-review.json).", "",
                  "| Judge | Disagreements | Reviewed | Judge right | Label right | Debatable |", "|---|---|---|---|---|---|"]
        for name, d in disputes.items():
            lines.append(f"| {name} | {d['n']} | {d['reviewed']} | {len(d['judge_right'])} | {len(d['label_right'])} | "
                         f"{len(d['debatable'])} |")

    world = {k: v["world_true"] for k, v in variants.items() if "world_true" in v}
    if world:
        lines += ["", "## Unsupported but true in the real world", "",
                  "Answers whose only mistake is a detail that is true in the real world but not in the passage.", "",
                  "| Judge | Caught | Missed |", "|---|---|---|"]
        for name, w in world.items():
            lines.append(f"| {name} | {w['caught']}/{w['n']} ({_pct(w['rate'])}) | {', '.join(w['missed']) or 'none'} |")

    reliable = {k: v["reliability"] for k, v in variants.items() if "reliability" in v}
    if reliable:
        lines += ["", "## Run-to-run reliability", "", "| Judge | Repeats | Answers | Changed verdict (95% CI) | Answers |",
                  "|---|---|---|---|---|"]
        for name, r in reliable.items():
            lines.append(f"| {name} | {r['repeats']} | {r['n']} | {_pct(r['unstable_rate'])} ({_ci(r['unstable_ci'])}) | "
                         f"{', '.join(r['unstable']) or 'none'} |")

    biased = {k: v["length_bias"] for k, v in variants.items() if "length_bias" in v}
    if biased:
        lines += ["", "## Length bias (same answer, padded)", "",
                  "| Judge | Answer is | n | Pass rate original | Pass rate padded | Flipped to pass | Flipped to fail |",
                  "|---|---|---|---|---|---|---|"]
        for name, b in biased.items():
            for label, word in (("pass", "correct"), ("fail", "wrong")):
                g = b[f"expected_{label}"]
                lines.append(f"| {name} | {word} | {g['n']} | {_pct(g['pass_rate_original'])} | {_pct(g['pass_rate_padded'])} | "
                             f"{', '.join(g['flipped_to_pass']) or '–'} | {', '.join(g['flipped_to_fail']) or '–'} |")

    probs = {k: v["mean_p_pass"] for k, v in variants.items() if "mean_p_pass" in v}
    if probs:
        lines += ["", "## Jev pass probability", ""]
        for name, p in probs.items():
            lines.append(f"- {name}: mean p(pass) {_num(p['pass'])} on correct answers, {_num(p['fail'])} on wrong ones")

    lines += ["", "## Usage (repeat 1)", "", "| Judge | Models | Calls | Median ms | Input tokens | Output tokens | USD |",
              "|---|---|---|---|---|---|---|"]
    for name, v in variants.items():
        u = v["usage"]
        usd = "rates not set" if u["usd"] is None else f"{u['usd']:.4f}"
        lines.append(f"| {name} | {', '.join(u['models'])} | {u['calls']} | {u['median_ms']} | {u['input_tokens']} | "
                     f"{u['output_tokens']} | {usd} |")
    return "\n".join(lines) + "\n"
