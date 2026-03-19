# Local Three-Agent Debate System

This repo now includes a local deployable stack with three services:

- `llm`: OpenAI-compatible local model service (vLLM)
- `backend`: FastAPI service with `POST /debate`
- `frontend`: React UI for launching and viewing debates

## 1) Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
OPENAI_API_KEY=your-api-key
MODEL_NAME=gpt-5.4
VLLM_MODEL=Qwen/Qwen2.5-7B-Instruct
```

## 2) Start all services

```bash
docker compose up --build
```

## 3) Access

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:8000/health`
- LLM API: `http://127.0.0.1:8317/v1`

## Local one-click dev (no Docker)

Use the one-click script to start backend + frontend locally:

```bash
cp .env.local.example .env.local
# edit OPENAI_API_KEY in .env.local
./start_local_dev.sh --install
```

Then open `http://127.0.0.1:5173`.

You can run it without dependency installation after the first time:

```bash
./start_local_dev.sh
```

## API contract

`POST /debate`

Request:

```json
{
  "topic": "AI 是否会在未来 10 年大规模替代人类工作？",
  "rounds": 3,
  "model_name": "gpt-5.4"
}
```

Response fields:

- `transcript`: per-round statements from B (affirmative) and C (negative)
- `judge`: final result from A (winner, per-dimension scores, and reason)

## cURL example

```bash
curl -X POST http://127.0.0.1:8000/debate \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "AI 是否会在未来 10 年大规模替代人类工作？",
    "rounds": 3,
    "model_name": "gpt-5.4"
  }'
```

## Swap model backend (vLLM / Ollama)

The backend uses OpenAI-style `/v1/chat/completions` only. To switch model providers,
change `OPENAI_BASE_URL` and `OPENAI_API_KEY` for the backend service.
