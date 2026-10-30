import { NextResponse } from "next/server";
import { ollamaBaseUrl, ollamaModel } from "@/lib/ollama";
import { askOpenSpiel, openspielStatus } from "@/lib/openspiel";

const supportedGames = new Set(["chess", "tictactoe", "checkers", "gomoku"]);

type EngineMove = {
  move: string;
  explanation: string;
  winChance: number;
  agents: Record<string, unknown>;
};

async function ollamaStatus() {
  try {
    const response = await fetch(`${ollamaBaseUrl()}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { configured: false, runtimeAvailable: false, model: ollamaModel() };
    const data = await response.json() as { models?: { name?: string }[] };
    const models = data.models ?? [];
    const modelAvailable = models.some((model) =>
      model.name === ollamaModel() || model.name?.split(":")[0] === ollamaModel().split(":")[0],
    );
    return { configured: modelAvailable, runtimeAvailable: true, modelAvailable, model: ollamaModel() };
  } catch {
    return { configured: false, runtimeAvailable: false, model: ollamaModel() };
  }
}

export async function GET() {
  const [openspiel, ollama] = await Promise.all([openspielStatus(), ollamaStatus()]);
  return NextResponse.json({ openspiel, ollama });
}

export async function POST(request: Request) {
  let payload: { game?: unknown; board?: unknown; legalMoves?: unknown; sessionScore?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid move request." }, { status: 400 });
  }

  const { game, board, legalMoves, sessionScore } = payload;
  if (
    typeof game !== "string" || !supportedGames.has(game) ||
    !Array.isArray(legalMoves) || legalMoves.length === 0 || legalMoves.length > 300 ||
    !legalMoves.every((move) => typeof move === "string" && move.length <= 16)
  ) {
    return NextResponse.json({ error: "Invalid game state or legal-move list." }, { status: 400 });
  }

  const boardState = JSON.stringify(board);
  if (!boardState || boardState.length > 12000) {
    return NextResponse.json({ error: "Game state is missing or too large." }, { status: 413 });
  }
  const legal = legalMoves as string[];
  const score = typeof sessionScore === "object" && sessionScore !== null
    ? sessionScore as { player?: unknown; opponent?: unknown }
    : {};
  const playerWins = Number.isInteger(score.player) && Number(score.player) >= 0 ? Number(score.player) : 0;
  const opponentWins = Number.isInteger(score.opponent) && Number(score.opponent) >= 0 ? Number(score.opponent) : 0;
  // Steer the session toward 50/50: search harder when the player leads by two, softer when the agents do.
  const winDifference = playerWins - opponentWins;
  const challengeMode = winDifference >= 2 ? "increased"
    : winDifference <= -2 ? "eased"
      : "balanced";

  try {
    const decision = await askOpenSpiel<EngineMove>("/move", { game, board, legalMoves: legal, challengeMode });
    const move = legal.find((candidate) => candidate === decision.move);
    if (!move || typeof decision.explanation !== "string" || !decision.explanation.trim()) {
      return NextResponse.json({ error: "The OpenSpiel Referee did not return a valid legal move." }, { status: 502 });
    }
    return NextResponse.json({
      move,
      explanation: decision.explanation.trim().slice(0, 400),
      winChance: decision.winChance,
      provider: "openspiel",
      agents: ["Strategist", "Challenger", "Referee"],
      challengeMode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "OpenSpiel multi-agent turn failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
