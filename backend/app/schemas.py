from typing import Dict, List, Literal

from pydantic import BaseModel, Field


class DebateRequest(BaseModel):
    topic: str = Field(..., min_length=1, max_length=500)
    rounds: int = Field(default=3, ge=1, le=10)
    model_name: str = Field(default="gpt-5.4", min_length=1, max_length=100)


class DebateRound(BaseModel):
    round: int
    b_statement: str
    c_statement: str


class JudgeResult(BaseModel):
    winner: Literal["B", "C", "DRAW"]
    scores: Dict[str, Dict[str, float]]
    reason: str


class DebateResponse(BaseModel):
    topic: str
    rounds: int
    model_name: str
    transcript: List[DebateRound]
    judge: JudgeResult


class TTSRequest(BaseModel):
    role: Literal["judge", "affirmative", "negative"]
    text: str = Field(..., min_length=1, max_length=3000)
