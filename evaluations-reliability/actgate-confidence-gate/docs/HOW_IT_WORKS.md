# ActGate — How It Works

**ActGate** is a confidence-gated support assistant.  
**Laya** (local) and **Jev** (cloud) *decide*. **Gemini** *writes* only after the gate opens. Your code owns the rules.

UI: http://127.0.0.1:8787

---

## One-sentence pitch

Most AI apps let a chatbot invent actions. ActGate separates **judgment** from **generation**: typed decisions with confidence first, then a draft reply only when it is safe.

---

## Architecture

```text
Customer message
       │
       ▼
┌──────────────┐     fast / private
│  LAYA (local)│ ──────────────────────────┐
│  System One  │                           │
└──────────────┘                           ▼
                                   ┌───────────────┐
                                   │  GATE (code)  │
                                   │ thresholds +  │
                                   │ risk policy   │
                                   └───────┬───────┘
              borderline / Laya down       │
                       │                   ├── auto_draft ──► GEMINI ──► reply draft
                       ▼                   ├── ask_human ───► review queue
                ┌────────────┐             └── blocked ─────► stop
                │ JEV (cloud)│
                │ TypeSafe   │
                └─────┬──────┘
                      ▼
                 GATE again
                      │
                      └── same outcomes as above

All runs saved to PostgreSQL (database: act) with per-step timings.
```

---

## What each piece does

| Piece | Role | Generates text? |
|-------|------|-----------------|
| **Laya** | Local System One model — picks intent, urgency, risk, next step + probabilities | No |
| **Jev** | TypeSafe cloud System One — second opinion or primary if Laya is skipped/unavailable | No |
| **Gate** | Your Python rules on confidence / risk / next_step | No |
| **Gemini** | Writes the customer reply **after** gate = `auto_draft` | Yes |
| **Postgres** | Stores cases, answers, drafts, timing | — |

### Gate outcomes

| Decision | Meaning |
|----------|---------|
| `auto_draft` | Confidence high enough → call Gemini |
| `jev_second_opinion` | Borderline → ask Jev |
| `ask_human` | Escalate; no auto draft |
| `blocked` | High risk → stop |

Default thresholds (`.env`): `CONFIDENCE_AUTO=0.82`, `CONFIDENCE_JEV=0.55`, `RISK_BLOCK=high`.

---

## Request lifecycle

1. User pastes subject + body in the UI (or `POST /api/pipeline`).
2. **Laya** answers fixed questions (intent, urgency, frustration, risk, next_step).
3. **Gate** evaluates confidence and risk.
4. If needed, **Jev** re-judges; gate runs again.
5. If `auto_draft`, **Gemini** writes a short reply.
6. Result + **timing** saved to `case_runs` in Postgres.

### Timing fields (what “reaching the goal” means)

Goal name: `decide_and_draft`

- `goal_reached: true` → decision cleared the gate **and** a draft was produced (or decision-only mode).
- Each step reports `duration_ms`: `laya_decide`, `gate_after_laya`, `jev_decide`, `gate_after_jev`, `gemini_draft`.
- `total_ms` is the sum of those steps.

Example measured on this machine:

| Step | Typical time |
|------|----------------|
| Laya first load (once) | ~14 min (download); later ~1 min |
| Laya decide (CPU) | ~6 s |
| Jev decide | ~0.6–2 s |
| Gate | ~0.1 ms |
| Gemini draft | ~11–13 s |
| Full decide + draft (Jev path) | ~12–15 s |

---

## API cheat sheet

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Product UI |
| GET | `/api/health` | DB / Laya / Jev / Gemini status |
| POST | `/api/pipeline` | Run full pipeline |
| POST | `/api/laya/load` | Force-load Laya |
| GET | `/api/cases` | Recent runs |
| GET | `/api/cases/{id}` | One case detail |

### Example body

```json
{
  "subject": "Charged twice",
  "body": "I was charged twice for order #4421. Please refund.",
  "force_jev": false,
  "skip_draft": false
}
```

---

## Run locally

```bash
cd evaluations-reliability/actgate-confidence-gate
python -m uvicorn app.main:app --host 127.0.0.1 --port 8787
```

Postgres (configured):

```env
DATABASE_URL=postgresql+psycopg://postgres:PASSWORD@127.0.0.1:5433/act
```

Never commit `.env` (API keys + DB password).

---

## Why this pattern is worth learning

- Hybrid **System One + System Two** (decide ≠ generate)
- Local model for privacy/speed + cloud fallback
- Explicit **confidence gate** and human escalation
- Measurable **latency per step** to a clear product goal
