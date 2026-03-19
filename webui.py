import argparse
import ast
import copy
import json
import os
import re

import gradio as gr

from interactive import DebatePlayer

ARENA_CSS = """
body, .gradio-container {
  background:
    radial-gradient(1200px 600px at 20% -10%, #e6f0ff 0%, transparent 60%),
    radial-gradient(1200px 600px at 80% -10%, #ffecec 0%, transparent 60%),
    #f4f6fb;
}
.arena-head {
  text-align: center;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 0.4px;
}
.arena-sub {
  text-align: center;
  color: #4c5162;
}
.arena-col {
  border: 1px solid #d7dbe8;
  border-radius: 16px;
  padding: 10px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.06);
}
.arena-col .panel-title {
  text-align: center;
  font-weight: 800;
  margin-bottom: 8px;
}
.affirmative-col {
  border-top: 5px solid #2563eb;
}
.moderator-col {
  border-top: 5px solid #374151;
}
.negative-col {
  border-top: 5px solid #dc2626;
}
.status-board {
  border-radius: 12px;
  border: 1px solid #d7dbe8;
  background: #fff;
  padding: 8px 12px;
}
"""


def get_repo_root() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def load_config() -> dict:
    config_path = os.path.join(get_repo_root(), "code", "utils", "config4all.json")
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _round_name(num: int) -> str:
    dct = {
        1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
        6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
    }
    return dct.get(num, f"{num}th")


def _prepare_prompts(config: dict, topic: str) -> dict:
    c = copy.deepcopy(config)
    c["debate_topic"] = topic
    for k in ["player_meta_prompt", "moderator_meta_prompt", "affirmative_prompt", "judge_prompt_last2"]:
        c[k] = c[k].replace("##debate_topic##", c["debate_topic"])
    return c


def _parse_json_like(raw: str) -> dict:
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)

    for parser in (json.loads, ast.literal_eval):
        try:
            data = parser(text)
            if isinstance(data, dict):
                return data
        except Exception:
            pass

    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        candidate = m.group(0)
        for parser in (json.loads, ast.literal_eval):
            try:
                data = parser(candidate)
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
    return {}


def _normalize_moderator(raw: str) -> dict:
    data = _parse_json_like(raw)
    return {
        "Whether there is a preference": str(data.get("Whether there is a preference", "")).strip(),
        "Supported Side": str(data.get("Supported Side", "")).strip(),
        "Reason": str(data.get("Reason", "")).strip() or (raw or "").strip(),
        "debate_answer": str(data.get("debate_answer", "")).strip(),
    }


def _normalize_judge(raw: str) -> dict:
    data = _parse_json_like(raw)
    return {
        "Reason": str(data.get("Reason", "")).strip() or (raw or "").strip(),
        "debate_answer": str(data.get("debate_answer", "")).strip(),
    }


def _moderator_to_markdown(round_idx: int, decision: dict) -> str:
    lines = [f"**Round {round_idx}**"]
    if decision["Whether there is a preference"]:
        lines.append(f"- Preference: `{decision['Whether there is a preference']}`")
    if decision["Supported Side"]:
        lines.append(f"- Supported Side: `{decision['Supported Side']}`")
    if decision["debate_answer"]:
        lines.append(f"- Final Answer: {decision['debate_answer']}")
    if decision["Reason"]:
        lines.append(f"- Reason: {decision['Reason']}")
    return "\n".join(lines)


def _judge_to_markdown(step_title: str, content: str) -> str:
    return f"**{step_title}**\n\n{content}"


def _chunks(text: str):
    if not text:
        yield ""
        return
    step = max(24, len(text) // 14)
    for i in range(step, len(text) + step, step):
        yield text[:i]


def _summary(topic: str, model: str, result: dict) -> str:
    return "\n".join(
        [
            "### Debate Result",
            f"- 题目: {topic}",
            f"- 模型: `{model}`",
            f"- 成功: `{result.get('success', False)}`",
            "",
            "#### Base Answer",
            result.get("base_answer", ""),
            "",
            "#### Debate Answer",
            result.get("debate_answer", ""),
            "",
            "#### Reason",
            result.get("Reason", ""),
        ]
    )


def run_debate_stream(
    debate_topic: str,
    api_key: str,
    api_base: str,
    model_name: str,
    max_round: int,
    temperature: float,
    max_context: int,
):
    topic = (debate_topic or "").strip()
    key = (api_key or "").strip()
    base = (api_base or "").strip()
    model = (model_name or "").strip()
    max_round = int(max_round)
    temperature = float(temperature)
    max_context = int(max_context)

    aff_chat, mod_chat, neg_chat = [], [], []
    logs = []
    status = "准备开始。"
    summary = ""

    def snapshot():
        return summary, status, copy.deepcopy(aff_chat), copy.deepcopy(mod_chat), copy.deepcopy(neg_chat), "\n\n".join(logs)

    if not topic:
        summary = "请输入辩题。"
        yield snapshot()
        return
    if not key:
        summary = "请输入 API Key。"
        yield snapshot()
        return
    if not model:
        summary = "请输入模型名。"
        yield snapshot()
        return

    status = "初始化辩手..."
    yield snapshot()

    config = _prepare_prompts(load_config(), topic)
    result = {
        "base_answer": "",
        "debate_answer": "",
        "Reason": "",
        "Supported Side": "",
        "success": False,
    }

    try:
        affirmative = DebatePlayer(model, "Affirmative side", temperature, key, 0, base if base else None, max_context)
        negative = DebatePlayer(model, "Negative side", temperature, key, 0, base if base else None, max_context)
        moderator = DebatePlayer(model, "Moderator", temperature, key, 0, base if base else None, max_context)

        affirmative.set_meta_prompt(config["player_meta_prompt"])
        negative.set_meta_prompt(config["player_meta_prompt"])
        moderator.set_meta_prompt(config["moderator_meta_prompt"])

        aff_ans, neg_ans = "", ""
        round_idx = 1

        status = "Round 1：正方发言中..."
        yield snapshot()
        affirmative.add_event(config["affirmative_prompt"])
        aff_ans = affirmative.ask()
        affirmative.add_memory(aff_ans)
        result["base_answer"] = aff_ans
        logs.append(f"[Round 1] Affirmative:\n{aff_ans}")
        aff_chat.append({"role": "assistant", "content": ""})
        full = f"**Round 1**\n\n{aff_ans}"
        for part in _chunks(full):
            aff_chat[-1]["content"] = part
            status = "Round 1：正方完成，反方发言中..."
            yield snapshot()

        status = "Round 1：反方发言中..."
        yield snapshot()
        negative.add_event(config["negative_prompt"].replace("##aff_ans##", aff_ans))
        neg_ans = negative.ask()
        negative.add_memory(neg_ans)
        logs.append(f"[Round 1] Negative:\n{neg_ans}")
        neg_chat.append({"role": "assistant", "content": ""})
        full = f"**Round 1**\n\n{neg_ans}"
        for part in _chunks(full):
            neg_chat[-1]["content"] = part
            status = "Round 1：反方完成，裁判评议中..."
            yield snapshot()

        status = "Round 1：裁判评议中..."
        yield snapshot()
        moderator.add_event(
            config["moderator_prompt"]
            .replace("##aff_ans##", aff_ans)
            .replace("##neg_ans##", neg_ans)
            .replace("##round##", _round_name(round_idx))
        )
        mod_raw = moderator.ask()
        moderator.add_memory(mod_raw)
        decision = _normalize_moderator(mod_raw)
        logs.append(f"[Round 1] Moderator(raw):\n{mod_raw}")
        mod_text = _moderator_to_markdown(round_idx, decision)
        mod_chat.append({"role": "assistant", "content": ""})
        for part in _chunks(mod_text):
            mod_chat[-1]["content"] = part
            status = "Round 1：评议完成。"
            yield snapshot()

        if decision["debate_answer"]:
            result.update(decision)
            result["success"] = True
        else:
            for round_idx in range(2, max_round + 1):
                status = f"Round {round_idx}：正方发言中..."
                yield snapshot()
                affirmative.add_event(config["debate_prompt"].replace("##oppo_ans##", neg_ans))
                aff_ans = affirmative.ask()
                affirmative.add_memory(aff_ans)
                logs.append(f"[Round {round_idx}] Affirmative:\n{aff_ans}")
                aff_chat.append({"role": "assistant", "content": ""})
                full = f"**Round {round_idx}**\n\n{aff_ans}"
                for part in _chunks(full):
                    aff_chat[-1]["content"] = part
                    status = f"Round {round_idx}：正方完成，反方发言中..."
                    yield snapshot()

                status = f"Round {round_idx}：反方发言中..."
                yield snapshot()
                negative.add_event(config["debate_prompt"].replace("##oppo_ans##", aff_ans))
                neg_ans = negative.ask()
                negative.add_memory(neg_ans)
                logs.append(f"[Round {round_idx}] Negative:\n{neg_ans}")
                neg_chat.append({"role": "assistant", "content": ""})
                full = f"**Round {round_idx}**\n\n{neg_ans}"
                for part in _chunks(full):
                    neg_chat[-1]["content"] = part
                    status = f"Round {round_idx}：反方完成，裁判评议中..."
                    yield snapshot()

                status = f"Round {round_idx}：裁判评议中..."
                yield snapshot()
                moderator.add_event(
                    config["moderator_prompt"]
                    .replace("##aff_ans##", aff_ans)
                    .replace("##neg_ans##", neg_ans)
                    .replace("##round##", _round_name(round_idx))
                )
                mod_raw = moderator.ask()
                moderator.add_memory(mod_raw)
                decision = _normalize_moderator(mod_raw)
                logs.append(f"[Round {round_idx}] Moderator(raw):\n{mod_raw}")
                mod_text = _moderator_to_markdown(round_idx, decision)
                mod_chat.append({"role": "assistant", "content": ""})
                for part in _chunks(mod_text):
                    mod_chat[-1]["content"] = part
                    status = f"Round {round_idx}：评议完成。"
                    yield snapshot()

                if decision["debate_answer"]:
                    result.update(decision)
                    result["success"] = True
                    break

        if not result["success"]:
            status = "进入终审裁判阶段..."
            yield snapshot()
            judge = DebatePlayer(model, "Judge", temperature, key, 0, base if base else None, max_context)
            judge.set_meta_prompt(config["moderator_meta_prompt"])

            judge.add_event(config["judge_prompt_last1"].replace("##aff_ans##", aff_ans).replace("##neg_ans##", neg_ans))
            judge_step1 = judge.ask()
            judge.add_memory(judge_step1)
            logs.append(f"[Judge-Step1]\n{judge_step1}")
            mod_chat.append({"role": "assistant", "content": ""})
            for part in _chunks(_judge_to_markdown("Judge Step 1: Candidates", judge_step1)):
                mod_chat[-1]["content"] = part
                status = "终审：提取候选答案..."
                yield snapshot()

            judge.add_event(config["judge_prompt_last2"])
            judge_step2 = judge.ask()
            judge.add_memory(judge_step2)
            logs.append(f"[Judge-Step2 raw]\n{judge_step2}")
            decision = _normalize_judge(judge_step2)
            result.update(decision)
            result["success"] = bool(result.get("debate_answer", ""))
            mod_chat.append({"role": "assistant", "content": ""})
            for part in _chunks(_judge_to_markdown("Judge Step 2: Final Verdict", judge_step2)):
                mod_chat[-1]["content"] = part
                status = "终审：给出最终结论..."
                yield snapshot()

        summary = _summary(topic, model, result)
        status = "辩论完成。"
        yield snapshot()

    except Exception as e:
        summary = f"运行失败: {type(e).__name__}: {e}"
        status = "执行失败。"
        yield snapshot()


def clear_outputs():
    return "", "准备就绪。", [], [], [], ""


def build_ui() -> gr.Blocks:
    with gr.Blocks(title="MAD Debate Arena", css=ARENA_CSS) as demo:
        gr.Markdown("<div class='arena-head'>MAD Debate Arena</div>")
        gr.Markdown("<div class='arena-sub'>左侧正方 · 中间裁判 · 右侧反方（气泡按回合动态追加）</div>")

        with gr.Accordion("配置", open=True):
            debate_topic = gr.Textbox(
                label="Debate Topic",
                placeholder="例如：When Alice walks up and down the hill, what is her average speed?",
                lines=2,
            )
            with gr.Row():
                api_key = gr.Textbox(label="API Key", type="password", value=os.getenv("OPENAI_API_KEY", ""))
                api_base = gr.Textbox(
                    label="API Base (OpenAI-compatible)",
                    value=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
                )
            with gr.Row():
                model_name = gr.Textbox(label="Model", value=os.getenv("MAD_MODEL", "gpt-3.5-turbo"))
                max_context = gr.Number(label="Max Context", value=int(os.getenv("MAD_MAX_CONTEXT", "3900")), precision=0)
            with gr.Row():
                max_round = gr.Slider(label="Max Round", minimum=2, maximum=10, value=3, step=1)
                temperature = gr.Slider(label="Temperature", minimum=0.0, maximum=1.5, value=0.0, step=0.1)

            with gr.Row():
                run_btn = gr.Button("开始辩论", variant="primary")
                clear_btn = gr.Button("清空", variant="secondary")

        status_output = gr.Markdown("准备就绪。", elem_classes=["status-board"])

        with gr.Row():
            with gr.Column(elem_classes=["arena-col", "affirmative-col"]):
                gr.Markdown("<div class='panel-title'>正方 Affirmative</div>")
                affirmative_output = gr.Chatbot(type="messages", show_copy_button=True, height=520, bubble_full_width=False)
            with gr.Column(elem_classes=["arena-col", "moderator-col"]):
                gr.Markdown("<div class='panel-title'>裁判 Moderator / Judge</div>")
                moderator_output = gr.Chatbot(type="messages", show_copy_button=True, height=520, bubble_full_width=False)
            with gr.Column(elem_classes=["arena-col", "negative-col"]):
                gr.Markdown("<div class='panel-title'>反方 Negative</div>")
                negative_output = gr.Chatbot(type="messages", show_copy_button=True, height=520, bubble_full_width=False)

        summary_output = gr.Markdown(label="Summary")
        logs_output = gr.Textbox(label="Raw Logs", lines=12)

        run_btn.click(
            fn=run_debate_stream,
            inputs=[debate_topic, api_key, api_base, model_name, max_round, temperature, max_context],
            outputs=[summary_output, status_output, affirmative_output, moderator_output, negative_output, logs_output],
        )

        clear_btn.click(
            fn=clear_outputs,
            outputs=[summary_output, status_output, affirmative_output, moderator_output, negative_output, logs_output],
        )

    demo.queue()
    return demo


def parse_args():
    parser = argparse.ArgumentParser("MAD Web UI")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind")
    parser.add_argument("--port", type=int, default=7860, help="Port to bind")
    parser.add_argument("--share", action="store_true", help="Enable public share link")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    app = build_ui()
    app.launch(server_name=args.host, server_port=args.port, share=args.share)
