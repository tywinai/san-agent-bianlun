import json
import random
import re
from typing import AsyncGenerator, Dict, List

from .llm_client import OpenAICompatClient
from .schemas import DebateRound, JudgeResult


TEACHING_TOPIC = "What are the pros and cons of using robots in elderly care?"
TEACHING_PROS = [
    "Robots can monitor health 24/7.",
    "They are good at doing repetitive tasks.",
    "They provide safety and convenience.",
    "They enable old people to get better care.",
    "They help old people to live safely.",
]
TEACHING_CONS = [
    "Robots cannot show real empathy.",
    "They lack human warmth.",
    "They fail to understand feelings.",
    "It's difficult for old people to learn to use robots.",
    "Robots have trouble understanding old people's feelings.",
]


class DebateService:
    def __init__(self, client: OpenAICompatClient):
        self.client = client

    @staticmethod
    def _format_history(rounds: List[DebateRound], lang: str) -> str:
        if not rounds:
            return "No history yet." if lang == "en" else "暂无历史。"
        lines: List[str] = []
        for r in rounds:
            if lang == "en":
                lines.append(f"Round {r.round}")
                lines.append(f"B (Affirmative): {r.b_statement}")
                lines.append(f"C (Negative): {r.c_statement}")
            else:
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

    @staticmethod
    def _detect_topic_language(topic: str) -> str:
        text = topic or ""
        cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
        latin = sum(1 for ch in text if ("a" <= ch.lower() <= "z"))
        if cjk > latin:
            return "zh"
        if latin > 0:
            return "en"
        return "auto"

    @staticmethod
    def _normalize_text_for_match(text: str) -> str:
        lowered = (text or "").strip().lower()
        lowered = re.sub(r"[^a-z0-9\s]", "", lowered)
        lowered = re.sub(r"\s+", " ", lowered)
        return lowered

    @classmethod
    def _is_teaching_topic(cls, topic: str) -> bool:
        normalized = cls._normalize_text_for_match(topic)
        target = cls._normalize_text_for_match(TEACHING_TOPIC)
        if normalized == target:
            return True
        return "robots" in normalized and "elderly" in normalized and "care" in normalized

    @staticmethod
    def _dedupe_sentences(text: str) -> str:
        parts = re.split(r"(?<=[.!?])\s+", (text or "").strip())
        seen = set()
        kept: List[str] = []
        for part in parts:
            s = part.strip()
            if not s:
                continue
            key = re.sub(r"\s+", " ", s.lower())
            if key in seen:
                continue
            seen.add(key)
            kept.append(s)
        return " ".join(kept).strip()

    @staticmethod
    def _build_teaching_core_plan(core_bank: List[str], total_rounds: int) -> Dict[int, List[str]]:
        """
        Build a randomized round->core-sentences assignment plan.
        - If rounds >= core count, try to cover all core sentences.
        - Otherwise, cover as many as possible but at least 3.
        - Distribute one core sentence per selected round to avoid stacking all in round 1.
        """
        plan: Dict[int, List[str]] = {i: [] for i in range(1, total_rounds + 1)}
        if not core_bank:
            return plan

        usage_target = min(len(core_bank), max(3, min(total_rounds, len(core_bank))))
        selected = core_bank[:]
        random.shuffle(selected)
        selected = selected[:usage_target]

        rounds = list(range(1, total_rounds + 1))
        random.shuffle(rounds)
        chosen_rounds = sorted(rounds[:usage_target])

        for sentence, round_no in zip(selected, chosen_rounds):
            plan[round_no].append(sentence)

        return plan

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
        if self._is_teaching_topic(topic):
            async for event in self._run_teaching_stream(model_name=model_name, rounds=rounds):
                yield event
            return

        transcript: List[DebateRound] = []
        lang = self._detect_topic_language(topic)

        if lang == "zh":
            b_system = (
                "你是辩手B（正方），立场固定为支持辩题。"
                "你必须使用与辩题相同的语言输出（本题为中文）。"
                "要求：逻辑清晰、观点明确、针对对方观点反驳，每次120到220字。"
            )
            c_system = (
                "你是辩手C（反方），立场固定为反对辩题。"
                "你必须使用与辩题相同的语言输出（本题为中文）。"
                "要求：逻辑清晰、观点明确、针对对方观点反驳，每次120到220字。"
            )
            judge_system = "你是严格的辩论裁判。你必须使用中文。"
        elif lang == "en":
            b_system = (
                "You are Debater B (affirmative), and you must support the motion. "
                "Important: output in English only, no Chinese. "
                "Be clear, logical, and directly rebut the opponent. Keep each turn concise."
            )
            c_system = (
                "You are Debater C (negative), and you must oppose the motion. "
                "Important: output in English only, no Chinese. "
                "Be clear, logical, and directly rebut the opponent. Keep each turn concise."
            )
            judge_system = "You are a strict debate judge. You must output in English."
        else:
            b_system = (
                "You are Debater B (affirmative), and you must support the motion. "
                "Always answer in exactly the same language used by the topic."
            )
            c_system = (
                "You are Debater C (negative), and you must oppose the motion. "
                "Always answer in exactly the same language used by the topic."
            )
            judge_system = "You are a strict debate judge. Output in the same language as the topic."

        for i in range(1, rounds + 1):
            yield {"type": "round_start", "round": i}
            history = self._format_history(transcript, lang)

            if lang == "en":
                b_user = (
                    f"Topic: {topic}\n"
                    f"Round {i}. Speak as the affirmative side.\n"
                    f"Debate history:\n{history}\n"
                    "Output only your turn content in English."
                )
            else:
                b_user = (
                    f"辩题：{topic}\n"
                    f"当前第{i}轮，请以正方身份发言。\n"
                    f"历史记录：\n{history}\n"
                    "请直接输出本轮发言正文，并且必须与辩题语言一致。"
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

            if lang == "en":
                c_user = (
                    f"Topic: {topic}\n"
                    f"Round {i}. Opponent (B) said:\n{b_text}\n"
                    f"Debate history:\n{history}\n"
                    "Respond as the negative side and rebut B directly. Output only your turn content in English."
                )
            else:
                c_user = (
                    f"辩题：{topic}\n"
                    f"当前第{i}轮，对方（B）本轮发言如下：\n{b_text}\n"
                    f"历史记录：\n{history}\n"
                    "请以反方身份给出本轮回应，并针对B观点反驳。仅输出发言正文，并且必须与辩题语言一致。"
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

            if lang == "en":
                round_summary_prompt = (
                    "You are Judge A. Based only on this round, provide a short summary. "
                    "Include each side's strongest point and who currently has a slight edge (or tie). "
                    "Output only the summary text in English.\n\n"
                    f"Topic: {topic}\n"
                    f"Round {i} Affirmative (B): {b_text}\n"
                    f"Round {i} Negative (C): {c_text}"
                )
            else:
                round_summary_prompt = (
                    "你是裁判A，请仅基于本轮双方发言给出简短小结。"
                    "要求：1) 点出双方最强论点；2) 指出当前略占优的一方或写势均力敌；"
                    "3) 80到140字；4) 只输出小结正文；5) 必须使用与辩题相同语言。\n\n"
                    f"辩题：{topic}\n"
                    f"第{i}轮 正方(B)：{b_text}\n"
                    f"第{i}轮 反方(C)：{c_text}"
                )

            try:
                round_summary = await self.client.chat(
                    model=model_name,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are a neutral and concise debate judge. Use the topic language."
                            if lang == "en"
                            else "你是中立且简洁的辩论裁判。必须使用与辩题相同语言。",
                        },
                        {"role": "user", "content": round_summary_prompt},
                    ],
                    temperature=0.3,
                    max_tokens=220,
                )
            except Exception:
                round_summary = (
                    f"Round {i} summary: both sides addressed the core issue; no clear edge yet."
                    if lang == "en"
                    else f"第{i}轮小结：双方均围绕核心争点展开攻防，当前暂不判定明显优势方。"
                )

            yield {
                "type": "judge_round",
                "round": i,
                "summary": round_summary.strip(),
            }

        full_record = self._format_history(transcript, lang)
        if lang == "en":
            judge_prompt = (
                "You are Judge A. Based on the full debate, provide winner, scores, and detailed reason.\n"
                "Dimensions: logic, evidence, rebuttal, clarity (0-10 each).\n"
                "Output valid JSON only, in this format:\n"
                "{\n"
                '  "winner": "B|C|DRAW",\n'
                '  "scores": {\n'
                '    "B": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0},\n'
                '    "C": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0}\n'
                "  },\n"
                '  "reason": "Detailed judgment reason in English"\n'
                "}\n\n"
                f"Topic: {topic}\n"
                f"Debate Record:\n{full_record}"
            )
        else:
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
                '  "reason": "详细判决理由（与辩题同语言）"\n'
                "}\n\n"
                f"辩题：{topic}\n"
                f"辩论记录：\n{full_record}"
            )

        judge_raw = await self.client.chat(
                model=model_name,
                messages=[
                {"role": "system", "content": judge_system},
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

    async def _run_teaching_stream(self, model_name: str, rounds: int) -> AsyncGenerator[Dict, None]:
        transcript: List[DebateRound] = []
        used_pros: List[str] = []
        used_cons: List[str] = []

        b_system = (
            "You are Debater B (affirmative). Support the motion in English only. "
            "Use the provided core pro sentences as guidance when organizing your argument. "
            "Do not copy all lines mechanically; integrate them naturally into debate language."
        )
        c_system = (
            "You are Debater C (negative). Oppose the motion in English only. "
            "Use the provided core con sentences as guidance when organizing your argument. "
            "Do not copy all lines mechanically; integrate them naturally into rebuttal language."
        )

        total_rounds = max(3, rounds)
        pro_plan = self._build_teaching_core_plan(TEACHING_PROS, total_rounds)
        con_plan = self._build_teaching_core_plan(TEACHING_CONS, total_rounds)

        for idx in range(1, total_rounds + 1):
            yield {"type": "round_start", "round": idx}

            history = self._format_history(transcript, "en")
            assigned_pros = pro_plan.get(idx, [])
            assigned_cons = con_plan.get(idx, [])

            if assigned_pros:
                pro_requirement = (
                    "In this round, include these exact pro core sentence(s) verbatim:\n"
                    + "\n".join([f"- {x}" for x in assigned_pros])
                )
            else:
                pro_requirement = (
                    "In this round, do not add any new verbatim pro core sentence. "
                    "Focus on natural argument and rebuttal."
                )

            b_user = (
                f"Topic: {TEACHING_TOPIC}\n"
                f"Round: {idx}\n"
                "Core pro sentence bank (reference only):\n"
                + "\n".join([f"- {x}" for x in TEACHING_PROS])
                + "\n"
                + "Already used core pro examples in earlier rounds:\n"
                + ("\n".join([f"- {x}" for x in used_pros]) if used_pros else "- none")
                + "\n"
                f"Debate history:\n{history}\n"
                "Task: Speak as affirmative in 70-120 English words. Use the core sentence bank naturally as evidence examples. "
                "Do not force a specific sentence each round. Avoid repeating the same sentence or claim wording from your previous rounds.\n"
                f"Additional requirement: {pro_requirement}"
            )
            b_parts: List[str] = []
            async for chunk in self.client.chat_stream(
                model=model_name,
                messages=[
                    {"role": "system", "content": b_system},
                    {"role": "user", "content": b_user},
                ],
                temperature=0.6,
                max_tokens=260,
            ):
                b_parts.append(chunk)
                yield {"type": "chunk", "speaker": "B", "round": idx, "delta": chunk}
            b_text = "".join(b_parts).strip()
            b_text = self._dedupe_sentences(b_text)
            for core in TEACHING_PROS:
                if core.lower() in b_text.lower() and core not in used_pros:
                    used_pros.append(core)
            yield {"type": "turn_end", "speaker": "B", "round": idx, "text": b_text}

            if assigned_cons:
                con_requirement = (
                    "In this round, include these exact con core sentence(s) verbatim:\n"
                    + "\n".join([f"- {x}" for x in assigned_cons])
                )
            else:
                con_requirement = (
                    "In this round, do not add any new verbatim con core sentence. "
                    "Focus on natural argument and rebuttal."
                )

            c_user = (
                f"Topic: {TEACHING_TOPIC}\n"
                f"Round: {idx}\n"
                f"Opponent B just said:\n{b_text}\n"
                "Core con sentence bank (reference only):\n"
                + "\n".join([f"- {x}" for x in TEACHING_CONS])
                + "\n"
                + "Already used core con examples in earlier rounds:\n"
                + ("\n".join([f"- {x}" for x in used_cons]) if used_cons else "- none")
                + "\n"
                f"Debate history:\n{history}\n"
                "Task: Speak as negative in 70-120 English words. Rebut B and use the core sentence bank naturally as evidence examples. "
                "Do not force a specific sentence each round. Avoid repeating the same sentence or claim wording from your previous rounds.\n"
                f"Additional requirement: {con_requirement}"
            )
            c_parts: List[str] = []
            async for chunk in self.client.chat_stream(
                model=model_name,
                messages=[
                    {"role": "system", "content": c_system},
                    {"role": "user", "content": c_user},
                ],
                temperature=0.6,
                max_tokens=260,
            ):
                c_parts.append(chunk)
                yield {"type": "chunk", "speaker": "C", "round": idx, "delta": chunk}
            c_text = "".join(c_parts).strip()
            c_text = self._dedupe_sentences(c_text)
            for core in TEACHING_CONS:
                if core.lower() in c_text.lower() and core not in used_cons:
                    used_cons.append(core)
            yield {"type": "turn_end", "speaker": "C", "round": idx, "text": c_text}

            transcript.append(DebateRound(round=idx, b_statement=b_text, c_statement=c_text))
            yield {
                "type": "round_end",
                "round": idx,
                "b_statement": b_text,
                "c_statement": c_text,
            }

            summary_prompt = (
                "You are Judge A. Give a concise English summary of this round. "
                "Mention whether each side used its core teaching points effectively, and who has a slight edge (or tie).\n\n"
                f"Round {idx} B: {b_text}\n"
                f"Round {idx} C: {c_text}"
            )
            summary = await self.client.chat(
                model=model_name,
                messages=[
                    {"role": "system", "content": "You are a strict and concise debate judge. English only."},
                    {"role": "user", "content": summary_prompt},
                ],
                temperature=0.3,
                max_tokens=180,
            )
            yield {"type": "judge_round", "round": idx, "summary": summary}

        full_record = self._format_history(transcript, "en")
        judge_prompt = (
            "You are Judge A. Based on the full debate, output winner, scores, and detailed reason in JSON.\n"
            "Dimensions: logic, evidence, rebuttal, clarity (0-10 each).\n"
            "Output valid JSON only:\n"
            "{\n"
            '  "winner": "B|C|DRAW",\n'
            '  "scores": {\n'
            '    "B": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0},\n'
            '    "C": {"logic": 0, "evidence": 0, "rebuttal": 0, "clarity": 0}\n'
            "  },\n"
            '  "reason": "Detailed reason in English"\n'
            "}\n\n"
            f"Topic: {TEACHING_TOPIC}\n"
            "Teaching objective: evaluate application of core pro/con points in debate language.\n"
            f"Debate Record:\n{full_record}"
        )
        judge_raw = await self.client.chat(
            model=model_name,
            messages=[
                {"role": "system", "content": "You are a strict debate judge. English only."},
                {"role": "user", "content": judge_prompt},
            ],
            temperature=0.2,
            max_tokens=800,
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
