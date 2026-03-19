import base64
import json
import tempfile
from pathlib import Path
from typing import Dict, List

import edge_tts

from .schemas import TTSAnnotatedResponse, TTSMark


class TTSService:
    def __init__(self):
        self.voice_map_zh: Dict[str, str] = {
            "judge": "zh-CN-YunyangNeural",
            "affirmative": "zh-CN-XiaoxiaoNeural",
            "negative": "zh-CN-YunxiNeural",
        }
        self.voice_map_en: Dict[str, str] = {
            "judge": "en-US-GuyNeural",
            "affirmative": "en-US-JennyNeural",
            "negative": "en-US-EricNeural",
        }

    @staticmethod
    def _detect_text_language(text: str) -> str:
        raw = text or ""
        cjk = sum(1 for ch in raw if "\u4e00" <= ch <= "\u9fff")
        latin = sum(1 for ch in raw if "a" <= ch.lower() <= "z")
        if latin > cjk:
            return "en"
        return "zh"

    def _resolve_voice(self, role: str, text: str) -> str:
        role_key = role.strip().lower()
        lang = self._detect_text_language(text)
        if lang == "en":
            return self.voice_map_en.get(role_key, self.voice_map_en["judge"])
        return self.voice_map_zh.get(role_key, self.voice_map_zh["judge"])

    async def synthesize_mp3(self, role: str, text: str) -> bytes:
        safe_text = text.strip()
        if not safe_text:
            raise ValueError("TTS text is empty")

        voice = self._resolve_voice(role, safe_text)

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            communicate = edge_tts.Communicate(safe_text, voice=voice)
            await communicate.save(str(tmp_path))
            return tmp_path.read_bytes()
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)

    async def synthesize_with_marks(self, role: str, text: str) -> TTSAnnotatedResponse:
        safe_text = text.strip()
        if not safe_text:
            raise ValueError("TTS text is empty")

        voice = self._resolve_voice(role, safe_text)

        communicate = edge_tts.Communicate(safe_text, voice=voice)
        audio_bytes = bytearray()
        marks: List[TTSMark] = []
        text_offset = 0

        async for chunk in communicate.stream():
            chunk_type = chunk.get("type")
            if chunk_type == "audio":
                data = chunk.get("data")
                if data:
                    audio_bytes.extend(data)
            elif chunk_type == "WordBoundary":
                boundary_text = chunk.get("text", "")
                offset = int(chunk.get("text_offset", text_offset) or text_offset)
                marks.append(
                    TTSMark(
                        time=float(chunk.get("offset", 0)) / 10_000_000,
                        text_offset=offset,
                        text=boundary_text,
                    )
                )
                text_offset = offset + len(boundary_text)
            elif chunk_type == "sentenceBoundary":
                meta = chunk.get("data")
                if isinstance(meta, str):
                    try:
                        parsed = json.loads(meta)
                    except Exception:
                        parsed = None
                    if isinstance(parsed, dict):
                        boundary_text = str(parsed.get("text", ""))
                        offset = int(parsed.get("textOffset", text_offset) or text_offset)
                        marks.append(
                            TTSMark(
                                time=float(parsed.get("audioOffset", 0)) / 10_000_000,
                                text_offset=offset,
                                text=boundary_text,
                            )
                        )
                        text_offset = offset + len(boundary_text)

        if not audio_bytes:
            raise ValueError("TTS returned empty audio")

        return TTSAnnotatedResponse(
            audio_base64=base64.b64encode(bytes(audio_bytes)).decode("utf-8"),
            mime_type="audio/mpeg",
            marks=marks,
        )
