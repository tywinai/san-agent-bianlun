import tempfile
from pathlib import Path
from typing import Dict

import edge_tts


class TTSService:
    def __init__(self):
        self.voice_map: Dict[str, str] = {
            "judge": "zh-CN-YunyangNeural",
            "affirmative": "zh-CN-XiaoxiaoNeural",
            "negative": "zh-CN-YunxiNeural",
        }

    async def synthesize_mp3(self, role: str, text: str) -> bytes:
        role_key = role.strip().lower()
        voice = self.voice_map.get(role_key, self.voice_map["judge"])

        safe_text = text.strip()
        if not safe_text:
            raise ValueError("TTS text is empty")

        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            communicate = edge_tts.Communicate(safe_text, voice=voice)
            await communicate.save(str(tmp_path))
            return tmp_path.read_bytes()
        finally:
            if tmp_path.exists():
                tmp_path.unlink(missing_ok=True)
