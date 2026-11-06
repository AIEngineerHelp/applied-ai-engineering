"""Reference LLMLingua library calls. Imported only after the explicit local gate."""
from __future__ import annotations

import os
import socket
from unittest.mock import patch


def reference_arguments(payload: dict) -> dict:
    method = payload["method"]
    if method not in {"llmlingua", "longllmlingua"}:
        raise ValueError("Unknown reference method")
    keep = 1 - payload["remove"] / 100
    if not 0 < keep <= 1:
        raise ValueError("Reference keep rate must be above zero")
    common = {"rate": keep, "concate_question": False, "use_token_level_filter": True}
    if method == "longllmlingua":
        if not payload["query"].strip():
            raise ValueError("LongLLMLingua requires a question")
        return {**common, "context": payload["units"] or [payload["source"]], "question": payload["query"],
                "condition_in_question": "after_condition", "condition_compare": True,
                "rank_method": "longllmlingua", "reorder_context": "sort",
                "dynamic_context_compression_ratio": 0.3, "context_budget": "+100"}
    return {**common, "context": [payload["source"]], "question": "", "rank_method": "llmlingua"}


def run_reference(payload: dict, factory=None) -> dict:
    if os.environ.get("ENABLE_LOCAL_MODELS") != "1":
        raise RuntimeError("Local models are disabled")
    args = reference_arguments(payload)
    def no_network(*args, **kwargs):
        raise RuntimeError("Reference adapters may use cached assets only; network access is disabled")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    with patch.object(socket.socket, "connect", no_network), patch.object(socket, "create_connection", no_network):
        if factory is None:
            from llmlingua import PromptCompressor
            factory = PromptCompressor
        return _compress(payload, args, factory)


def _compress(payload: dict, args: dict, factory) -> dict:
    compressor = factory(model_name="microsoft/phi-2", device_map="cpu",
                         model_config={"local_files_only": True, "trust_remote_code": False, "use_safetensors": True})
    # Keep this teaching adapter inside the scorer's window; do not silently drop
    # overflow. The full research implementations have different long-input setups.
    token_count = len(compressor.tokenizer("\n\n".join(args["context"]) + args["question"], add_special_tokens=False)["input_ids"])
    if token_count + 256 > compressor.model.config.max_position_embeddings:
        raise ValueError("Source and question exceed the configured causal scorer window; shorten the input")
    result = compressor.compress_prompt(**args)
    return {"text": result["compressed_prompt"], "model": f"{payload['method']}/microsoft/phi-2",
            "warning": "Reference library integrated, not retrained. Question excluded from returned text; headings are not guaranteed preserved. Model/tokenizer versions affect output."}
