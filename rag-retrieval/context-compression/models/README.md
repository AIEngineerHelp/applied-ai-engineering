# Optional local adapters — disabled until authorized

The laptop owner has instructed agents **not to run local models until explicitly authorized**. Keep `ENABLE_LOCAL_MODELS` unset or `0`. Routine checks must not install the model environment, load checkpoints, download weights or execute inference. Do not treat this document as permission to enable anything.

The adapters are implemented and tested with mocked scores and pure helper tests. **Actual model loading and inference have not been verified on this laptop.** `uv.lock` resolves dependencies only; they have not been installed for this example.

## Implemented paths

- **Semantic unit scoring:** `BAAI/bge-small-en-v1.5`, an MIT-licensed embedding model. Apply the model card's query instruction, CLS pooling and L2 normalization; cosine similarity ranks each independently encoded unit against the question plus optional focus. Our source-span packer preserves headings and enforces the cl100k_base budget. Embedding inputs longer than 512 model tokens are truncated, and the response reports how many were affected.
- **LLMLingua-2 checkpoint inference:** `microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank` (Apache-2.0 checkpoint). Run `AutoModelForTokenClassification`, take class-1 softmax probabilities, average subword probabilities per whitespace word and send original UTF-16 offsets to our packer. Entire source coverage uses independent, non-overlapping encoder windows of up to 512 subword tokens. Words spanning a boundary pool the available scores from both windows. Cross-window context is lost.

The second path uses a published checkpoint and our own inference/packing implementation. It is **not the complete LLMLingua library pipeline**, its training/data-distillation procedure, LLMLingua's causal-LM perplexity pruning, LongLLMLingua, or Latte. It is task-agnostic; the question and focus never enter the classifier. A probability of preservation is not a probability of answer correctness.

Both paths use CPU, two Torch threads, safetensors, `trust_remote_code=False`, `local_files_only=True`, and offline Hugging Face/Transformers settings. The app does not fetch weights. Each requested run starts a short-lived subprocess and includes cold model loading in the reported duration. Requests time out after 90 seconds, source is limited to 12,000 characters, and semantic input is limited to 256 units.

## Future setup, only after explicit authorization

Requires Python 3.12 or 3.13, uv, enough disk/RAM for Torch and model weights, and already-provisioned Hugging Face cache files. This step installs dependencies; it does not install model weights:

```bash
cd rag-retrieval/context-compression/models
uv sync --locked
```

The worker uses fixed model IDs and requires each model's config, tokenizer and safetensors files in the local Hugging Face cache. Provisioning those files is separate work that must also be authorized. The LLMLingua-2 model repository lists approximately 709 MB for its safetensors file; RAM usage exceeds its file size. No model weights belong in Git.

After authorization and preparation, the owner may set `ENABLE_LOCAL_MODELS=1` when starting the app. `COMPRESSION_PYTHON` can point to an explicitly selected environment; otherwise the server uses `models/.venv/bin/python`. This is a server-side gate, with no UI switch to enable inference. Selecting a method never executes it; each run also requires pressing **Run compression**. Changing a question or budget invalidates the current result instead of silently running again.

## Checks that do not execute models

From the example directory:

```bash
python3 -m unittest discover -s models -p 'test_*.py'
npm test
```

The Python suite imports only the worker's standard-library helpers and verifies that the disabled gate precedes model-library imports. TypeScript tests inject mock scores; they never spawn the worker.

Sources reviewed 2026-10-29:

- [BGE model card and Transformers pooling recipe](https://huggingface.co/BAAI/bge-small-en-v1.5)
- [LLMLingua-2 checkpoint and license](https://huggingface.co/microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank)
- [LLMLingua-2 paper](https://arxiv.org/abs/2403.12968)
- [Reference implementation: class-1 probabilities and word pooling](https://github.com/microsoft/LLMLingua/blob/main/llmlingua/prompt_compressor.py)
