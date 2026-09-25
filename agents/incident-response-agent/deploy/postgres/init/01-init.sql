-- Runs once, on first start of an empty Postgres data volume (compose only).
-- pgvector for the semantic cache / long-term memory tables.
CREATE EXTENSION IF NOT EXISTS vector;

-- Separate database for LiteLLM spend tracking / budgets (DATABASE_URL on the proxy).
SELECT 'CREATE DATABASE litellm'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\gexec
