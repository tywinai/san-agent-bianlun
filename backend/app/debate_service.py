import json
import re
from typing import AsyncGenerator, Dict, List

from .llm_client import OpenAICompatClient
from .schemas import DebateRound, JudgeResult


class DebateService:
    def __init__(self, client: OpenAICompatClient):
        self.client = client

    @staticmethod
    def _format_history(rounds: List[DebateRound]) -> str:
        if not rounds:
            return "暂无历史。"
        lines: List[str] = []
        for r in rounds:
            lines.append(f"第{r.round}轮")
            lines.append(f"B(正方): {r.b_statement}")
            lines.append(f"C(反方): {r.c_statement}")
        return "\n".join(lines)

    @staticmethod
    def _extract_json(text: str) -> Dict:
        raw = text.strip()
        try:
            return json.loads(raw)
        except Exception:
            pass

        match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
        if not match:
            raise ValueError("Judge output is not valid JSON")
        return json.loads(match.group(0))

    async def run_debate(self, topic: str, rounds: int, model_name: str):
        transcript: List[DebateRound] = []

        async for event in self.run_debate_stream(topic=topic, rounds=rounds, model_name=model_name):
            if event.get("type") == "done":
                done_data = event
                transcript = [DebateRound(**item) for item in done_data["transcript"]]
                judge = JudgeResult(**done_data["judge"])
                return transcript, judge

        raise ValueError("Debate stream ended without final result")

    async def run_debate_stream(self, topic: str, rounds: int, model_name: str) -> AsyncGenerator[Dict, None]:
        transcript: List[DebateRound] = []

        b_system = (
            "你是辩手B（正方），立场固定为支持辩题。"
            "要求：逻辑清晰、观点明确、针对对方观点反驳，每次120到220字。"
        )
        c_system = (
            "你是辩手C（反方），立场固定为反对辩题。"
            "要求：逻辑清晰、观点明确、针对对方观点反驳，每次120到220字。"
        )

        for i in range(1, rounds + 1):
            yield {"type": "round_start", "round": i}
            history = self._format_history(transcript)

            b_user = (
                f"辩题：{topic}\n"
                f"当前第{i}轮，请以正方身份发言。\n"
                f"历史记录：\n{history}\n"
                "请直接输出本轮发言正文。"
            )
            b_text_parts: List[str] = []
            async for chunk in self.client.chat_stream(
                model=model_name,
                messages=[
                    {"role": "system", "content": b_system},
                    {"role": "user", "content": b_user},
                ],
                temperature=0.7,
                max_tokens=350,
            ):
                b_text_parts.append(chunk)
                yield {"type": "chunk", "speaker": "B", "round": i, "delta": chunk}
            b_text = "".join(b_text_parts).strip()
            yield {"type": "turn_end", "speaker": "B", "round": i, "text": b_text}

            c_user = (
                f"辩题：{topic}\n"
                f"当前第{i}轮，对方（B）本轮发言如下：\n{b_text}\n"
                f"历史记录：\n{history}\n"
                "请以反方身份给出本轮回应，并针对B观点反驳。仅输出发言正文。"
            )
            c_text_parts: List[str] = []
            async for chunk in self.client.chat_stream(
                model=model_name,
                messages=[
                    {"role": "system", "content": c_system},
                    {"role": "user", "content": c_user},
                ],
                temperature=0.7,
                max_tokens=350,
            ):
                c_text_parts.append(chunk)
                yield {"type": "chunk", "speaker": "C", "round": i, "delta": chunk}
            c_text = "".join(c_text_parts).strip()
            yield {"type": "turn_end", "speaker": "C", "round": i, "text": c_text}

            transcript.append(DebateRound(round=i, b_statement=b_text, c_statement=c_text))
            yield {
                "type": "round_end",
                "round": i,
                "b_statement": b_text,
                "c_statement": c_text,
            }

            round_summary_prompt = (
                "你是裁判A，请仅基于本轮双方发言给出简短小结。"
                "要求：1) 点出双方最强论点；2) 指出当前略占优的一方或写势均力敌；"
                "3) 80到140字；4) 只输出小结正文。\n\n"
                f"辩题：{topic}\n"
                f"第{i}轮 正方(B)：{b_text}\n"
                f"第{i}轮 反方(C)：{c_text}"
            )

            try:
                round_summary = await self.client.chat(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": "你是中立且简洁的辩论裁判。"},
                        {"role": "user", "content": round_summary_prompt},
                    ],
                    temperature=0.3,
                    max_tokens=220,
                )
            except Exception:
                round_summary = f"第{i}轮小结：双方均围绕核心争点展开攻防，当前暂不判定明显优势方。"

            yield {
                "type": "judge_round",
                "round": i,
                "summary": round_summary.strip(),
            }

        full_record = self._format_history(transcript)
        judge_prompt = (
            "你是裁判A。请根据完整辩论记录，给出胜方、评分和详细理由。\n"
            "评分维度：logic（逻辑性）、evidence（论据充分性）、rebuttal（反驳质量）、clarity（表达清晰度），每项0到10分。\n"
            "仅输出合法JSON，格式如下：\n"
            "{\n"
            '  "winner": "B|C|DRAW",\n'
            '  "scores": {\n'
            '    "B": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0},\n'
            '    "C": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0}\n'
            "  },\n"
            '  "reason": "详细判决理由（中文）"\n'
            "}\n\n"
            f"辩题：{topic}\n"
            f"辩论记录：\n{full_record}"
        )

        judge_raw = await self.client.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": "你是严格的辩论裁判。"},
                {"role": "user", "content": judge_prompt},
            ],
            temperature=0.2,
            max_tokens=1200,
            response_format={"type": "json_object"},
        )

        judge_data = self._extract_json(judge_raw)
        judge = JudgeResult(**judge_data)
        yield {"type": "judge", "judge": judge.model_dump()}
        yield {
            "type": "done",
            "transcript": [item.model_dump() for item in transcript],
            "judge": judge.model_dump(),
        }
