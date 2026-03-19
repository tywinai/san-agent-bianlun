import { useEffect, useMemo, useRef, useState } from "react";

import { fetchTtsAudio, startDebateStream } from "./api";
import type {
  DebateResponse,
  DebateRound,
  DebateStreamEvent,
  JudgeResult,
  RoundJudgeSummary,
  TTSRole
} from "./types";
import "./styles.css";

type LiveRound = {
  b: string;
  c: string;
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

export default function App() {
  const [topic, setTopic] = useState("AI 是否会在未来 10 年大规模替代人类工作？");
  const [rounds, setRounds] = useState(3);
  const [modelName, setModelName] = useState("gpt-5.4");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DebateResponse | null>(null);
  const [liveRounds, setLiveRounds] = useState<Record<number, LiveRound>>({});
  const [judge, setJudge] = useState<JudgeResult | null>(null);
  const [judgeRoundSummaries, setJudgeRoundSummaries] = useState<RoundJudgeSummary[]>([]);
  const [status, setStatus] = useState("准备就绪");
  const [error, setError] = useState("");
  const [activeSpeaker, setActiveSpeaker] = useState<"B" | "C" | null>(null);
  const [activeRound, setActiveRound] = useState<number | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState(false);

  const negativeBodyRef = useRef<HTMLDivElement | null>(null);
  const affirmativeBodyRef = useRef<HTMLDivElement | null>(null);
  const judgeBodyRef = useRef<HTMLDivElement | null>(null);
  const audioQueueRef = useRef<Array<{ role: TTSRole; text: string }>>([]);
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

  const latestSummary = useMemo(() => {
    if (judgeRoundSummaries.length === 0) {
      return "等待裁判分析日志...";
    }
    return judgeRoundSummaries[judgeRoundSummaries.length - 1].summary;
  }, [judgeRoundSummaries]);

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

  const hasDebateStarted =
    roundNumbers.length > 0 || judgeRoundSummaries.length > 0 || Boolean(result) || loading;

  const shouldShowJudgePending =
    !judge &&
    hasDebateStarted &&
    !activeSpeaker &&
    (status.includes("裁判") || status.includes("评审") || status.includes("完成"));

  const shouldShowJudgePlaceholder =
    !judge &&
    !shouldShowJudgePending &&
    (judgeRoundSummaries.length === 0 || (activeRound !== null && judgeRoundSummaries.length < activeRound));

  const emptyHints = useMemo(() => {
    const idle = status === "准备就绪";
    const connecting = status.includes("建立流式连接");
    const running = loading || status.includes("第 ");

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
  }, [status, loading, activeSpeaker]);

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

  const stopAudioPlayback = () => {
    audioQueueRef.current = [];
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.currentTime = 0;
      currentAudioRef.current = null;
    }
    isSpeakingRef.current = false;
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
          const blob = await fetchTtsAudio(item.role, item.text.slice(0, 3000));
          const url = URL.createObjectURL(blob);
          const playState = await new Promise<"ok" | "blocked">((resolve) => {
            const audio = new Audio(url);
            currentAudioRef.current = audio;
            audio.onended = () => {
              URL.revokeObjectURL(url);
              currentAudioRef.current = null;
              resolve("ok");
            };
            audio.onerror = () => {
              URL.revokeObjectURL(url);
              currentAudioRef.current = null;
              resolve("ok");
            };
            audio.play().catch(() => {
              setAudioNeedsUnlock(true);
              URL.revokeObjectURL(url);
              currentAudioRef.current = null;
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

  const enqueueSpeech = (role: TTSRole, text: string) => {
    const cleaned = text.trim();
    if (!ttsEnabled || !cleaned) {
      return;
    }
    audioQueueRef.current.push({ role, text: cleaned });
  };

  const playSpeechAndWait = async (role: TTSRole, text: string) => {
    enqueueSpeech(role, text);
    await playQueue();
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
      setStatus(`第 ${event.round} 轮开始`);
      setActiveRound(event.round);
      setActiveSpeaker(null);
      setLiveRounds((prev) => ensureRound(prev, event.round as number));
      return;
    }

    if (event.type === "chunk" && event.round && event.speaker && event.delta) {
      setStatus(`第 ${event.round} 轮 ${event.speaker === "B" ? "正方" : "反方"}发言中...`);
      setActiveRound(event.round);
      setActiveSpeaker(event.speaker);
      setLiveRounds((prev) => {
        const next = ensureRound(prev, event.round as number);
        const row = next[event.round as number];
        if (event.speaker === "B") {
          return { ...next, [event.round as number]: { ...row, b: row.b + event.delta } };
        }
        return { ...next, [event.round as number]: { ...row, c: row.c + event.delta } };
      });
      return;
    }

    if (event.type === "round_end" && event.round) {
      setStatus(`第 ${event.round} 轮完成`);
      setActiveSpeaker(null);
      return;
    }

    if (event.type === "turn_end" && event.speaker && event.text) {
      await waitForAudioIdle();
      if (event.speaker === "B") {
        await playSpeechAndWait("affirmative", event.text);
      } else if (event.speaker === "C") {
        await playSpeechAndWait("negative", event.text);
      }
      return;
    }

    if (event.type === "judge_round" && event.round && event.summary) {
      setStatus(`第 ${event.round} 轮裁判小结已生成`);
      setJudgeRoundSummaries((prev) => {
        const filtered = prev.filter((item) => item.round !== event.round);
        return [...filtered, { round: event.round, summary: event.summary as string }].sort(
          (a, b) => a.round - b.round
        );
      });
      await waitForAudioIdle();
      await playSpeechAndWait("judge", `第${event.round}轮小结。${event.summary}`);
      return;
    }

    if (event.type === "judge" && event.judge) {
      setJudge(event.judge);
      setStatus("裁判评审完成");
      setActiveSpeaker(null);
      const winner = roleLabelMap[event.judge.winner] || event.judge.winner;
      await waitForAudioIdle();
      await playSpeechAndWait("judge", `最终判决，胜方是${winner}。${event.judge.reason}`);
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
      setStatus("辩论完成");
      setActiveSpeaker(null);
      return;
    }

    if (event.type === "error") {
      setError(event.message || "流式请求失败");
      setStatus("执行失败");
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
    setJudgeRoundSummaries([]);
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

    setLoading(true);
    setStatus("正在建立流式连接...");
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
    if (!judgeBodyRef.current) {
      return;
    }
    judgeBodyRef.current.scrollTo({ top: judgeBodyRef.current.scrollHeight, behavior: "smooth" });
  }, [judgeRoundSummaries, judge]);

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
          <div className="statusText">状态：{status}</div>
        </div>
      </header>

      {audioNeedsUnlock ? (
        <div className="audioUnlockBanner">
          <span>浏览器已阻止自动播放，点击启用语音播报</span>
          <button className="unlockBtn" onClick={unlockAudio}>启用音频</button>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <main className="arenaMain">
        <section className="column negative">
          <div className="columnHeader richHeader">
            <div className="identity">
              <div className="avatar negativeAvatar">C</div>
              <div>
                <h2>AI Negative</h2>
                <p>反方</p>
              </div>
            </div>
            <div className={`liveDot ${activeSpeaker === "C" ? "active" : ""}`}>thinking</div>
          </div>
          <div
            className="columnBody logicStream"
            ref={negativeBodyRef}
          >
            {roundNumbers.length === 0 ? (
              <div className="emptyState emptyNegative">{emptyHints.negative}</div>
            ) : null}
            {roundNumbers.map((roundNo) => {
              const active = activeSpeaker === "C" && activeRound === roundNo;
              return (
                <div
                  key={`c-${roundNo}`}
                  className={`bubble bubbleNegative ${active ? "activeBubble" : ""}`}
                  data-round={roundNo}
                >
                  <div className="roundTag">第 {roundNo} 轮</div>
                  <p>{getRoundText(roundNo, "C") || getRoundFallbackText(roundNo, "C")}</p>
                </div>
              );
            })}
          </div>
        </section>

        <section className="column judge">
          <div className="columnHeader richHeader">
            <div className="identity">
              <div className="avatar judgeAvatar">A</div>
              <div>
                <h2>AI Judge</h2>
                <p>裁判</p>
              </div>
            </div>
            <div className="liveDot">analysis</div>
          </div>
          <div
            className="columnBody logicStream"
            ref={judgeBodyRef}
          >
            {judgeRoundSummaries.map((item) => (
              <div key={`judge-round-${item.round}`} className="judgeCard" data-round={item.round}>
                <div className="roundTag">第 {item.round} 轮小结</div>
                <p className="judgeReason">{item.summary}</p>
              </div>
            ))}
            {judge ? (
              <div className="judgeCard finalVerdict">
                <div className="roundTag">最终判决</div>
                <p>
                  <strong>胜方：</strong>
                  {roleLabelMap[judge.winner] || judge.winner}
                </p>
                {scoreDimensions.length > 0 ? (
                  <div className="scoreBoard">
                    {scoreDimensions.map((dimension) => {
                      const bValue = Number(judge.scores.B?.[dimension] ?? 0);
                      const cValue = Number(judge.scores.C?.[dimension] ?? 0);
                      const total = Math.max(bValue + cValue, 1);
                      const bWidth = (bValue / total) * 100;
                      const cWidth = (cValue / total) * 100;
                      return (
                        <div key={dimension} className="scoreRow">
                          <div className="scoreMeta">
                            <span>{scoreLabelMap[dimension] || dimension}</span>
                              <span>
                              正方 {bValue.toFixed(1)} : {cValue.toFixed(1)} 反方
                            </span>
                          </div>
                          <div className="scoreBar">
                            <div className="scoreBarB" style={{ width: `${bWidth}%` }} />
                            <div className="scoreBarC" style={{ width: `${cWidth}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <p className="judgeReason">{judge.reason}</p>
              </div>
            ) : shouldShowJudgePending ? (
              <div className="judgeCard pending">裁判评审中...</div>
            ) : null}
            {shouldShowJudgePlaceholder ? (
              <div className="emptyState emptyJudge">{emptyHints.judge}</div>
            ) : null}
          </div>
        </section>

        <section className="column affirmative">
          <div className="columnHeader richHeader">
            <div className="identity">
              <div className="avatar affirmativeAvatar">B</div>
              <div>
                <h2>AI Affirmative</h2>
                <p>正方</p>
              </div>
            </div>
            <div className={`liveDot ${activeSpeaker === "B" ? "active" : ""}`}>synthesizing</div>
          </div>
          <div
            className="columnBody logicStream"
            ref={affirmativeBodyRef}
          >
            {roundNumbers.length === 0 ? (
              <div className="emptyState emptyAffirmative">{emptyHints.affirmative}</div>
            ) : null}
            {roundNumbers.map((roundNo) => {
              const active = activeSpeaker === "B" && activeRound === roundNo;
              return (
                <div
                  key={`b-${roundNo}`}
                  className={`bubble bubbleAffirmative ${active ? "activeBubble" : ""}`}
                  data-round={roundNo}
                >
                  <div className="roundTag">第 {roundNo} 轮</div>
                  <p>{getRoundText(roundNo, "B") || getRoundFallbackText(roundNo, "B")}</p>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="judgeDock">
        <div className="dockLeft">
          <div className="dockTitle">裁判</div>
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
            </div>
          ) : (
            <div className="dockSub">{latestSummary}</div>
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
    </div>
  );
}
