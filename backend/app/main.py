import json
from contextlib import asynccontextmanager
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic_settings import BaseSettings

from .debate_service import DebateService
from .llm_client import OpenAICompatClient
from .schemas import DebateRequest, DebateResponse, TTSAnnotatedResponse, TTSRequest
from .tts_service import TTSService


class Settings(BaseSettings):
    openai_base_url: str = "http://127.0.0.1:8317/v1"
    openai_api_key: str = "sk-placeholder"
    default_model_name: str = "gpt-5.4"
    request_timeout: int = 120
    cors_origins: str = "*"


settings = Settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    client = OpenAICompatClient(
        base_url=settings.openai_base_url,
        api_key=settings.openai_api_key,
        timeout=settings.request_timeout,
    )
    app.state.llm_client = client
    app.state.debate_service = DebateService(client)
    app.state.tts_service = TTSService()
    yield
    await client.close()


app = FastAPI(title="Three-Agent Debate System", lifespan=lifespan)

origins: List[str] = ["*"] if settings.cors_origins == "*" else [x.strip() for x in settings.cors_origins.split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/debate", response_model=DebateResponse)
async def debate(req: DebateRequest):
    try:
        model = req.model_name or settings.default_model_name
        transcript, judge = await app.state.debate_service.run_debate(
            topic=req.topic,
            rounds=req.rounds,
            model_name=model,
        )
        return DebateResponse(
            topic=req.topic,
            rounds=req.rounds,
            model_name=model,
            transcript=transcript,
            judge=judge,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Debate failed: {exc}") from exc


@app.post("/debate/stream")
async def debate_stream(req: DebateRequest):
    model = req.model_name or settings.default_model_name

    async def event_generator():
        try:
            async for event in app.state.debate_service.run_debate_stream(
                topic=req.topic,
                rounds=req.rounds,
                model_name=model,
            ):
                yield json.dumps(event, ensure_ascii=False) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "message": f"Debate failed: {exc}"}, ensure_ascii=False) + "\n"

    return StreamingResponse(event_generator(), media_type="application/x-ndjson")


@app.post("/tts")
async def tts(req: TTSRequest):
    try:
        audio = await app.state.tts_service.synthesize_mp3(role=req.role, text=req.text)
        return Response(content=audio, media_type="audio/mpeg")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"TTS failed: {exc}") from exc


@app.post("/tts/annotated", response_model=TTSAnnotatedResponse)
async def tts_annotated(req: TTSRequest):
    try:
        return await app.state.tts_service.synthesize_with_marks(role=req.role, text=req.text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Annotated TTS failed: {exc}") from exc
