# san-agent-bianlun

`san-agent-bianlun` 是一个本地可部署的三智能体辩论系统。

本工程**参考并基于** [Skytliang/Multi-Agents-Debate](https://github.com/Skytliang/Multi-Agents-Debate) 的思想与代码进行工程化改造，重点从“研究脚本”升级为“可本地部署、可前后端联调、可流式交互”的完整应用。

## 项目定位

- 目标：把多智能体辩论能力封装成可调用服务与可视化界面
- 形态：`FastAPI backend + React frontend + OpenAI-compatible LLM`
- 场景：本地开发验证、演示、扩展实验与后续产品化

## 相比原工程的改进

相对原始 MAD 工程，这个版本新增/强化了以下能力：

1. **后端服务化**
   - 提供 `POST /debate`（一次性结果）
   - 提供 `POST /debate/stream`（NDJSON 流式事件）

2. **本地 LLM 统一接入层**
   - 通过 OpenAI 风格 `/v1/chat/completions` 访问模型
   - 封装模型客户端，便于切换 vLLM / Ollama / 其他兼容服务

3. **前端实时辩论界面**
   - 三栏结构：反方 / 裁判 / 正方
   - 轮次流式展示双方发言
   - 裁判每轮小结 + 最终判决可视化

4. **本地开发一键启动**
   - `start_local_dev.sh` 同时拉起前后端
   - 自动处理常见端口占用问题

5. **容器化部署能力**
   - 提供 `docker-compose.yml`
   - 支持 `frontend + backend + llm` 三服务编排

## 架构概览

```text
Browser (React)
   │
   ├─ POST /api/debate/stream  (NDJSON)
   ▼
FastAPI (backend)
   │
   ├─ Agent B (正方)
   ├─ Agent C (反方)
   └─ Agent A (裁判)
   │
   ▼
OpenAI-compatible LLM API (/v1/chat/completions)
```

## 目录结构

```text
.
├── backend/                 # FastAPI 服务
│   ├── app/
│   │   ├── main.py          # 路由与应用入口
│   │   ├── debate_service.py# 三智能体辩论编排
│   │   ├── llm_client.py    # OpenAI-compatible 客户端
│   │   └── schemas.py       # Pydantic 数据结构
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                # React + Vite 前端
│   ├── src/
│   │   ├── App.tsx
│   │   ├── api.ts
│   │   ├── types.ts
│   │   └── styles.css
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml       # 三服务编排
├── start_local_dev.sh       # 本地一键启动脚本
├── .env.local.example       # 本地开发环境模板
└── LOCAL_DEPLOYMENT.md      # 补充部署说明
```

## 环境要求

- Python 3.10+
- Node.js 18+
- npm
- 可用的 OpenAI-compatible 模型服务（例如 vLLM）

## 本地开发（推荐）

### 1) 配置环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`：

```env
OPENAI_BASE_URL=http://127.0.0.1:8317/v1
OPENAI_API_KEY=your-api-key
DEFAULT_MODEL_NAME=gpt-5.4
```

### 2) 一键启动

首次（安装依赖）：

```bash
./start_local_dev.sh --install
```

后续：

```bash
./start_local_dev.sh
```

启动后访问：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:8000`

## Docker Compose 部署

如需三服务一键编排：

```bash
cp .env.example .env
docker compose up --build
```

## API 说明

### `POST /debate`

同步返回完整辩论结果。

请求体：

```json
{
  "topic": "AI 是否会在未来 10 年大规模替代人类工作？",
  "rounds": 3,
  "model_name": "gpt-5.4"
}
```

### `POST /debate/stream`

流式返回 NDJSON 事件，事件类型包括：

- `round_start`
- `chunk`（逐段文本）
- `turn_end`
- `round_end`
- `judge_round`
- `judge`
- `done`
- `error`

## 开发说明

- 前端通过 Vite 代理 `/api -> http://127.0.0.1:8000`
- 后端统一通过 `OPENAI_BASE_URL` 指向模型服务
- 当前默认角色映射：
  - B = 正方
  - C = 反方
  - A = 裁判

## 致谢

- 原始研究与开源基础：
  - [Skytliang/Multi-Agents-Debate](https://github.com/Skytliang/Multi-Agents-Debate)

本项目在其多智能体辩论框架思想上进行了工程化改造与产品化实现。
