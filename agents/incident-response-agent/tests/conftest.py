import os

# LiteLLM loads .env into os.environ in its default DEV mode, which would leak the local
# .env into isolated test settings. Must be set before anything imports litellm.
os.environ["LITELLM_MODE"] = "PRODUCTION"
