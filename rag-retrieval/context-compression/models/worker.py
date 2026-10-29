"""Optional offline model inference. Never imported or executed by routine tests."""
from __future__ import annotations

import json
import os
import re
import sys


def utf16_offsets(text: str) -> list[int]:
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xFFFF else 1))
    return offsets


def aggregate_words(source: str, scores: list[tuple[int, int, float]]) -> list[dict]:
    """Pool subword keep probabilities into source-aligned whitespace words."""
    offsets = utf16_offsets(source)
    result = []
    cursor = 0
    token_index = 0
    for match in re.finditer(r"\S+", source):
        while token_index < len(scores) and scores[token_index][1] <= match.start():
            token_index += 1
        values = []
        index = token_index
        while index < len(scores) and scores[index][0] < match.end():
            if scores[index][1] > match.start():
                values.append(scores[index][2])
            index += 1
        if not values:
            raise ValueError("Tokenizer did not cover a source word")
        result.append({"start": offsets[cursor], "end": offsets[match.end()], "score": sum(values) / len(values)})
        cursor = match.end()
    return result


def run(payload: dict) -> dict:
    # This gate precedes importing torch/transformers or loading any model.
    if os.environ.get("ENABLE_LOCAL_MODELS") != "1":
        raise RuntimeError("Local model execution is disabled")
    if payload.get("method") not in {"semantic", "llmlingua2"}:
        raise ValueError("Unsupported model method")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    from transformers import AutoModel, AutoModelForTokenClassification, AutoTokenizer

    torch.set_num_threads(2)
    method = payload["method"]
    model_name = "BAAI/bge-small-en-v1.5" if method == "semantic" else "microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank"
    kwargs = {"local_files_only": True, "trust_remote_code": False}
    tokenizer = AutoTokenizer.from_pretrained(model_name, use_fast=True, **kwargs)
    loader = AutoModel if method == "semantic" else AutoModelForTokenClassification
    model = loader.from_pretrained(model_name, use_safetensors=True, **kwargs).to("cpu").eval()
    identity = model_name + "@" + str(getattr(model.config, "_commit_hash", "cached"))
    if method == "semantic":
        texts = ["Represent this sentence for searching relevant passages: " + payload["query"], *payload["units"]]
        vectors = []
        truncated = sum(len(tokenizer(text, add_special_tokens=True)["input_ids"]) > 512 for text in texts)
        with torch.inference_mode():
            for start in range(0, len(texts), 8):
                inputs = tokenizer(texts[start:start + 8], padding=True, truncation=True, max_length=512, return_tensors="pt")
                hidden = model(**inputs).last_hidden_state[:, 0]
                vectors.append(torch.nn.functional.normalize(hidden, p=2, dim=1))
        embeddings = torch.cat(vectors)
        return {"model": identity, "scores": (embeddings[1:] @ embeddings[0]).tolist(),
                "warning": f"{truncated} query/unit inputs were truncated to the 512-token embedding window." if truncated else ""}

    if method != "llmlingua2":
        raise ValueError("Unsupported model method")
    source = payload["source"]
    # Non-overlapping encoder windows cover the entire input, rather than silently
    # truncating long sources. Context across window boundaries is still lost.
    encoded = tokenizer(source, return_offsets_mapping=True, return_overflowing_tokens=True,
                        truncation=True, max_length=512, stride=0)
    token_scores = []
    with torch.inference_mode():
        for index, ids in enumerate(encoded["input_ids"]):
            inputs = {key: torch.tensor([encoded[key][index]]) for key in ("input_ids", "attention_mask", "token_type_ids") if key in encoded}
            probabilities = model(**inputs).logits.softmax(dim=-1)[0, :, 1].tolist()
            token_scores.extend((start, end, score) for (start, end), score in zip(encoded["offset_mapping"][index], probabilities) if end > start)
    return {"model": identity, "units": aggregate_words(source, token_scores),
            "warning": f"Scored {len(encoded['input_ids'])} independent encoder windows (up to 512 subword tokens each)."}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        print(json.dumps(run(payload)))
    except Exception:
        # Source, credentials and library tracebacks are intentionally not emitted.
        print("Local inference unavailable; check explicit enablement, dependencies and cached weights.", file=sys.stderr)
        sys.exit(1)
