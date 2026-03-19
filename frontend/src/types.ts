export interface DebateRequest {
  topic: string;
  rounds: number;
  model_name: string;
}

export interface DebateRound {
  round: number;
  b_statement: string;
  c_statement: string;
}

export interface JudgeResult {
  winner: "B" | "C" | "DRAW";
  scores: Record<string, Record<string, number>>;
  reason: string;
}

export interface DebateResponse {
  topic: string;
  rounds: number;
  model_name: string;
  transcript: DebateRound[];
  judge: JudgeResult;
}

export type StreamSpeaker = "B" | "C";

export interface DebateStreamEvent {
  type: string;
  round?: number;
  speaker?: StreamSpeaker;
  delta?: string;
  text?: string;
  b_statement?: string;
  c_statement?: string;
  judge?: JudgeResult;
  transcript?: DebateRound[];
  message?: string;
  summary?: string;
}

export interface RoundJudgeSummary {
  round: number;
  summary: string;
}
