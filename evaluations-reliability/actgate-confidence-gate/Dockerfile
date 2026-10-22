# Sample ActGate Dockerfile (Jev + Gemini friendly)
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY data ./data
COPY scripts ./scripts
COPY requirements.txt pytest.ini ./

ENV PYTHONPATH=/app
ENV LAYA_ENABLED=false
ENV LAYA_PRELOAD=false

EXPOSE 8787
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787", "--workers", "1"]
