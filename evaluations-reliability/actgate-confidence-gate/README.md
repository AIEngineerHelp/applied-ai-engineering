# ActGate: a confidence gate between "decide" and "act"

*By Nagaraju Poralla ([@Porallanagaraju13](https://github.com/Porallanagaraju13)) · original repository: [Porallanagaraju13/actgate](https://github.com/Porallanagaraju13/actgate)*

[Category: Evaluations & Reliability](../README.md) · [Community category](https://aiengineer.help/c/evaluations-reliability/8)

## What it teaches

Most support assistants let one model both decide and write. ActGate separates them. A decision model answers five structured questions about a support ticket (intent, urgency, frustration, risk, next step), and plain code, the **gate**, turns those answers and their confidence into one of four outcomes:

| Decision | When | What happens |
| --- | --- | --- |
| `auto_draft` | Confidence ≥ `CONFIDENCE_AUTO` (0.82) and next step is `draft_reply` | Gemini writes a reply draft |
| `jev_second_opinion` | Confidence between `CONFIDENCE_JEV` (0.55) and `CONFIDENCE_AUTO` | A second model (TypeSafe Jev) decides again, then the gate runs once more |
| `ask_human` | Low confidence, high urgency without enough confidence, or the model chose `ask_human` | Escalate to a person |
| `blocked` | Risk equals `RISK_BLOCK` (`high`) or next step is `block` | No automatic action |

The generator (Gemini) only runs after the gate opens, so a confident-sounding draft can never bypass the policy. Every step is timed, and each case is stored with its decision and timings.

The flow: optional local **Laya** model decides first → gate → **Jev** second opinion when needed (or when Laya is off) → gate again → **Gemini** draft only on `auto_draft`. See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for the architecture.

## Prerequisites

- Python 3.11+
- For the gate tests: nothing else (no keys, no network).
- For the full app: a TypeSafe API key (Jev) and a Gemini API key. Postgres is optional; the default database is a local SQLite file.
- Optional: the Laya local model (`pip install laya`, CPU or GPU, downloads model weights). Leave `LAYA_ENABLED=false` to skip it; Jev then makes every decision.

## Setup and checks

From this directory (`evaluations-reliability/actgate-confidence-gate/`):

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-demo.txt   # app without Laya
# or: pip install -r requirements.txt  # includes laya and pytest
pip install pytest
python -m pytest
```

Expected output: `4 passed` (auto_draft, second opinion, blocked, ask_human). The tests exercise `app/gate.py` only and make no API calls.

## Run the app

```bash
cp .env.example .env    # then fill in TYPESAFE_API_KEY and GEMINI_API_KEY
# set LAYA_ENABLED=false unless Laya is installed
# DATABASE_URL may be removed to use the SQLite default
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Open http://127.0.0.1:8787, pick a sample ticket, and watch the decision, the gate reason, the per-step timings and (on `auto_draft`) the draft.

Run the eight bundled tickets in `data/sample_tickets.json` against the running server:

```bash
python scripts/run_sample_data.py --skip-draft
python scripts/run_sample_data.py --ids refund_calm,bug_android
```

With Docker (Postgres included, Laya off):

```bash
cp .env.example .env    # fill in keys
docker compose up --build
```

## Configuration

All settings are in `.env.example` with placeholders: thresholds (`CONFIDENCE_AUTO`, `CONFIDENCE_JEV`, `URGENCY_HIGH`, `RISK_BLOCK`), the Gemini model (`GEMINI_MODEL`), Laya options, and `DEMO_MODE` (when `true`, visitors can only run the bundled samples, rate-limited per client).

## Costs

The gate tests are free. Each ticket run in the app can make one Jev call and one Gemini call, both billed to your keys; `--skip-draft` avoids the Gemini call. Laya runs locally and costs only compute.

## Limitations

- Model outputs vary; the decision for a given sample ticket is not fixed. Each sample's `expect_hint` describes the usual outcome, not a guarantee.
- The thresholds are hand-set, not calibrated on a labelled dataset. No evaluation results are included yet.
- Laya and Jev are third-party services/models; their availability and pricing are outside this project.
- Educational prototype, not production-ready.

## Sources and credit

Built by Nagaraju Poralla. Uses [FastAPI](https://fastapi.tiangolo.com/), [SQLAlchemy](https://www.sqlalchemy.org/), the TypeSafe SDK (Jev), the Google Gen AI SDK (Gemini) and, optionally, Laya.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Nagaraju Poralla.
