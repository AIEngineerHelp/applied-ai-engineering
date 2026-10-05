"""Rules-based protections: input length, blocklist, and regex filters.

Deterministic, free, and instant, which is why they run first. They catch known phrasings
and nothing else: a paraphrase, another language, or an encoding walks straight past them.
The look-alike benign messages in the dataset show the opposite failure, a false alarm.
"""

import re

MAX_INPUT_CHARS = 2000

# Common prompt-injection and jailbreak phrasings. Deliberately short: a long list grows false alarms.
INJECTION_PATTERNS = [
    r"\bignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)",
    r"\bdisregard (all |your |the )?(previous |prior )?(instructions|rules|guidelines)",
    r"\b(system|developer) prompt\b",
    r"\byour (instructions|rules|guidelines) (are|say)\b",
    r"\byou are now\b",
    r"\b(developer|god|jailbreak|dan) mode\b",
    r"\bpretend (you are|to be) (an? )?(unrestricted|unfiltered)",
    r"\bnew instructions?:",
    r"\b(repeat|print|reveal|show) (everything|all text|the text) above\b",
]

# Words a support agent should never be asked to act on. A blocklist is crude by design.
BLOCKLIST = ["drop table", "rm -rf", "<script", "union select", "; --"]

# Words that suggest an in-scope support request. Used only by the rules-only relevance baseline.
SCOPE_WORDS = [
    "order", "refund", "return", "shipping", "ship", "deliver", "package", "parcel", "track",
    "cancel", "address", "invoice", "receipt", "charge", "payment", "account", "item", "exchange",
    "damaged", "broken", "missing", "late", "arrive", "size", "warranty", "a1", "b2",
]

_injection = [re.compile(p, re.IGNORECASE) for p in INJECTION_PATTERNS]


def check(text):
    """Return the rules-based verdict for one message: which rules fired, and the derived labels."""
    lowered = text.lower()
    fired = []
    if len(text) > MAX_INPUT_CHARS:
        fired.append("length")
    fired += [f"injection:{p.pattern}" for p in _injection if p.search(text)]
    fired += [f"blocklist:{word}" for word in BLOCKLIST if word in lowered]
    in_scope = any(re.search(rf"\b{re.escape(w)}", lowered) for w in SCOPE_WORDS)
    return {
        "attack": any(f.startswith(("injection", "blocklist", "length")) for f in fired),
        # Rules have no notion of abuse beyond a word list; this baseline leaves moderation to the classifiers.
        "harmful": False,
        "in_scope": in_scope,
        "fired": fired,
    }
