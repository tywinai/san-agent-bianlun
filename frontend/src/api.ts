import axios from "axios";

import type { DebateRequest, DebateResponse, DebateStreamEvent, TTSRole } from "./types";

const http = axios.create({
  baseURL: "/api",
  timeout: 240000
});

export async function startDebate(payload: DebateRequest): Promise<DebateResponse> {
  const { data } = await http.post<DebateResponse>("/debate", payload);
  return data;
}

function parseNdjsonChunk(buffer: string): { events: DebateStreamEvent[]; remainder: string } {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const events: DebateStreamEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as DebateStreamEvent);
    } catch {
      continue;
    }
  }

  return { events, remainder };
}

export async function startDebateStream(
  payload: DebateRequest,
  onEvent: (event: DebateStreamEvent) => void
): Promise<void> {
  const response = await fetch("/api/debate/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("浏览器不支持流式读取响应体");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const { events, remainder } = parseNdjsonChunk(buffer);
    buffer = remainder;
    for (const event of events) {
      onEvent(event);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      onEvent(JSON.parse(tail) as DebateStreamEvent);
    } catch {
      return;
    }
  }
}

export async function fetchTtsAudio(role: TTSRole, text: string): Promise<Blob> {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ role, text })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `TTS HTTP ${response.status}`);
  }

  return response.blob();
}
