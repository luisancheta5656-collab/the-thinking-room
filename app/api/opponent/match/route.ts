import { NextResponse } from "next/server";
import { cleanLevel } from "@/lib/agent-match";
import { askOpenSpiel, openspielPlayers } from "@/lib/openspiel";

type EngineMove = { move: string; explanation: string; winChance: number | null };

// One move by a chosen agent, for AI vs AI or as your opponent. The engine checks that the agent plays this game.
const supportedGames = new Set(["chess", "tictactoe", "checkers", "gomoku"]);

export async function GET() {
  try {
    return NextResponse.json({ players: await openspielPlayers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent roster could not be loaded.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function POST(request: Request) {
  let payload: { game?: unknown; player?: unknown; board?: unknown; legalMoves?: unknown; level?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid move request." }, { status: 400 });
  }

  const { game, player, board, legalMoves, level } = payload;
  if (
    typeof game !== "string" || !supportedGames.has(game) ||
    typeof player !== "string" || player.length > 40 ||
    !Array.isArray(legalMoves) || legalMoves.length === 0 || legalMoves.length > 300 ||
    !legalMoves.every((move) => typeof move === "string" && move.length <= 16)
  ) {
    return NextResponse.json({ error: "Invalid match request." }, { status: 400 });
  }
  const boardState = JSON.stringify(board);
  if (!boardState || boardState.length > 12000) {
    return NextResponse.json({ error: "Game state is missing or too large." }, { status: 413 });
  }

  try {
    const decision = await askOpenSpiel<EngineMove>("/move", { game, player, board, legalMoves, level: cleanLevel(level) });
    if (!(legalMoves as string[]).includes(decision.move)) {
      return NextResponse.json({ error: "The agent did not return a legal move." }, { status: 502 });
    }
    return NextResponse.json({
      move: decision.move,
      explanation: String(decision.explanation ?? "").trim().slice(0, 400),
      winChance: decision.winChance ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not move.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
