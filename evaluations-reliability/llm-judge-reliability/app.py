"""Vercel entry point: the read-only report and dataset explorer, built from the committed verdicts."""

from judgelab.web import create_app

app = create_app()
