"""Output guardrails: a PII filter and a system-prompt leak check.

Both run on the agent's final reply, after the model has spoken and before the user sees it.
"""

import re

# A random marker placed in the system prompt. It has no meaning, so it should never appear in a reply;
# if it does, the model is repeating its instructions.
CANARY = "GL-CANARY-7f3a91"

EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE = re.compile(r"(?<!\w)\+?\d[\d\s().-]{8,}\d(?!\w)")
CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
US_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")


def luhn(digits):
    """Card numbers carry a check digit; requiring it removes most false matches on order numbers."""
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def find_pii(text, allowed=()):
    """PII spans in text, except values the current user is allowed to see (their own email, say)."""
    allowed = {a.lower() for a in allowed}
    found = []
    for kind, pattern in (("email", EMAIL), ("ssn", US_SSN), ("phone", PHONE), ("card", CARD)):
        for match in pattern.finditer(text):
            value = match.group()
            digits = re.sub(r"\D", "", value)
            if kind == "card" and not (13 <= len(digits) <= 19 and luhn(digits)):
                continue
            if kind == "phone" and not 10 <= len(digits) <= 15:
                continue
            if value.lower() in allowed or digits in allowed:
                continue
            if any(start <= match.start() < end for _, _, start, end in found):
                continue
            found.append((kind, value, match.start(), match.end()))
    return found


def redact(text, allowed=()):
    spans = sorted(find_pii(text, allowed), key=lambda s: s[2], reverse=True)
    for kind, _, start, end in spans:
        text = text[:start] + f"[{kind} removed]" + text[end:]
    return text, [{"kind": k, "value": v} for k, v, _, _ in spans]


def check(text, allowed=()):
    """Return the reply the user may see and what was changed or blocked."""
    if CANARY in text:
        return "Sorry, I can't share that. Is there anything else I can help with on your order?", {
            "blocked": "system_prompt_leak", "redacted": []}
    safe, redacted = redact(text, allowed)
    return safe, {"blocked": None, "redacted": redacted}
