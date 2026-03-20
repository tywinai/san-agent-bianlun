import { useEffect, useMemo, useRef, useState } from "react";

import { fetchAnnotatedTts, fetchTtsAudio, startDebateStream } from "./api";
import judgeAvatarSrc from "./static/裁判.png";
import affirmativeAvatarSrc from "./static/正方.png";
import negativeAvatarSrc from "./static/反方.png";
import type {
  DebateResponse,
  DebateRound,
  DebateStreamEvent,
  JudgeResult,
  TTSRole
} from "./types";
import "./styles.css";

type LiveRound = {
  b: string;
  c: string;
};

type AudioQueueItem = {
  role: TTSRole;
  text: string;
  target?: "debate" | "judge_summary" | "judge_reason";
  preparedBlob?: Blob;
  preparedMarks?: Array<{ time: number; text_offset: number; text: string }>;
  sourceText?: string;
  segmentStart?: number;
  segmentEnd?: number;
  round?: number;
  speaker?: "B" | "C";
  judgeRound?: number;
};

type KaraokeState = {
  active: boolean;
  role?: TTSRole;
  round?: number;
  speaker?: "B" | "C";
  judgeRound?: number;
  sourceText?: string;
  segmentText?: string;
  segmentStart?: number;
  segmentEnd?: number;
  segmentTargetEnd?: number;
};

function ensureRound(source: Record<number, LiveRound>, round: number): Record<number, LiveRound> {
  if (source[round]) {
    return source;
  }
  return {
    ...source,
    [round]: { b: "", c: "" }
  };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

function currentSentenceFromProgress(text: string, index: number): string {
  const source = text || "";
  if (!source.trim()) {
    return "";
  }
  const i = Math.max(0, Math.min(index, source.length));
  const boundary = /[。！？!?;；\n]/;

  let start = 0;
  for (let p = i - 1; p >= 0; p -= 1) {
    if (boundary.test(source[p])) {
      start = p + 1;
      break;
    }
  }

  let end = source.length;
  for (let p = i; p < source.length; p += 1) {
    if (boundary.test(source[p])) {
      end = p + 1;
      break;
    }
  }

  return source.slice(start, end).trim();
}

export default function App() {
  const teachingTopic = "What are the pros and cons of using robots in elderly care?";
  const teachingPros = [
    "Robots can monitor health 24/7.",
    "They are good at doing repetitive tasks.",
    "They provide safety and convenience.",
    "They enable old people to get better care.",
    "They help old people to live safely."
  ];
  const teachingCons = [
    "Robots cannot show real empathy.",
    "They lack human warmth.",
    "They fail to understand feelings.",
    "It's difficult for old people to learn to use robots.",
    "Robots have trouble understanding old people's feelings."
  ];
  const [topic, setTopic] = useState(teachingTopic);
  const [rounds, setRounds] = useState(5);
  const [modelName, setModelName] = useState("gpt-5.4");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DebateResponse | null>(null);
  const [liveRounds, setLiveRounds] = useState<Record<number, LiveRound>>({});
  const [judge, setJudge] = useState<JudgeResult | null>(null);
  const [judgeReasonDisplayed, setJudgeReasonDisplayed] = useState("");
  const [showJudgeModal, setShowJudgeModal] = useState(false);
  const [statusKey, setStatusKey] = useState<"idle" | "thinking" | "speaking" | "done" | "error">("idle");
  const [statusRole, setStatusRole] = useState<"A" | "B" | "C" | null>(null);
  const [statusRound, setStatusRound] = useState<number | null>(null);
  const [statusLang, setStatusLang] = useState<"zh" | "en">("zh");
  const [error, setError] = useState("");
  const [activeSpeaker, setActiveSpeaker] = useState<"B" | "C" | "A" | null>(null);
  const [activeRound, setActiveRound] = useState<number | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState(false);
  const [karaoke, setKaraoke] = useState<KaraokeState>({ active: false });
  const [viewMode, setViewMode] = useState<"expanded" | "focus">("expanded");

  const setUiStatus = (
    key: "idle" | "thinking" | "speaking" | "done" | "error",
    role: "A" | "B" | "C" | null = null,
    round: number | null = null
  ) => {
    setStatusKey(key);
    setStatusRole(role);
    setStatusRound(round);
  };

  const negativeBodyRef = useRef<HTMLDivElement | null>(null);
  const affirmativeBodyRef = useRef<HTMLDivElement | null>(null);
  const audioQueueRef = useRef<AudioQueueItem[]>([]);
  const isSpeakingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const eventQueueRef = useRef<DebateStreamEvent[]>([]);
  const isProcessingEventsRef = useRef(false);

  const roundNumbers = useMemo(() => {
    const fromLive = Object.keys(liveRounds).map(Number);
    const fromResult = result?.transcript.map((r) => r.round) ?? [];
    return Array.from(new Set([...fromLive, ...fromResult])).sort((a, b) => a - b);
  }, [liveRounds, result]);

  const currentRoundLabel = useMemo(() => {
    if (activeRound) {
      return `Round ${activeRound}: Live Debate`;
    }
    if (result?.rounds) {
      return `Round ${result.rounds}: Completed`;
    }
    return "Round 1: Opening Statement";
  }, [activeRound, result]);

  const speakingSpeaker = useMemo<"B" | "C" | "A" | null>(() => {
    if (!karaoke.active || !karaoke.role) {
      return null;
    }
    if (karaoke.role === "affirmative") {
      return "B";
    }
    if (karaoke.role === "negative") {
      return "C";
    }
    return "A";
  }, [karaoke]);

  const thinkingSpeaker = activeSpeaker && !speakingSpeaker ? activeSpeaker : null;

  const topicLang = useMemo<"zh" | "en">(() => {
    return /[\u4e00-\u9fff]/.test(topic) ? "zh" : "en";
  }, [topic]);

  const isTeachingTopic = useMemo(() => {
    const normalize = (v: string) =>
      v
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const t = normalize(topic);
    const target = normalize(teachingTopic);
    return t === target || (t.includes("robots") && t.includes("elderly") && t.includes("care"));
  }, [topic]);

  const affirmativeEdge = useMemo(() => {
    if (!judge) {
      return 50;
    }
    const b = Object.values(judge.scores.B || {}).reduce((acc, value) => acc + Number(value || 0), 0);
    const c = Object.values(judge.scores.C || {}).reduce((acc, value) => acc + Number(value || 0), 0);
    const total = b + c;
    if (total <= 0) {
      return 50;
    }
    return Math.round((b / total) * 100);
  }, [judge]);

  const scoreDimensions = useMemo(() => {
    if (!judge?.scores?.B && !judge?.scores?.C) {
      return [] as string[];
    }
    const keys = new Set<string>();
    Object.keys(judge?.scores?.B || {}).forEach((k) => keys.add(k));
    Object.keys(judge?.scores?.C || {}).forEach((k) => keys.add(k));
    return Array.from(keys);
  }, [judge]);

  const scoreLabelMap: Record<string, string> = {
    logic: "逻辑性",
    evidence: "论据",
    rebuttal: "反驳",
    clarity: "表达"
  };

  const roleLabelMap: Record<"B" | "C" | "DRAW", string> = {
    B: "正方",
    C: "反方",
    DRAW: "平局"
  };

  const sideViewpoints = useMemo(() => {
    if (topicLang === "en") {
      return {
        b: "Viewpoint: robots improve safety and care efficiency.",
        c: "Viewpoint: robots cannot replace empathy and human warmth."
      };
    }
    return {
      b: "观点：机器人可提升照护安全与效率。",
      c: "观点：机器人无法替代同理心与人情温度。"
    };
  }, [topicLang]);

  const dockScoreSummary = useMemo(() => {
    if (!judge || scoreDimensions.length === 0) {
      return [] as Array<{ key: string; label: string; text: string; lead: "正方" | "反方" | "平" }>;
    }

    return scoreDimensions.map((dimension) => {
      const bValue = Number(judge.scores.B?.[dimension] ?? 0);
      const cValue = Number(judge.scores.C?.[dimension] ?? 0);
      const lead: "B" | "C" | "平" = bValue === cValue ? "平" : bValue > cValue ? "B" : "C";
      return {
        key: dimension,
        label: scoreLabelMap[dimension] || dimension,
        text: `正方 ${bValue.toFixed(1)} : ${cValue.toFixed(1)} 反方`,
        lead: lead === "平" ? "平" : lead === "B" ? "正方" : "反方"
      };
    });
  }, [judge, scoreDimensions]);

  const hasDebateStarted = roundNumbers.length > 0 || Boolean(result) || loading;

  const emptyHints = useMemo(() => {
    const idle = statusKey === "idle";
    const connecting = statusKey === "thinking" && !activeSpeaker;
    const running = loading || statusKey === "speaking" || statusKey === "thinking";

    if (idle) {
      return {
        negative: "等待开始：反方将从质疑与反驳角度切入。",
        judge: "等待开始：裁判将按轮次给出小结与最终判决。",
        affirmative: "等待开始：正方将先给出开场立论。"
      };
    }

    if (connecting) {
      return {
        negative: "连接中：正在准备反方角色与上下文。",
        judge: "连接中：裁判评审引擎正在就绪。",
        affirmative: "连接中：正在准备正方角色与上下文。"
      };
    }

    if (running) {
      const roundText = activeRound ? `第 ${activeRound} 轮` : "当前轮次";
      const speakerText =
        activeSpeaker === "B"
          ? "（正方发言中）"
          : activeSpeaker === "C"
            ? "（反方发言中）"
            : "";
      return {
        negative: `${roundText} 双方辩论中...${speakerText}`,
        judge: `${roundText} 双方辩论中，裁判将于本轮结束后给出小结。`,
        affirmative: `${roundText} 双方辩论中...${speakerText}`
      };
    }

    return {
      negative: "暂无反方发言。",
      judge: "暂无裁判内容。",
      affirmative: "暂无正方发言。"
    };
  }, [statusKey, loading, activeSpeaker, statusRound]);

  const statusText = useMemo(() => {
    const roleMap = statusLang === "zh" ? { A: "裁判", B: "正方", C: "反方" } : { A: "Judge", B: "Affirmative", C: "Negative" };
    if (statusLang === "zh") {
      if (statusKey === "idle") {
        return "idle";
      }
      if (statusKey === "error") {
        return "error";
      }
      if (statusKey === "done") {
        return "done";
      }
      if (statusKey === "thinking") {
        return statusRole ? `thinking · ${roleMap[statusRole]}${statusRound ? ` · 第${statusRound}轮` : ""}` : "thinking";
      }
      if (statusKey === "speaking") {
        return statusRole ? `speaking · ${roleMap[statusRole]}${statusRound ? ` · 第${statusRound}轮` : ""}` : "speaking";
      }
    }
    if (statusKey === "idle") {
      return "idle";
    }
    if (statusKey === "error") {
      return "error";
    }
    if (statusKey === "done") {
      return "done";
    }
    if (statusRole) {
      return `${statusKey} · ${roleMap[statusRole]}${statusRound ? ` · Round ${statusRound}` : ""}`;
    }
    return statusKey;
  }, [statusKey, statusRole, statusRound, statusLang]);

  const getRoundText = (roundNo: number, speaker: "B" | "C"): string => {
    if (result) {
      const found: DebateRound | undefined = result.transcript.find((r) => r.round === roundNo);
      if (found) {
        return speaker === "B" ? found.b_statement : found.c_statement;
      }
    }
    const live = liveRounds[roundNo];
    if (!live) {
      return "";
    }
    return speaker === "B" ? live.b : live.c;
  };

  const updateSpokenText = (item: AudioQueueItem, absIndex: number) => {
    const source = item.sourceText || item.text;
    const cut = Math.max(0, Math.min(absIndex, source.length));
    const spoken = source.slice(0, cut);

    if (item.target === "debate" && item.speaker && item.round) {
      setLiveRounds((prev) => {
        const next = ensureRound(prev, item.round as number);
        const row = next[item.round as number];
        if (item.speaker === "B") {
          return { ...next, [item.round as number]: { ...row, b: spoken } };
        }
        return { ...next, [item.round as number]: { ...row, c: spoken } };
      });
      return;
    }

    if (item.target === "judge_reason") {
      setJudgeReasonDisplayed(spoken);
    }
  };

  const getRoundFallbackText = (roundNo: number, speaker: "B" | "C"): string => {
    const isCurrentRound = activeRound === roundNo;
    if (loading || isCurrentRound) {
      const speakerText =
        activeSpeaker === "B"
          ? "（正方发言中）"
          : activeSpeaker === "C"
            ? "（反方发言中）"
            : "";
      if (speaker === "B") {
        return `第 ${roundNo} 轮 双方辩论中...${speakerText}`;
      }
      return `第 ${roundNo} 轮 双方辩论中...${speakerText}`;
    }
    return "...";
  };

  const getFocusSubtitle = (speaker: "B" | "C") => {
    if (
      speakingSpeaker === speaker &&
      karaoke.active &&
      karaoke.sourceText &&
      karaoke.segmentEnd !== undefined
    ) {
      const current = currentSentenceFromProgress(karaoke.sourceText, karaoke.segmentEnd).trim();
      if (current) {
        return current;
      }
    }

    if (thinkingSpeaker === speaker) {
      return speaker === "B" ? "正方正在组织观点..." : "反方正在组织反驳...";
    }

    const latestRound = activeRound ?? roundNumbers[roundNumbers.length - 1];
    if (!latestRound) {
      return speaker === "B" ? "等待正方发言" : "等待反方发言";
    }

    const full = getRoundText(latestRound, speaker);
    if (!full) {
      return speaker === "B" ? "正方待发言" : "反方待发言";
    }
    return full.split(/(?<=[.!?。！？])\s+/)[0].trim();
  };

  const renderKaraokeText = (text: string, speakerHint?: "B" | "C"): JSX.Element => {
    const renderMarkdownBold = (raw: string, keyPrefix: string): Array<string | JSX.Element> => {
      const out: Array<string | JSX.Element> = [];
      const regex = /\*\*(.+?)\*\*/g;
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(raw)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > last) {
          out.push(raw.slice(last, start));
        }
        out.push(
          <strong className="mdBold" key={`${keyPrefix}-bold-${start}-${end}`}>
            {match[1]}
          </strong>
        );
        last = end;
      }
      if (last < raw.length) {
        out.push(raw.slice(last));
      }
      return out.length > 0 ? out : [raw];
    };

    const highlightChunk = (chunk: string, speaker: "B" | "C", keyPrefix: string) => {
      if (!isTeachingTopic || !chunk.trim()) {
        return renderMarkdownBold(chunk, keyPrefix);
      }
      const refs = (speaker === "B" ? teachingPros : teachingCons).map((s) => s.trim()).filter(Boolean);
      const escaped = refs.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (escaped.length === 0) {
        return renderMarkdownBold(chunk, keyPrefix);
      }
      const regex = new RegExp(escaped.join("|"), "gi");
      const out: Array<string | JSX.Element> = [];
      let last = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(chunk)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start > last) {
          out.push(...renderMarkdownBold(chunk.slice(last, start), `${keyPrefix}-plain-${last}`));
        }
        out.push(
          <mark className="coreHighlight" key={`${keyPrefix}-core-${speaker}-${start}-${end}`}>
            {renderMarkdownBold(chunk.slice(start, end), `${keyPrefix}-core-text-${start}`)}
          </mark>
        );
        last = end;
      }
      if (last < chunk.length) {
        out.push(...renderMarkdownBold(chunk.slice(last), `${keyPrefix}-tail-${last}`));
      }
      return out.length > 0 ? out : renderMarkdownBold(chunk, `${keyPrefix}-fallback`);
    };

    const speaker: "B" | "C" = speakerHint || (karaoke.speaker === "C" ? "C" : "B");

    if (
      !karaoke.active ||
      !karaoke.sourceText ||
      karaoke.sourceText !== text ||
      karaoke.segmentStart === undefined ||
      karaoke.segmentEnd === undefined
    ) {
      return <>{highlightChunk(text, speaker, "full")}</>;
    }
    const start = Math.max(0, Math.min(karaoke.segmentStart, text.length));
    const cut = Math.max(start, Math.min(karaoke.segmentEnd, text.length));
    const before = text.slice(0, start);
    const spoken = text.slice(start, cut);
    const pending = text.slice(cut);
    return (
      <>
        <span className="karaokeBefore">{highlightChunk(before, speaker, "before")}</span>
        <span className="karaokeSpoken">{highlightChunk(spoken, speaker, "spoken")}</span>
        <span className="karaokePending">{highlightChunk(pending, speaker, "pending")}</span>
      </>
    );
  };

  const stopAudioPlayback = () => {
    audioQueueRef.current = [];
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }
    isSpeakingRef.current = false;
    setKaraoke({ active: false });
  };

  const playQueue = async () => {
    if (!ttsEnabled || isSpeakingRef.current) {
      return;
    }

    isSpeakingRef.current = true;
    try {
      while (audioQueueRef.current.length > 0 && ttsEnabled) {
        const item = audioQueueRef.current.shift();
        if (!item) {
          continue;
        }

        try {
              let blob: Blob | undefined = item.preparedBlob;
              let marks: Array<{ time: number; text_offset: number; text: string }> =
                item.preparedMarks || [];
              if (!blob) {
                try {
                  const tts = await fetchAnnotatedTts(item.role, item.text.slice(0, 3000));
                  blob = base64ToBlob(tts.audio_base64, tts.mime_type || "audio/mpeg");
                  marks = (tts.marks || []).slice().sort((a, b) => a.time - b.time);
                } catch {
                  blob = await fetchTtsAudio(item.role, item.text.slice(0, 3000));
                  marks = [];
                }
              }
              const url = URL.createObjectURL(blob);
              const playState = await new Promise<"ok" | "blocked">((resolve) => {
                const audio = new Audio(url);
                currentAudioRef.current = audio;
                let timer: number | null = null;
                let markIndex = 0;

                const startKaraoke = () => {
                  const roleCode: "A" | "B" | "C" | null = item.speaker
                    ? item.speaker
                    : item.role === "judge"
                      ? "A"
                      : null;
                  const roundCode = item.round ?? item.judgeRound ?? activeRound;
                  setUiStatus("speaking", roleCode, roundCode ?? null);
                  setKaraoke({
                    active: true,
                    role: item.role,
                    round: item.round,
                    speaker: item.speaker,
                    judgeRound: item.judgeRound,
                    sourceText: item.sourceText || item.text,
                    segmentText: item.text,
                    segmentStart: item.segmentStart ?? 0,
                    segmentEnd: item.segmentStart ?? 0,
                    segmentTargetEnd: item.segmentEnd ?? (item.sourceText || item.text).length
                  });

                  timer = window.setInterval(() => {
                    const now = audio.currentTime;
                    while (markIndex < marks.length && marks[markIndex].time <= now + 0.02) {
                      markIndex += 1;
                    }

                    let nextIndex = 0;
                    if (markIndex > 0) {
                      const lastMark = marks[markIndex - 1];
                      nextIndex = Math.min(lastMark.text_offset + (lastMark.text?.length || 0), item.text.length);
                    } else if (marks.length === 0) {
                      const duration = Math.max(audio.duration || 0.4, 0.4);
                      const progress = Math.min(now / duration, 1);
                      nextIndex = Math.floor(item.text.length * progress);
                    }

                    setKaraoke((prev) => {
                      if (!prev.active || prev.sourceText !== (item.sourceText || item.text)) {
                        return prev;
                      }
                      const absStart = item.segmentStart ?? 0;
                      const absEnd = item.segmentEnd ?? (item.sourceText || item.text).length;
                      const absIndex = Math.min(absStart + nextIndex, absEnd);
                      updateSpokenText(item, absIndex);
                      return { ...prev, segmentEnd: absIndex, segmentTargetEnd: absEnd };
                    });
                  }, 40);
                };

            audio.onplay = startKaraoke;
                audio.onended = () => {
                  if (timer !== null) {
                    window.clearInterval(timer);
                  }
                  setKaraoke((prev) => {
                    if (prev.sourceText !== (item.sourceText || item.text)) {
                      return { active: false };
                    }
                    return {
                      ...prev,
                      segmentEnd: item.segmentEnd ?? (item.sourceText || item.text).length,
                      segmentTargetEnd: item.segmentEnd ?? (item.sourceText || item.text).length,
                      active: false
                    };
                  });
                  updateSpokenText(item, item.segmentEnd ?? (item.sourceText || item.text).length);
                  URL.revokeObjectURL(url);
                  currentAudioRef.current = null;
                  if (audioQueueRef.current.length === 0 && statusKey !== "done" && statusKey !== "error") {
                    const fallbackRole: "A" | "B" | "C" | null =
                      activeSpeaker ?? (item.role === "judge" ? "A" : null);
                    const fallbackRound = item.round ?? item.judgeRound ?? activeRound;
                    setUiStatus("thinking", fallbackRole, fallbackRound ?? null);
                  }
                  resolve("ok");
                };
            audio.onerror = () => {
                  if (timer !== null) {
                    window.clearInterval(timer);
                  }
              URL.revokeObjectURL(url);
              currentAudioRef.current = null;
              setKaraoke({ active: false });
              resolve("ok");
            };
            audio.play().catch(() => {
                  if (timer !== null) {
                    window.clearInterval(timer);
                  }
              setAudioNeedsUnlock(true);
              URL.revokeObjectURL(url);
              currentAudioRef.current = null;
              setKaraoke({ active: false });
              resolve("blocked");
            });
          });

          if (playState === "blocked") {
            audioQueueRef.current.unshift(item);
            break;
          }
        } catch {
          continue;
        }
      }
    } finally {
      isSpeakingRef.current = false;
    }
  };

  const enqueueSpeech = (
    role: TTSRole,
    text: string,
    meta?: {
      target?: "debate" | "judge_summary" | "judge_reason";
      round?: number;
      speaker?: "B" | "C";
      judgeRound?: number;
      sourceText?: string;
      segmentStart?: number;
      segmentEnd?: number;
    }
  ) => {
    const cleaned = text.trim();
    if (!ttsEnabled || !cleaned) {
      return;
    }
    audioQueueRef.current.push({ role, text: cleaned, ...meta });
  };

  const playSpeechAndWait = async (
    role: TTSRole,
    text: string,
    meta?: {
      target?: "debate" | "judge_summary" | "judge_reason";
      round?: number;
      speaker?: "B" | "C";
      judgeRound?: number;
      sourceText?: string;
      segmentStart?: number;
      segmentEnd?: number;
    }
  ) => {
    enqueueSpeech(role, text, meta);
    await playQueue();
  };

  const prefetchSpeech = async (
    role: TTSRole,
    text: string,
    meta?: {
      target?: "debate" | "judge_summary" | "judge_reason";
      round?: number;
      speaker?: "B" | "C";
      judgeRound?: number;
      sourceText?: string;
      segmentStart?: number;
      segmentEnd?: number;
    }
  ): Promise<AudioQueueItem> => {
    const cleaned = text.trim();
    const base: AudioQueueItem = { role, text: cleaned, ...meta };
    if (!ttsEnabled || !cleaned) {
      return base;
    }
    try {
      const tts = await fetchAnnotatedTts(role, cleaned.slice(0, 3000));
      return {
        ...base,
        preparedBlob: base64ToBlob(tts.audio_base64, tts.mime_type || "audio/mpeg"),
        preparedMarks: (tts.marks || []).slice().sort((a, b) => a.time - b.time)
      };
    } catch {
      try {
        const blob = await fetchTtsAudio(role, cleaned.slice(0, 3000));
        return { ...base, preparedBlob: blob, preparedMarks: [] };
      } catch {
        return base;
      }
    }
  };

  const playPrefetchedInOrder = async (items: AudioQueueItem[]) => {
    for (const item of items) {
      audioQueueRef.current.push(item);
      await playQueue();
    }
  };

  const waitForAudioIdle = async () => {
    while (ttsEnabled && (isSpeakingRef.current || audioQueueRef.current.length > 0)) {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 60);
      });
    }
  };

  const applyStreamEvent = async (event: DebateStreamEvent) => {
    if (event.type === "round_start" && event.round) {
      setUiStatus("thinking", "B", event.round);
      setActiveRound(event.round);
      setActiveSpeaker(null);
      setLiveRounds((prev) => ensureRound(prev, event.round as number));
      return;
    }

    if (event.type === "chunk" && event.round && event.speaker && event.delta) {
      setUiStatus("thinking", event.speaker, event.round);
      setActiveRound(event.round);
      setActiveSpeaker(event.speaker);
      setLiveRounds((prev) => ensureRound(prev, event.round as number));
      return;
    }

    if (event.type === "round_end" && event.round) {
      setUiStatus("thinking", "A", event.round);
      setActiveSpeaker(null);
      return;
    }

    if (event.type === "turn_end" && event.speaker && event.text) {
      await waitForAudioIdle();
      const role: TTSRole = event.speaker === "B" ? "affirmative" : "negative";
      const prefetched = [
        await prefetchSpeech(role, event.text, {
          target: "debate",
          round: event.round,
          speaker: event.speaker,
          sourceText: event.text,
          segmentStart: 0,
          segmentEnd: event.text.length
        })
      ];
      await playPrefetchedInOrder(prefetched);
      return;
    }

    if (event.type === "judge_round" && event.round && event.summary) {
      setUiStatus("thinking", "A", event.round);
      return;
    }

    if (event.type === "judge" && event.judge) {
      setJudge({ ...event.judge, reason: "" });
      setJudgeReasonDisplayed("");
      setUiStatus("thinking", "A", activeRound);
      setActiveSpeaker("A");
      const winner = roleLabelMap[event.judge.winner] || event.judge.winner;
      await waitForAudioIdle();
      await playSpeechAndWait("judge", `最终判决，胜方是${winner}。`, {
        judgeRound: activeRound ?? undefined
      });
      const prefetched = [
        await prefetchSpeech("judge", event.judge.reason, {
          target: "judge_reason",
          judgeRound: activeRound ?? undefined,
          sourceText: event.judge.reason,
          segmentStart: 0,
          segmentEnd: event.judge.reason.length
        })
      ];
      await playPrefetchedInOrder(prefetched);
      setJudge(event.judge);
      setActiveSpeaker(null);
      return;
    }

    if (event.type === "done" && event.transcript && event.judge) {
      setResult({
        topic: topic.trim(),
        rounds,
        model_name: modelName.trim() || "gpt-5.4",
        transcript: event.transcript,
        judge: event.judge
      });
      setJudge(event.judge);
      setUiStatus("done", null, activeRound);
      setActiveSpeaker(null);
      return;
    }

    if (event.type === "error") {
      setError(event.message || "流式请求失败");
      setUiStatus("error");
      stopAudioPlayback();
    }
  };

  const processEventQueue = async () => {
    if (isProcessingEventsRef.current) {
      return;
    }
    isProcessingEventsRef.current = true;
    try {
      while (eventQueueRef.current.length > 0) {
        const event = eventQueueRef.current.shift();
        if (!event) {
          continue;
        }
        await applyStreamEvent(event);
      }
    } finally {
      isProcessingEventsRef.current = false;
    }
  };

  const handleIncomingEvent = (event: DebateStreamEvent) => {
    eventQueueRef.current.push(event);
    void processEventQueue();
  };

  const onSubmit = async () => {
    setError("");
    setResult(null);
    setJudge(null);
    setJudgeReasonDisplayed("");
    setShowJudgeModal(false);
    setLiveRounds({});
    setActiveRound(null);
    setActiveSpeaker(null);
    eventQueueRef.current = [];
    isProcessingEventsRef.current = false;
    stopAudioPlayback();

    if (!topic.trim()) {
      setError("请输入辩题");
      return;
    }

    setStatusLang(/[\u4e00-\u9fff]/.test(topic) ? "zh" : "en");
    setLoading(true);
    setUiStatus("thinking", null, null);
    try {
      await startDebateStream(
        {
        topic: topic.trim(),
        rounds,
        model_name: modelName.trim() || "gpt-5.4"
        },
        handleIncomingEvent
      );
    } catch (err: unknown) {
      const unknownMessage = "请求失败";
      if (typeof err === "object" && err && "response" in err) {
        const maybeResp = err as { response?: { data?: { detail?: string } } };
        setError(maybeResp.response?.data?.detail || unknownMessage);
      } else if (err instanceof Error) {
        setError(err.message || unknownMessage);
      } else {
        setError(unknownMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!activeSpeaker) {
      return;
    }

    if (activeSpeaker === "B" && affirmativeBodyRef.current) {
      affirmativeBodyRef.current.scrollTo({ top: affirmativeBodyRef.current.scrollHeight, behavior: "smooth" });
      return;
    }

    if (activeSpeaker === "C" && negativeBodyRef.current) {
      negativeBodyRef.current.scrollTo({ top: negativeBodyRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [activeSpeaker, liveRounds]);

  useEffect(() => {
    if (!ttsEnabled) {
      stopAudioPlayback();
    }
  }, [ttsEnabled]);

  const unlockAudio = () => {
    setAudioNeedsUnlock(false);
    if (ttsEnabled) {
      void playQueue();
    }
  };

  return (
    <div className="appShell">
      <header className="arenaTop">
        <div className="topicBlock">
          <span className="topicLabel">Topic Setting</span>
          <input
            className="topicInput"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="输入辩题"
          />
        </div>
        <div className="topControls">
          <div className="controlItem compact">
            <label htmlFor="rounds">轮数</label>
            <input
              id="rounds"
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </div>
          <label className="ttsToggle" htmlFor="tts-toggle">
            <input
              id="tts-toggle"
              type="checkbox"
              checked={ttsEnabled}
              onChange={(e) => setTtsEnabled(e.target.checked)}
            />
            <span>语音播报</span>
          </label>
          <button className="modeBtn" onClick={() => setViewMode((m) => (m === "expanded" ? "focus" : "expanded"))}>
            {viewMode === "expanded" ? "切换聚焦模式" : "切换内容模式"}
          </button>
        </div>
      </header>

      {audioNeedsUnlock ? (
        <div className="audioUnlockBanner">
          <span>浏览器已阻止自动播放，点击启用语音播报</span>
          <button className="unlockBtn" onClick={unlockAudio}>启用音频</button>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <main className={`arenaMain ${viewMode === "focus" ? "focusMain" : ""}`}>
        {viewMode === "focus" ? (
          <>
            <section className="focusCard negativeFocus">
              <div className={`focusAvatarWrap ${speakingSpeaker === "C" ? "speakingAvatar" : thinkingSpeaker === "C" ? "thinkingAvatar" : ""}`}>
                <img className="focusAvatar" src={negativeAvatarSrc} alt="反方头像" />
              </div>
              <div className={`liveDot ${speakingSpeaker === "C" ? "speaking" : thinkingSpeaker === "C" ? "thinking" : ""}`}>
                {speakingSpeaker === "C" ? "speaking" : thinkingSpeaker === "C" ? "thinking" : "idle"}
              </div>
              <p className="focusViewpoint">{sideViewpoints.c}</p>
              <div className="voiceWaves" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </section>

            <section className="focusCard affirmativeFocus">
              <div className={`focusAvatarWrap ${speakingSpeaker === "B" ? "speakingAvatar" : thinkingSpeaker === "B" ? "thinkingAvatar" : ""}`}>
                <img className="focusAvatar" src={affirmativeAvatarSrc} alt="正方头像" />
              </div>
              <div className={`liveDot ${speakingSpeaker === "B" ? "speaking" : thinkingSpeaker === "B" ? "thinking" : ""}`}>
                {speakingSpeaker === "B" ? "speaking" : thinkingSpeaker === "B" ? "thinking" : "idle"}
              </div>
              <p className="focusViewpoint">{sideViewpoints.b}</p>
              <div className="voiceWaves" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            </section>
          </>
        ) : (
          <>
        <section className="column negative">
          <div className="columnHeader richHeader">
            <div className="identity">
              <div className={`avatar negativeAvatar ${speakingSpeaker === "C" ? "speakingAvatar" : thinkingSpeaker === "C" ? "thinkingAvatar" : ""}`}>
                <img className="avatarImg" src={negativeAvatarSrc} alt="反方头像" />
              </div>
              <div>
                <h2>AI Negative</h2>
                <p>反方</p>
                <p className="sideViewpoint">{sideViewpoints.c}</p>
              </div>
            </div>
            <div className={`liveDot ${speakingSpeaker === "C" ? "speaking" : thinkingSpeaker === "C" ? "thinking" : ""}`}>
              {speakingSpeaker === "C" ? "speaking" : thinkingSpeaker === "C" ? "thinking" : "idle"}
            </div>
          </div>
          <div
            className="columnBody logicStream"
            ref={negativeBodyRef}
          >
            {roundNumbers.length === 0 ? (
              <div className="emptyState emptyNegative">{emptyHints.negative}</div>
            ) : null}
            {roundNumbers.map((roundNo) => {
              const active = (speakingSpeaker === "C" || thinkingSpeaker === "C") && activeRound === roundNo;
              const speaking = speakingSpeaker === "C" && activeRound === roundNo;
              return (
                <div
                  key={`c-${roundNo}`}
                  className={`bubble bubbleNegative ${active ? "activeBubble" : ""} ${speaking ? "speakingBubble" : ""}`}
                  data-round={roundNo}
                >
                  <div className={`roundTag ${active ? "activeRoundTag" : ""}`}>第 {roundNo} 轮</div>
                  <p>
                    {getRoundText(roundNo, "C")
                      ? renderKaraokeText(getRoundText(roundNo, "C"), "C")
                      : getRoundFallbackText(roundNo, "C")}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="column affirmative">
          <div className="columnHeader richHeader">
            <div className="identity">
              <div className={`avatar affirmativeAvatar ${speakingSpeaker === "B" ? "speakingAvatar" : thinkingSpeaker === "B" ? "thinkingAvatar" : ""}`}>
                <img className="avatarImg" src={affirmativeAvatarSrc} alt="正方头像" />
              </div>
              <div>
                <h2>AI Affirmative</h2>
                <p>正方</p>
                <p className="sideViewpoint">{sideViewpoints.b}</p>
              </div>
            </div>
            <div className={`liveDot ${speakingSpeaker === "B" ? "speaking" : thinkingSpeaker === "B" ? "thinking" : ""}`}>
              {speakingSpeaker === "B" ? "speaking" : thinkingSpeaker === "B" ? "thinking" : "idle"}
            </div>
          </div>
          <div
            className="columnBody logicStream"
            ref={affirmativeBodyRef}
          >
            {roundNumbers.length === 0 ? (
              <div className="emptyState emptyAffirmative">{emptyHints.affirmative}</div>
            ) : null}
            {roundNumbers.map((roundNo) => {
              const active = (speakingSpeaker === "B" || thinkingSpeaker === "B") && activeRound === roundNo;
              const speaking = speakingSpeaker === "B" && activeRound === roundNo;
              return (
                <div
                  key={`b-${roundNo}`}
                  className={`bubble bubbleAffirmative ${active ? "activeBubble" : ""} ${speaking ? "speakingBubble" : ""}`}
                  data-round={roundNo}
                >
                  <div className={`roundTag ${active ? "activeRoundTag" : ""}`}>第 {roundNo} 轮</div>
                  <p>
                    {getRoundText(roundNo, "B")
                      ? renderKaraokeText(getRoundText(roundNo, "B"), "B")
                      : getRoundFallbackText(roundNo, "B")}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
          </>
        )}
      </main>

      <footer className="judgeDock">
        <div className="dockLeft">
          <div className="dockTitleWithAvatar">
            <img className="dockJudgeAvatar" src={judgeAvatarSrc} alt="裁判头像" />
            <div className="dockTitle">裁判</div>
          </div>
          {judge ? (
            <div className="dockSub dockSubResult">
              <div className="dockWinner">
                胜方：
                <strong>{roleLabelMap[judge.winner] || judge.winner}</strong>
              </div>
              <div className="dockScoreChips">
                {dockScoreSummary.map((item) => (
                  <div key={item.key} className="dockScoreChip">
                    <span className="chipLabel">{item.label}</span>
                    <span className="chipValue">{item.text}</span>
                    <span className="chipLead">领先：{item.lead}</span>
                  </div>
                ))}
              </div>
              <button className="viewJudgeBtn" onClick={() => setShowJudgeModal(true)}>查看裁判详情</button>
            </div>
          ) : (
            <div className="dockSub">{statusText}</div>
          )}
        </div>
        <div className="dockRight">
          <div className="dockActionRow">
            <div className="roundBadge dockRoundBadge">{currentRoundLabel}</div>
            <button className="startButton dockStartButton" onClick={onSubmit} disabled={loading}>
              {loading ? "辩论进行中（流式）..." : "开始辩论"}
            </button>
          </div>
          <div className="dockRow">
            <span>正方优势</span>
            <strong>{affirmativeEdge}%</strong>
          </div>
          <div className="barWrap">
            <div className="barPositive" style={{ width: `${affirmativeEdge}%` }} />
            <div className="barNegative" style={{ width: `${100 - affirmativeEdge}%` }} />
          </div>
        </div>
      </footer>

      {showJudgeModal && judge ? (
        <div className="judgeModalMask" onClick={() => setShowJudgeModal(false)}>
          <div className="judgeModal" onClick={(e) => e.stopPropagation()}>
            <div className="judgeModalHeader">
              <h3>裁判最终评审</h3>
              <button className="closeJudgeBtn" onClick={() => setShowJudgeModal(false)}>关闭</button>
            </div>
            <p className="judgeModalWinner">胜方：{roleLabelMap[judge.winner] || judge.winner}</p>
            <div className="scoreBoard">
              {scoreDimensions.map((dimension) => {
                const bValue = Number(judge.scores.B?.[dimension] ?? 0);
                const cValue = Number(judge.scores.C?.[dimension] ?? 0);
                const total = Math.max(bValue + cValue, 1);
                const bWidth = (bValue / total) * 100;
                const cWidth = (cValue / total) * 100;
                return (
                  <div key={`modal-${dimension}`} className="scoreRow">
                    <div className="scoreMeta">
                      <span>{scoreLabelMap[dimension] || dimension}</span>
                      <span>正方 {bValue.toFixed(1)} : {cValue.toFixed(1)} 反方</span>
                    </div>
                    <div className="scoreBar">
                      <div className="scoreBarB" style={{ width: `${bWidth}%` }} />
                      <div className="scoreBarC" style={{ width: `${cWidth}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="judgeReason">{judgeReasonDisplayed || judge.reason}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
