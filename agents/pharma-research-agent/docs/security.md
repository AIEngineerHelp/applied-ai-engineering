# Guardrails and security

How the agent defends against the risks in OWASP's two lists for LLM and agentic applications, and what is still open. Paths are relative to `agents/pharma-research-agent/`.

## The guardrails

All of them apply one risk catalogue, `agent/guardrails/risks.ts`. Each risk has a domain and category, the behaviour the agent must follow, what is prohibited, what is allowed instead, and example prompts. The input screen and the output check are both built from these definitions, so a policy change is one edit. This is the method LangChain's *Financial Services Agents in Production* describes for Chime's compliance evals, applied to pharma.

| Risk | Stage | Behaviour |
|---|---|---|
| Personal treatment advice | question, answer | Refuse + redirect: research the general question instead, and say so |
| Personal dosing instructions | question, answer | Refuse + redirect |
| Self-harm or overdose | question | Refuse, with crisis resources |
| Misuse, diversion or synthesis | question | Refuse |
| Off-label promotion | answer | Remove the sentence |
| Overstated claims | answer | Remove the sentence |
| Prompt injection | question | Refuse |
| Personal data | question, answer, feedback | Redact |

They run at three stages:

1. **The question** (`agent/nodes/input-guard.ts`, the first node of the graph)
   - The API route caps questions at 500 characters and redacts personal data (`agent/guardrails/pii.ts`) before the question is stored, logged or sent to a model.
   - A pattern check (`agent/guardrails/injection.ts`) refuses direct prompt injection without a model call.
   - One fast model call classifies the question against the catalogue (`agent/guardrails/input.ts`). Refused questions end the run; personal advice continues as its general question, with a notice.
   - If the screen cannot run, the run fails rather than researching an unscreened question.
2. **Retrieved content** (`agent/subgraphs/researcher-loop.ts`)
   - Everything the tools return is untrusted. Sentences that look like instructions to an AI are replaced before any model, file or report sees them, the source is flagged, and the decision is recorded.
   - Every prompt states that tool results, files and reports are data, not instructions.
3. **The answer** (`agent/nodes/output-guard.ts`, between the writer and the checks)
   - Citations to sources no agent retrieved are removed.
   - Personal data is redacted.
   - A model checks each sentence against the catalogue; sentences that break a risk are removed and the report's limitations say why. If this check cannot run, the report is kept and the trace records that it was not policy-checked.

Every decision is a `guardrail` event in the run's trace, shown in the activity line, in a notice on the answer when a question was refused or redirected, and in full under **Run details › Guardrails**. Guardrail checks use their own model setting (`GEMINI_GUARD_MODEL`), because models differ in how well they do each guardrail task.

## OWASP Top 10 for LLM Applications (2025)

| Risk | Status here |
|---|---|
| LLM01 Prompt Injection | Direct: pattern check plus model screen on the question. Indirect: retrieved text is screened and neutralised, and prompts treat it as data. |
| LLM02 Sensitive Information Disclosure | Personal data is redacted from questions, feedback comments and reports; reports are private to a browser workspace unless shared. |
| LLM03 Supply Chain | Locked dependencies (`package-lock.json`); the model is called through LangChain's official Google integration. No dependency audit runs in CI yet. |
| LLM04 Data and Model Poisoning | Not applicable: no training or fine-tuning. Retrieved sources are public and screened. |
| LLM05 Improper Output Handling | Model output is rendered as text, never HTML or code; citations are checked against retrieved sources. |
| LLM06 Excessive Agency | Tools are read-only searches of public databases; sub-agents have a 6-turn limit and the graph a recursion limit. |
| LLM07 System Prompt Leakage | Prompts hold no secrets; requests to reveal them are refused as prompt injection. |
| LLM08 Vector and Embedding Weaknesses | Not applicable: no vector store. |
| LLM09 Misinformation | Every claim must cite a retrieved source; unsupported citations are removed; overstated claims are removed; an LLM judge scores groundedness; a disclaimer is on every answer. |
| LLM10 Unbounded Consumption | A cost and model-call budget per run, checked before every model call (`agent/limits.ts`); a run deadline; rate limits per browser and per IP address and on runs in progress (`lib/rate-limit.ts`); bounded turns and retries; a kill switch and an optional global daily cap. |

## OWASP Top 10 for Agentic Applications (2026)

| Risk | Status here |
|---|---|
| ASI01 Agent Goal Hijack | The retrieval guard and data-not-instructions prompts; the plan is fixed before research and the writer works only from files. |
| ASI02 Tool Misuse and Exploitation | Read-only tools with schema-validated arguments; turn limits; client-side rate limiting per public API. |
| ASI03 Identity and Privilege Abuse | No user accounts or privileges to abuse; agents hold no credentials beyond read-only public API access. |
| ASI04 Agentic Supply Chain Vulnerabilities | Skills and prompts are files in this repository, not fetched at runtime. |
| ASI05 Unexpected Code Execution | The agent generates and runs no code. |
| ASI06 Memory and Context Poisoning | Earlier turns come only from this conversation's own completed, guarded reports. |
| ASI07 Insecure Inter-Agent Communication | Sub-agents run in one process and hand off through the graph's state and the run's files, not a network. |
| ASI08 Cascading Failures | A failed knowledge base becomes an empty finding instead of failing the run; nodes retry; LangGraph checkpoints let a run resume. |
| ASI09 Human-Agent Trust Exploitation | Confidence, citations verified and claims supported are shown on every answer, with sources one click away; the not-medical-advice notice. |
| ASI10 Rogue Agents | Every model and tool call is traced; the kill switch (`RESEARCH_ENABLED=false`) stops new runs. |

The agentic list's category names come from summaries of the OWASP release (December 2025); see [OWASP's page](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) for the authoritative text.

## Known gaps

- **Rate limits without accounts.** Limits are per browser cookie and per IP address; a visitor with many addresses can start more runs. The per-run budget and the optional daily cap bound the cost.
- **Names in free text.** Personal-data redaction catches structured identifiers (contacts, record and ID numbers, dates of birth); a bare name with health details is not detected.
- **Guardrails are models too.** The screen and the policy check can miss things or over-block; they are measured only by the tests in `tests/guardrails.test.ts`, not yet by an adversarial eval set.
- **Streaming before the check.** The answer streams as it is written; a sentence removed by the output guard can appear briefly before the final report replaces the draft.
- **No accounts.** Access control is a browser cookie; anyone with a share link can read a shared conversation.

## Observability

- Every agent, model and tool call is a span in the run's own trace (Run details › Trace), with tokens and cost.
- With `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` set, LangSmith also traces every LangGraph node and LangChain call; runs are tagged with the report id. On Vercel, set `LANGCHAIN_CALLBACKS_BACKGROUND=false` so traces are sent before the function ends.
- Readers rate each answer (thumbs up or down, with an optional comment). `npm run feedback:export` writes the rated answers, with their evals and guardrail decisions, to `runs/feedback.jsonl` as an eval dataset.
