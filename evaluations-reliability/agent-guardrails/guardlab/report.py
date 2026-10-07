"""Turn raw runs into results/: JSON summaries, per-item exports, and a Markdown report."""

import json

from guardlab import config, evaluate
from guardlab.agent import CONFIGS

GROUP_NAMES = {
    "on_topic": "Ordinary requests", "lookalike": "Look-alike requests", "off_topic": "Off-topic questions",
    "injection": "Injection and jailbreak", "extraction": "Prompt extraction", "obfuscated": "Encoded or translated",
    "harmful": "Abusive",
}


def pct(r):
    if not r or r["n"] == 0:
        return "–"
    lo, hi = r["ci95"]
    return f"{r['hits']}/{r['n']} ({r['rate'] * 100:.0f}%, {lo * 100:.0f}–{hi * 100:.0f})"


def short(r):
    return "–" if not r or r["n"] == 0 else f"{r['hits']}/{r['n']}"


def classifier_table(messages, rule_verdicts, model_runs, settings):
    """Every classifier and every layered combination, on the same messages."""
    columns = {"rules": (rule_verdicts, None)}
    for provider, rows in model_runs.items():
        if len(rows) == len(messages):
            verdicts = {i: r["verdict"] for i, r in rows.items()}
            columns[provider] = (verdicts, {i: r["usage"] for i, r in rows.items()})
            columns[f"rules + {provider}"] = (
                {i: evaluate.combine(rule_verdicts[i], verdicts[i]) for i in verdicts}, None)
        elif rows:
            columns[f"{provider} (partial: {len(rows)}/{len(messages)})"] = (
                {i: r["verdict"] for i, r in rows.items()}, {i: r["usage"] for i, r in rows.items()})
    metrics = {}
    for name, (verdicts, usages) in columns.items():
        m = evaluate.classifier_metrics(messages, verdicts, usages)
        if usages:
            provider = name.split(" ")[0]
            rates = settings.rates.get(provider, (None, None))
            c = config.cost(rates, m["tokens"]["input"], m["tokens"]["output"])
            m["usd_per_1000_messages"] = round(c / m["tokens"]["calls"] * 1000, 4) if c is not None else None
            m["models"] = sorted({u.get("model") for u in usages.values() if u.get("model")})
        metrics[name] = m
    return metrics


def message_rows(messages, rule_verdicts, model_runs):
    rows = []
    for m in messages:
        row = {"id": m["id"], "group": m["group"], "text": m["text"],
               "label": {k: m[k] for k in ("in_scope", "attack", "harmful")},
               "rules": {"attack": rule_verdicts[m["id"]]["attack"], "in_scope": rule_verdicts[m["id"]]["in_scope"],
                         "fired": rule_verdicts[m["id"]]["fired"]}}
        for provider, runs in model_runs.items():
            if m["id"] in runs:
                row[provider] = runs[m["id"]]["verdict"]
        rows.append(row)
    return rows


def misses(messages, verdicts_by_name):
    """Which attacks each classifier let through, and which genuine messages it flagged."""
    out = {}
    for name, verdicts in verdicts_by_name.items():
        missed = [m for m in messages if m["group"] in evaluate.ATTACK_GROUPS and m["id"] in verdicts
                  and not verdicts[m["id"]].get("attack")]
        false = [m for m in messages if m["group"] in ("on_topic", "lookalike") and m["id"] in verdicts
                 and (evaluate.flags(verdicts[m["id"]])["blocked"] or evaluate.flags(verdicts[m["id"]])["off_topic"])]
        out[name] = {"missed_attacks": [m["id"] for m in missed], "false_alarms": [m["id"] for m in false]}
    return out


def write(messages, rule_verdicts, model_runs, agent_rows, settings, scenarios, store_data):
    config.RESULTS.mkdir(exist_ok=True)
    written = []
    metrics = classifier_table(messages, rule_verdicts, model_runs, settings)
    verdicts = {"rules": rule_verdicts, **{p: {i: r["verdict"] for i, r in rows.items()}
                                          for p, rows in model_runs.items() if rows}}
    sweep = ({"jev": evaluate.threshold_sweep(messages, verdicts["jev"])} if "jev" in verdicts else {})
    classifier_result = {"metrics": metrics, "jev_threshold_sweep": sweep, "errors": misses(messages, verdicts)}
    path = config.RESULTS / "classifiers.json"
    path.write_text(json.dumps(classifier_result, indent=2, ensure_ascii=False) + "\n")
    written.append(path)
    path = config.RESULTS / "messages.jsonl"
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n"
                            for r in message_rows(messages, rule_verdicts, model_runs)))
    written.append(path)

    agent_result = {}
    for run, configs in agent_rows.items():
        agent_result[run] = {}
        for name, rows in configs.items():
            scored = [r for r in rows if "score" in r]
            agent_result[run][name] = {
                "layers": scored[0]["layers"] if scored else [],
                "summary": evaluate.agent_summary([r["score"] for r in scored]),
                "scenarios": {r["id"]: r["score"] for r in scored},
                "errors": [r["id"] for r in rows if "error" in r],
            }
            # Traces are synthetic, so they are published in full for readers to inspect.
            trace_path = config.RESULTS / "traces" / run / f"{name}.jsonl"
            trace_path.parent.mkdir(parents=True, exist_ok=True)
            trace_path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in scored))
    path = config.RESULTS / "agent.json"
    path.write_text(json.dumps(agent_result, indent=2, ensure_ascii=False) + "\n")
    written.append(path)

    path = config.RESULTS / "report.md"
    path.write_text(markdown(classifier_result, agent_result, messages, scenarios, settings))
    written.append(path)
    return written


def markdown(classifier_result, agent_result, messages, scenarios, settings):
    lines = ["# Guardrail experiment results", "",
             "Generated by `uv run python -m guardlab analyze`. Rates show hits/total (percent, 95% Wilson interval).", ""]
    metrics = classifier_result["metrics"]
    lines += ["## Experiment 1: input classifiers", ""]
    header = "| | " + " | ".join(metrics) + " |"
    lines += [header, "|---" * (len(metrics) + 1) + "|"]

    def row(label, fn):
        lines.append(f"| {label} | " + " | ".join(fn(m) for m in metrics.values()) + " |")

    row("Attacks caught (all)", lambda m: pct(m["attack_recall"]))
    for g in evaluate.ATTACK_GROUPS:
        row(f"– {GROUP_NAMES[g]}", lambda m, g=g: short(m["attack_recall_by_group"][g]))
    row("Abusive messages caught", lambda m: short(m["harmful_recall"]))
    row("Off-topic questions redirected", lambda m: short(m["off_topic_recall"]))
    for g in ("on_topic", "lookalike"):
        row(f"{GROUP_NAMES[g]} wrongly blocked as attacks", lambda m, g=g: pct(m["false_block"][g]))
        row(f"{GROUP_NAMES[g]} wrongly redirected as off-topic", lambda m, g=g: pct(m["false_off_topic"][g]))
    row("Latency p50 / p95 (ms)", lambda m: f"{m['latency_ms']['p50']} / {m['latency_ms']['p95']}" if "latency_ms" in m else "<1")
    row("Tokens per call, input / output", lambda m: (
        f"{m['tokens']['input'] // m['tokens']['calls']} / {m['tokens']['output'] // m['tokens']['calls']}"
        if m.get("tokens") else "–"))
    row("USD per 1,000 messages", lambda m: (f"{m['usd_per_1000_messages']:.3f}" if m.get("usd_per_1000_messages") is not None
                                              else ("0" if "latency_ms" not in m else "unknown")))
    row("Model version", lambda m: ", ".join(m.get("models", [])) or "–")
    lines.append("")

    if classifier_result["jev_threshold_sweep"]:
        lines += ["### Jev attack probability thresholds", "",
                  "| Flag as attack when p(attack) ≥ | Attacks caught | False alarms on benign messages |", "|---|---|---|"]
        for r in classifier_result["jev_threshold_sweep"]["jev"]:
            lines.append(f"| {r['threshold']} | {pct(r['recall'])} | {pct(r['false_alarm'])} |")
        lines.append("")

    text = {m["id"]: m["text"] for m in messages}
    lines += ["### Errors by classifier", ""]
    for name, err in classifier_result["errors"].items():
        lines.append(f"**{name}**: missed {len(err['missed_attacks'])} attacks, "
                     f"{len(err['false_alarms'])} false alarms on genuine requests.")
        lines.append("")
        for i in err["missed_attacks"]:
            lines.append(f"- missed `{i}`: {text[i]}")
        for i in err["false_alarms"]:
            lines.append(f"- false alarm `{i}`: {text[i]}")
        lines.append("")

    lines += ["## Experiment 2: the agent under each guardrail configuration", ""]
    for c, layers in CONFIGS.items():
        lines.append(f"- `{c}`: {', '.join(layers) or 'no guardrails'}")
    lines.append("")
    titles = {s["id"]: s for s in scenarios}
    for run, configs in agent_result.items():
        model, classifier = run.split("+")
        lines += [f"### Model: {model}, classifier: {classifier}", "",
                  "| Configuration | Attacks that succeeded | Direct | Indirect | Policy | Benign: completed | Benign: sent to a person | Benign: blocked or not done |",
                  "|---|---|---|---|---|---|---|---|"]
        for name in CONFIGS:
            if name not in configs:
                continue
            s = configs[name]["summary"]
            o = s["benign_outcomes"]
            lines.append(f"| `{name}` | {pct(s['attack_success'])} | {short(s['attack_success_by_kind']['direct'])} | "
                         f"{short(s['attack_success_by_kind']['indirect'])} | {short(s['attack_success_by_kind']['policy'])} | "
                         f"{o.get('completed', 0)} | {o.get('sent to a person', 0)} | "
                         f"{o.get('blocked', 0) + o.get('not done', 0)} |")
        lines += ["", "| Scenario | " + " | ".join(n for n in CONFIGS if n in configs) + " |",
                  "|---" * (1 + sum(n in configs for n in CONFIGS)) + "|"]
        for sid, sc in titles.items():
            cells = []
            for name in CONFIGS:
                if name not in configs:
                    continue
                r = configs[name]["scenarios"].get(sid)
                if r is None:
                    cells.append("–")
                elif sc["kind"] == "benign":
                    cells.append(r["outcome"])
                else:
                    cells.append("**harmed**" if r["harmed"] else f"stopped: {r['stopped_by']}")
            lines.append(f"| `{sid}` {sc['title']} | " + " | ".join(cells) + " |")
        lines.append("")
    return "\n".join(lines) + "\n"


def trace_markdown(scenario, row):
    t = row["trace"]
    lines = [f"## {scenario['id']}: {scenario['title']} ({scenario['kind']})", "",
             f"Layers: {', '.join(row['layers']) or 'none'}", "", f"User: {scenario['message']}", ""]
    for order_id, fields in (scenario.get("orders") or {}).items():
        lines.append(f"Order note on {order_id}: {fields.get('note')}")
    for e in t["events"]:
        lines.append(f"- [{e['layer']}] {json.dumps({k: v for k, v in e.items() if k != 'layer'}, ensure_ascii=False)}")
    for c in t["calls"]:
        lines.append(f"- call {c['tool']}({json.dumps(c['args'], ensure_ascii=False)}) -> {c['decision']}"
                     + (f": {c['reason']}" if c["reason"] else ""))
    lines += ["", f"Reply: {t.get('reply')}", "", f"Effects: {json.dumps(t.get('effects'))}",
              f"Score: {json.dumps(row['score'])}", "", f"Why this case: {scenario['why']}"]
    return "\n".join(lines)
