"use client";

import { Chess, type Move, type Square } from "chess.js";
import {
  Blocks,
  Bot,
  CircleHelp,
  Crown,
  Flag,
  Grid2X2,
  Handshake,
  LoaderCircle,
  MessageSquareText,
  RotateCcw,
  Send,
  Swords,
  Target,
  Trophy,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from "react";
import {
  applyCheckersMove,
  chooseChessMove,
  chooseCheckersMove,
  chooseGomokuMove,
  chooseTicTacToeMove,
  createCheckersBoard,
  createGomokuBoard,
  createTicTacToeBoard,
  getCheckersLegalMoves,
  getGomokuWinner,
  getTicTacToeWinner,
  type CheckersBoard,
  type CheckersMove,
  type CheckersPiece,
  type Mark,
} from "@/lib/games";
import { JUMP_MS, KING_GLOW_MS, MOVE_GAP_MS, SLIDE_MS } from "@/lib/animation";
import AgentMatchPanel from "@/components/AgentMatchPanel";
import DifficultySlider from "@/components/DifficultySlider";
import {
  adaptedLevel,
  CHECKERS_NO_CAPTURE_LIMIT,
  DEFAULT_FIGHTERS,
  DEFAULT_LEVEL,
  LEVEL_NAMES,
  MATCH_MAX_PLIES,
  MATCH_PAUSE_MS,
  matchGames,
  REPETITION_LIMIT,
  resolveFighter,
  sideLabel,
  type Fighters,
  type MatchGame,
  type MatchOutcome,
  type MatchSide,
  type MatchSpeed,
  type MatchStatus,
  type RosterPlayer,
} from "@/lib/agent-match";

// Three.js loads only when a 3D board is shown, and never on the server.
const ChessBoard3D = dynamic(() => import("@/components/ChessBoard3D"), {
  ssr: false,
  loading: () => <div className="board3d board3d-loading">Loading 3D board…</div>,
});

type GameId = "chess" | "tictactoe" | "checkers" | "gomoku";
type BoardView = "2d" | "3d";
const BOARD_VIEW_KEY = "thinking-room-board-view";
// Games that have a 3D board; the others are always 2D.
const games3d = new Set<GameId>(["chess"]);

// The viewer's 2D/3D choice, remembered in localStorage when it is available.
let boardViewFallback: BoardView = "3d";
const boardViewListeners = new Set<() => void>();
function readBoardView(): BoardView {
  try {
    const saved = window.localStorage.getItem(BOARD_VIEW_KEY);
    if (saved === "2d" || saved === "3d") return saved;
  } catch {
    // Storage blocked: use the in-memory choice.
  }
  return boardViewFallback;
}
function subscribeBoardView(listener: () => void) {
  boardViewListeners.add(listener);
  return () => boardViewListeners.delete(listener);
}
function changeBoardView(view: BoardView) {
  boardViewFallback = view;
  try {
    window.localStorage.setItem(BOARD_VIEW_KEY, view);
  } catch {
    // Not remembered between sessions this time.
  }
  for (const listener of boardViewListeners) listener();
}
type Result = "player" | "opponent" | "draw" | null;
type OpponentMode = "local" | "openspiel";
type ChatMessage = { role: "user" | "assistant" | "system" | "coach"; content: string };

const games: { id: GameId; name: string; detail: string; icon: LucideIcon; number: string }[] = [
  { id: "chess", name: "Chess", detail: "The long game", icon: Crown, number: "01" },
  { id: "tictactoe", name: "Tic-tac-toe", detail: "Three in a row", icon: Grid2X2, number: "02" },
  { id: "checkers", name: "Checkers", detail: "Take the middle", icon: Blocks, number: "03" },
  { id: "gomoku", name: "Gomoku", detail: "Five in a line", icon: Target, number: "04" },
];

const pieceGlyphs: Record<string, string> = {
  wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙",
  bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟",
};

const TEAM_ID = "team";
const START_FEN = new Chess().fen();

type AgentMove = { move: string; explanation: string };
type AgentScore = { player: number; opponent: number; draw: number };

// The team adapts to the session score; any other chosen agent plays at a fixed strength.
async function askOpponent(playerId: string, level: number, game: GameId, board: unknown, legalMoves: string[], sessionScore: AgentScore): Promise<AgentMove | null> {
  const response = await fetch(playerId === TEAM_ID ? "/api/opponent" : "/api/opponent/match", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(playerId === TEAM_ID
      ? { game, board, legalMoves, sessionScore, level }
      : { game, player: playerId, board, legalMoves, level }),
  });
  if (!response.ok) {
    const data = await response.json() as { error?: unknown };
    throw new Error(typeof data.error === "string" ? data.error : "The agent could not return a move.");
  }
  const data = (await response.json()) as { move?: unknown; explanation?: unknown };
  if (
    typeof data.move !== "string" || !legalMoves.includes(data.move) ||
    typeof data.explanation !== "string" || !data.explanation.trim()
  ) return null;
  return { move: data.move, explanation: data.explanation.trim() };
}

function checkersMoveKey(move: CheckersMove): string {
  return `${move.from}:${move.to}`;
}

function checkersCoordinate(index: number): string {
  return `${"abcdefgh"[index % 8]}${8 - Math.floor(index / 8)}`;
}

// The last checkers move, for the board animation: the piece slides (or jumps)
// from `from` to `to`, a captured piece fades out, and a new king's crown pops in.
type CheckersAnimation = { id: number; from: number; to: number; captured: number | null; capturedPiece: CheckersPiece; crowned: boolean };
let checkersAnimationId = 0;

// How long a checkers move's animation plays (a new king's glow runs on after it lands).
function checkersAnimationMs(animation: CheckersAnimation): number {
  const travel = animation.captured === null ? SLIDE_MS : JUMP_MS;
  return animation.crowned ? travel + KING_GLOW_MS : travel;
}

// performance.now() time at which a move animation starting now has finished, plus a short gap.
// The opponent's next move waits for it, so a quick reply never cuts the previous move short.
function animationEndsAt(durationMs: number): number {
  return performance.now() + durationMs + MOVE_GAP_MS;
}

function untilAnimationEnds(end: number): Promise<void> {
  const wait = end - performance.now();
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

// An AI vs AI match in progress. It lives outside React state so the move loop always sees the latest position.
type MatchPosition = {
  fen: string;
  board: CheckersBoard;
  turn: "r" | "b";
  forced: number | null;
  plies: number;
  quietPlies: number;
  seen: Map<string, number>;
};

// The last chess move, for the 2D board animation: the piece slides from `from` to `to`
// and a captured piece (on `capturedSquare`, which differs from `to` only en passant) shrinks away.
type ChessAnimation = { id: number; from: Square; to: Square; capturedSquare: Square | null; capturedGlyph: string | null; capturedColor: "w" | "b" };
let chessAnimationId = 0;

function describeChessMove(move: Move): ChessAnimation {
  chessAnimationId += 1;
  const enPassant = move.flags.includes("e");
  const capturedSquare = move.captured ? (enPassant ? `${move.to[0]}${move.from[1]}` as Square : move.to) : null;
  const capturedColor = move.color === "w" ? "b" : "w";
  return {
    id: chessAnimationId,
    from: move.from,
    to: move.to,
    capturedSquare,
    capturedGlyph: move.captured ? pieceGlyphs[`${capturedColor}${move.captured}`] : null,
    capturedColor,
  };
}

function describeCheckersMove(board: CheckersBoard, move: CheckersMove): CheckersAnimation {
  const piece = board[move.from];
  const row = Math.floor(move.to / 8);
  checkersAnimationId += 1;
  return {
    id: checkersAnimationId,
    from: move.from,
    to: move.to,
    captured: move.captured,
    capturedPiece: move.captured === null ? null : board[move.captured],
    crowned: (piece === "r" && row === 0) || (piece === "b" && row === 7),
  };
}

export default function Home() {
  const [activeGame, setActiveGame] = useState<GameId>("chess");
  const [chessFen, setChessFen] = useState(() => new Chess().fen());
  const [chessSelection, setChessSelection] = useState<Square | null>(null);
  const [lastChessMove, setLastChessMove] = useState<[Square, Square] | null>(null);
  const [chessAnimation, setChessAnimation] = useState<ChessAnimation | null>(null);
  const [ticBoard, setTicBoard] = useState<Mark[]>(createTicTacToeBoard);
  const [checkersBoard, setCheckersBoard] = useState<CheckersBoard>(createCheckersBoard);
  const [checkersTurn, setCheckersTurn] = useState<"r" | "b">("r");
  const [checkersSelection, setCheckersSelection] = useState<number | null>(null);
  const [checkersForcedFrom, setCheckersForcedFrom] = useState<number | null>(null);
  const [checkersAnimation, setCheckersAnimation] = useState<CheckersAnimation | null>(null);
  const [gomokuBoard, setGomokuBoard] = useState<Mark[]>(createGomokuBoard);
  const [busy, setBusy] = useState(false);
  const boardView = useSyncExternalStore(subscribeBoardView, readBoardView, () => "3d" as const);
  const [opponentMode, setOpponentMode] = useState<OpponentMode>("local");
  const [engineStatus, setEngineStatus] = useState("Checking the OpenSpiel engine...");
  const [ollamaReady, setOllamaReady] = useState(false);
  const [ollamaRunning, setOllamaRunning] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState("Checking local Ollama...");
  const [opponentCommentary, setOpponentCommentary] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [coachBusy, setCoachBusy] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [resultDismissed, setResultDismissed] = useState(false);
  const [resigned, setResigned] = useState(false);
  // Resigning takes two clicks: the first arms the button for a few seconds.
  const [resignArmed, setResignArmed] = useState(false);
  const resignTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [score, setScore] = useState({ player: 0, opponent: 0, draw: 0 });
  const [opponentChoice, setOpponentChoice] = useState<Record<GameId, string>>({ chess: TEAM_ID, tictactoe: TEAM_ID, checkers: TEAM_ID, gomoku: TEAM_ID });
  const [opponentLevels, setOpponentLevels] = useState<Record<GameId, number>>({ chess: DEFAULT_LEVEL, tictactoe: DEFAULT_LEVEL, checkers: DEFAULT_LEVEL, gomoku: DEFAULT_LEVEL });
  const [fighterLevels, setFighterLevels] = useState<Record<MatchGame, Record<MatchSide, number>>>({
    chess: { first: DEFAULT_LEVEL, second: DEFAULT_LEVEL },
    checkers: { first: DEFAULT_LEVEL, second: DEFAULT_LEVEL },
  });
  const [watching, setWatching] = useState(false);
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [fighters, setFighters] = useState<Record<MatchGame, Fighters>>(DEFAULT_FIGHTERS);
  const [matchStatus, setMatchStatus] = useState<MatchStatus>("setup");
  const [matchSpeed, setMatchSpeed] = useState<MatchSpeed>("normal");
  const [matchOutcome, setMatchOutcome] = useState<MatchOutcome | null>(null);
  const [matchThinking, setMatchThinking] = useState<MatchSide | null>(null);
  const matchPosition = useRef<MatchPosition | null>(null);
  const matchLoopActive = useRef(false);
  const matchShouldRun = useRef(false);
  const matchPauseMs = useRef(MATCH_PAUSE_MS.normal);
  const session = useRef(0);
  const resultRecorded = useRef(false);
  const coachRequestedForSession = useRef(-1);
  const moveHistory = useRef<string[]>([]);
  const chatLog = useRef<HTMLDivElement>(null);
  // When the current move animation (chess or checkers) finishes, as a performance.now() time.
  const moveAnimationEnd = useRef(0);

  const getChatBoardState = useCallback((): unknown => {
    if (activeGame === "chess") return { fen: chessFen };
    if (activeGame === "tictactoe") return ticBoard;
    if (activeGame === "checkers") return { board: checkersBoard, turn: checkersTurn, forcedFrom: checkersForcedFrom };
    return gomokuBoard;
  }, [activeGame, chessFen, ticBoard, checkersBoard, checkersTurn, checkersForcedFrom, gomokuBoard]);

  useEffect(() => {
    // Re-check every 10 seconds until chat is ready, so starting Ollama or
    // finishing a model download is picked up without reloading.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkStatus = () => {
      void fetch("/api/opponent")
        .then((response) => response.json() as Promise<{
          openspiel?: { available?: boolean; version?: string };
          ollama?: { configured?: boolean; runtimeAvailable?: boolean; model?: string };
        }>)
        .then(({ openspiel = {}, ollama = {} }) => {
          if (cancelled) return;
          const engineAvailable = Boolean(openspiel.available);
          setOpponentMode(engineAvailable ? "openspiel" : "local");
          setEngineStatus(engineAvailable
            ? `OpenSpiel ${openspiel.version ?? ""} engine ready`.replace("  ", " ")
            : "OpenSpiel engine offline · using the built-in local AI");
          const configured = Boolean(ollama.configured);
          setOllamaReady(configured);
          setOllamaRunning(Boolean(ollama.runtimeAvailable));
          setOllamaStatus(configured
            ? `Ollama ready · ${ollama.model ?? "local model"}`
            : ollama.runtimeAvailable
              ? `Ollama is running but the chat model is missing · run ollama pull ${ollama.model ?? "llama3.2:3b"}`
              : "Chat and coaching are optional · start Ollama to enable them");
          if (!configured) timer = setTimeout(checkStatus, 10_000);
        })
        .catch(() => {
          if (cancelled) return;
          setOpponentMode("local");
          setEngineStatus("OpenSpiel engine offline · using the built-in local AI");
          setOllamaReady(false);
          setOllamaRunning(false);
          setOllamaStatus("Chat and coaching are optional · start Ollama to enable them");
          timer = setTimeout(checkStatus, 10_000);
        });
    };
    checkStatus();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  // Keep the newest message in view.
  useEffect(() => {
    const log = chatLog.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [chatMessages, chatBusy, coachBusy]);

  // Load the agents you can choose once the engine is up.
  useEffect(() => {
    if (opponentMode !== "openspiel" || roster.length) return;
    void fetch("/api/opponent/match")
      .then(async (response) => {
        const data = await response.json() as { players?: RosterPlayer[]; error?: string };
        if (!response.ok || !data.players) throw new Error(data.error || "The agent roster could not be loaded.");
        setRoster(data.players);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "The agent roster could not be loaded.";
        setChatMessages((messages) => [...messages, { role: "system" as const, content: message }].slice(-12));
      });
  }, [opponentMode, roster.length]);

  useEffect(() => {
    if (!result || !ollamaReady || coachRequestedForSession.current === session.current) return;
    const reviewSession = session.current;
    coachRequestedForSession.current = reviewSession;
    setCoachBusy(true);
    void fetch("/api/opponent/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        game: activeGame,
        outcome: result,
        history: moveHistory.current,
        finalBoard: getChatBoardState(),
        score,
      }),
    })
      .then(async (response) => {
        const data = await response.json() as {
          review?: { summary?: string; strength?: string; improve?: string; nextTip?: string };
          error?: string;
        };
        if (!response.ok || !data.review) throw new Error(data.error || "Coach review failed.");
        const review = data.review;
        const message = [
          `Match review: ${review.summary ?? "Game complete."}`,
          `Strength: ${review.strength ?? "Keep practicing."}`,
          `Improve: ${review.improve ?? "Review the key positions."}`,
          `Next game: ${review.nextTip ?? "Look for your opponent's threats before moving."}`,
        ].join("\n");
        if (reviewSession === session.current) {
          setChatMessages((messages) => [...messages, { role: "coach" as const, content: message }].slice(-12));
        }
      })
      .catch((error: unknown) => {
        if (reviewSession === session.current) {
          const message = error instanceof Error ? error.message : "Coach review could not be generated.";
          setChatMessages((messages) => [...messages, { role: "system" as const, content: `Coach unavailable: ${message}` }].slice(-12));
        }
      })
      .finally(() => {
        if (reviewSession === session.current) setCoachBusy(false);
      });
  }, [activeGame, getChatBoardState, ollamaReady, result, score]);

  const currentGame = games.find((game) => game.id === activeGame)!;
  const opponentPlayer = resolveFighter(roster, activeGame, opponentChoice[activeGame]);
  const opponentId = opponentPlayer?.id ?? TEAM_ID;
  const opponentName = opponentPlayer?.name ?? "Agent team";
  const opponentOptions = roster.filter((player) => player.games.includes(activeGame));
  const opponentLevel = opponentLevels[activeGame];
  // Only the team adapts to your record; what it is playing at right now.
  const opponentPlayingLevel = opponentId === TEAM_ID ? adaptedLevel(opponentLevel, score) : opponentLevel;
  // The opponent is fixed once the first move is made, until a new game.
  const gameStarted = activeGame === "chess" ? chessFen !== START_FEN
    : activeGame === "checkers" ? checkersAnimation !== null
      : activeGame === "tictactoe" ? ticBoard.some(Boolean)
        : gomokuBoard.some(Boolean);
  const chess = new Chess(chessFen);
  const chessBoard = chess.board();
  const chessLegal = chessSelection
    ? chess.moves({ square: chessSelection, verbose: true }).map((move) => move.to)
    : [];
  const chessEnded = chess.isGameOver();
  const chessInCheck = chess.inCheck();
  const chessMated = chess.isCheckmate();
  // The king of the side to move: the one in check, or checkmated.
  const checkedKing = chessInCheck
    ? chessBoard.flat().find((cell) => cell?.type === "k" && cell.color === chess.turn())?.square ?? null
    : null;
  const ticWinner = getTicTacToeWinner(ticBoard);
  const gomokuWinner = getGomokuWinner(gomokuBoard);
  const gameOver = activeGame === "chess" ? chessEnded
    : activeGame === "tictactoe" ? ticWinner !== null
        : activeGame === "gomoku" ? gomokuWinner !== null || gomokuBoard.every(Boolean)
          : result !== null;
    const decisiveGames = score.player + score.opponent;
    const playerWinRate = decisiveGames ? Math.round(score.player / decisiveGames * 100) : null;

  function finish(outcome: Exclude<Result, null>) {
    if (resultRecorded.current) return;
    resultRecorded.current = true;
    setResult(outcome);
    setScore((current) => ({
      ...current,
      player: current.player + Number(outcome === "player"),
      opponent: current.opponent + Number(outcome === "opponent"),
      draw: current.draw + Number(outcome === "draw"),
    }));
  }

  function recordMove(description: string) {
    moveHistory.current = [...moveHistory.current, description].slice(-160);
  }

  function resetGame(nextGame = activeGame) {
    session.current += 1;
    resultRecorded.current = false;
    setActiveGame(nextGame);
    setChessFen(new Chess().fen());
    setChessSelection(null);
    setLastChessMove(null);
    setChessAnimation(null);
    setTicBoard(createTicTacToeBoard());
    setCheckersBoard(createCheckersBoard());
    setCheckersTurn("r");
    setCheckersSelection(null);
    setCheckersForcedFrom(null);
    setCheckersAnimation(null);
    moveAnimationEnd.current = 0;
    setGomokuBoard(createGomokuBoard());
    setBusy(false);
    setOpponentCommentary("");
    setChatMessages([]);
    setChatInput("");
    setChatBusy(false);
    setCoachBusy(false);
    moveHistory.current = [];
    setResult(null);
    setResultDismissed(false);
    setResigned(false);
    setResignArmed(false);
    clearTimeout(resignTimer.current);
    if (!matchGames.has(nextGame)) setWatching(false);
    setMatchStatus("setup");
    setMatchOutcome(null);
    setMatchThinking(null);
    matchPosition.current = null;
    matchShouldRun.current = false;
    matchLoopActive.current = false;
  }

  function changeMode(nextWatching: boolean) {
    if (nextWatching === watching) return;
    resetGame();
    setWatching(nextWatching);
  }

  /** Plays one move of the match. Returns false when the loop should stop. */
  async function playMatchMove(game: MatchGame, turnSession: number, chosen: Record<MatchSide, RosterPlayer>, levels: Record<MatchSide, number>): Promise<boolean> {
    const position = matchPosition.current;
    if (!position) return false;
    const chess = new Chess(position.fen);
    const side: MatchSide = (game === "chess" ? chess.turn() === "w" : position.turn === "r") ? "first" : "second";
    const player = chosen[side];
    const checkersMoves = game === "checkers" ? getCheckersLegalMoves(position.board, position.turn, position.forced ?? undefined) : [];
    const legalMoves = game === "chess"
      ? chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ""}`)
      : checkersMoves.map(checkersMoveKey);
    const board = game === "chess" ? { fen: position.fen } : { board: position.board, turn: position.turn, forcedFrom: position.forced };

    setMatchThinking(side);
    let reply: { move: string; explanation: string };
    try {
      const response = await fetch("/api/opponent/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game, player: player.id, board, legalMoves, level: levels[side] }),
      });
      const data = await response.json() as { move?: string; explanation?: string; error?: string };
      if (!response.ok || !data.move) throw new Error(data.error || `${player.name} could not move.`);
      reply = { move: data.move, explanation: data.explanation ?? "" };
    } catch (error) {
      if (turnSession !== session.current) return false;
      setMatchThinking(null);
      setMatchStatus("paused");
      matchShouldRun.current = false;
      appendSystemMessage(`${error instanceof Error ? error.message : `${player.name} could not move.`} The match is paused.`);
      return false;
    }
    await untilAnimationEnds(moveAnimationEnd.current);
    if (turnSession !== session.current) return false;
    setMatchThinking(null);
    appendAgentMessage(`${sideLabel(game, side)}: ${reply.explanation}`);

    position.plies += 1;
    const moveCount = Math.ceil(position.plies / 2);
    let outcome: MatchOutcome | null = null;
    let repetitionKey: string | null = null;
    if (game === "chess") {
      const moved = chess.move({ from: reply.move.slice(0, 2), to: reply.move.slice(2, 4), promotion: reply.move[4] ?? "q" });
      position.fen = chess.fen();
      recordMove(`${player.name} played ${moved.san}.`);
      setChessFen(position.fen);
      setLastChessMove([moved.from, moved.to]);
      setChessAnimation(describeChessMove(moved));
      moveAnimationEnd.current = animationEndsAt(SLIDE_MS) + matchPauseMs.current;
      repetitionKey = position.fen.split(" ").slice(0, 4).join(" ");
      if (chess.isCheckmate()) outcome = { winner: side, reason: `by checkmate in ${moveCount} moves` };
      else if (chess.isStalemate()) outcome = { winner: null, reason: "by stalemate" };
      else if (chess.isInsufficientMaterial()) outcome = { winner: null, reason: "with too few pieces left to mate" };
      else if (chess.isDraw()) outcome = { winner: null, reason: "by the fifty-move rule" };
    } else {
      const [from, to] = reply.move.split(":").map(Number);
      const move = checkersMoves.find((candidate) => candidate.from === from && candidate.to === to)!;
      const animation = describeCheckersMove(position.board, move);
      recordMove(`${player.name} moved ${checkersCoordinate(from)} to ${checkersCoordinate(to)}${move.captured === null ? "" : " and captured a piece"}.`);
      position.board = applyCheckersMove(position.board, move);
      position.quietPlies = move.captured === null ? position.quietPlies + 1 : 0;
      const chain = move.captured === null ? [] : getCheckersLegalMoves(position.board, position.turn, move.to);
      if (chain.length) {
        position.forced = move.to;
      } else {
        position.forced = null;
        position.turn = position.turn === "r" ? "b" : "r";
        repetitionKey = position.board.map((piece) => piece ?? ".").join("") + position.turn;
        if (!getCheckersLegalMoves(position.board, position.turn).length) {
          outcome = { winner: side, reason: `after ${moveCount} moves: the other side has no move left` };
        }
      }
      setCheckersBoard(position.board);
      setCheckersTurn(position.turn);
      setCheckersForcedFrom(position.forced);
      setCheckersAnimation(animation);
      moveAnimationEnd.current = animationEndsAt(checkersAnimationMs(animation)) + matchPauseMs.current;
      if (!outcome && position.quietPlies >= CHECKERS_NO_CAPTURE_LIMIT) outcome = { winner: null, reason: `after ${CHECKERS_NO_CAPTURE_LIMIT / 2} moves without a capture` };
    }
    if (!outcome && repetitionKey) {
      const count = (position.seen.get(repetitionKey) ?? 0) + 1;
      position.seen.set(repetitionKey, count);
      if (count >= REPETITION_LIMIT) outcome = { winner: null, reason: "by repetition: the same position came up three times" };
    }
    if (!outcome && position.plies >= MATCH_MAX_PLIES) outcome = { winner: null, reason: `at the ${MATCH_MAX_PLIES / 2}-move limit` };
    if (outcome) {
      matchShouldRun.current = false;
      await untilAnimationEnds(moveAnimationEnd.current - matchPauseMs.current);
      if (turnSession === session.current) {
        setMatchOutcome(outcome);
        setMatchStatus("over");
      }
      return false;
    }
    return true;
  }

  /** Plays moves until the match ends or is paused; `once` plays a single move. */
  async function runMatch(once = false) {
    if (matchLoopActive.current || !matchGames.has(activeGame)) return;
    const game = activeGame as MatchGame;
    const first = resolveFighter(roster, game, fighters[game].first);
    const second = resolveFighter(roster, game, fighters[game].second);
    if (!first || !second) return;
    const turnSession = session.current;
    matchLoopActive.current = true;
    let keepGoing = true;
    while (keepGoing && turnSession === session.current) {
      keepGoing = await playMatchMove(game, turnSession, { first, second }, fighterLevels[game]);
      if (once || !matchShouldRun.current) break;
    }
    if (turnSession === session.current) {
      matchLoopActive.current = false;
      setMatchThinking(null);
    }
  }

  function startMatch() {
    resetGame();
    setWatching(true);
    matchPosition.current = {
      fen: new Chess().fen(),
      board: createCheckersBoard(),
      turn: "r",
      forced: null,
      plies: 0,
      quietPlies: 0,
      seen: new Map(),
    };
    matchShouldRun.current = true;
    setMatchStatus("running");
    void runMatch();
  }

  function pauseMatch() {
    matchShouldRun.current = false;
    setMatchStatus("paused");
  }

  function resumeMatch() {
    matchShouldRun.current = true;
    setMatchStatus("running");
    void runMatch();
  }

  function changeMatchSpeed(speed: MatchSpeed) {
    setMatchSpeed(speed);
    matchPauseMs.current = MATCH_PAUSE_MS[speed];
  }

  function resign() {
    clearTimeout(resignTimer.current);
    if (!resignArmed) {
      setResignArmed(true);
      resignTimer.current = setTimeout(() => setResignArmed(false), 3000);
      return;
    }
    setResignArmed(false);
    // A new session stops an agent that is still thinking from playing its move.
    session.current += 1;
    setBusy(false);
    setChessSelection(null);
    setCheckersSelection(null);
    recordMove("You resigned.");
    setResigned(true);
    finish("opponent");
  }

  function appendAgentMessage(content: string) {
    setChatMessages((messages) => [...messages, { role: "assistant" as const, content }].slice(-12));
  }

  function appendSystemMessage(content: string) {
    setChatMessages((messages) => [...messages, { role: "system" as const, content }].slice(-12));
  }

  async function sendChatMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = chatInput.trim();
    if (!question || !ollamaReady || chatBusy || busy) return;

    const requestSession = session.current;
    const nextMessages = [
      ...chatMessages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role === "user" ? "user" as const : "assistant" as const, content: message.content })),
      { role: "user" as const, content: question },
    ].slice(-12);
    setChatMessages(nextMessages);
    setChatInput("");
    setChatBusy(true);

    try {
      const response = await fetch("/api/opponent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game: activeGame,
          board: getChatBoardState(),
          lastMoveExplanation: opponentCommentary,
          messages: nextMessages,
        }),
      });
      const data = await response.json() as { reply?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "Ollama chat agent could not reply.");
      }
      if (typeof data.reply !== "string" || !data.reply.trim()) {
        throw new Error("Ollama chat agent returned an empty reply.");
      }
      if (requestSession !== session.current) return;
      appendAgentMessage(data.reply.trim());
    } catch (error) {
      if (requestSession === session.current) {
        appendSystemMessage(error instanceof Error ? error.message : "Ollama chat agent failed. Check the local Ollama setup and try again.");
      }
    } finally {
      if (requestSession === session.current) setChatBusy(false);
    }
  }

  function runOpponentTurn(
    game: GameId,
    board: unknown,
    legalMoves: string[],
    fallback: () => string | null,
    apply: (move: string) => void,
  ) {
    const turnSession = session.current;
    setBusy(true);
    setOpponentCommentary("");
    void (async () => {
      let move: string | null = null;
      let explanation = "";
      let usedEngine = false;
      let apiError = "";
      if (opponentMode === "openspiel") {
        const response = await askOpponent(opponentId, opponentLevel, game, board, legalMoves, {
          player: score.player,
          opponent: score.opponent,
          draw: score.draw,
        }).catch((error: unknown) => {
          apiError = error instanceof Error ? error.message : `${opponentName} could not return a move.`;
          return null;
        });
        if (response) {
          move = response.move;
          explanation = response.explanation;
          usedEngine = true;
        }
      }
      if (!move) {
        // One chosen agent failing doesn't mean the engine is down; it can try again next turn.
        if (opponentId === TEAM_ID) setOpponentMode("local");
        move = fallback();
        explanation = opponentId === TEAM_ID
          ? "This move was selected by the built-in local strategy. Restart the app so the OpenSpiel Strategist, Challenger, and Referee agents can play."
          : `${opponentName} could not move, so the built-in local strategy played this turn.`;
        if (apiError) appendSystemMessage(`${apiError} The game continued with the local opponent.`);
      }
      // Let the player's move finish animating before the reply appears.
      const wait = moveAnimationEnd.current - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (turnSession !== session.current) return;
      if (move && legalMoves.includes(move)) {
        setOpponentCommentary(explanation);
        if (usedEngine) appendAgentMessage(explanation);
        apply(move);
      }
      setBusy(false);
    })();
  }

  function playTicTacToe(index: number) {
    if (busy || gameOver || ticBoard[index]) return;
    const next = [...ticBoard];
    next[index] = "X";
    recordMove(`You placed X at row ${Math.floor(index / 3) + 1}, column ${(index % 3) + 1}.`);
    setTicBoard(next);
    const winner = getTicTacToeWinner(next);
    if (winner) {
      finish(winner === "X" ? "player" : winner === "O" ? "opponent" : "draw");
      return;
    }
    const legal = next.flatMap((mark, move) => mark ? [] : [String(move)]);
    runOpponentTurn("tictactoe", next, legal, () => String(chooseTicTacToeMove(next)), (move) => {
      const after = [...next];
      after[Number(move)] = "O";
      recordMove(`${opponentName} placed O at row ${Math.floor(Number(move) / 3) + 1}, column ${(Number(move) % 3) + 1}.`);
      setTicBoard(after);
      const outcome = getTicTacToeWinner(after);
      if (outcome) finish(outcome === "X" ? "player" : outcome === "O" ? "opponent" : "draw");
    });
  }

  function playChessSquare(square: Square) {
    if (watching || busy || gameOver) return;
    const move = chessSelection
      ? chess.moves({ square: chessSelection, verbose: true }).find((candidate) => candidate.to === square)
      : undefined;
    if (move) {
      const next = new Chess(chessFen);
      const playedMove = next.move({ from: move.from, to: move.to, promotion: "q" });
      recordMove(`You played ${playedMove.san}.`);
      const nextFen = next.fen();
      setChessFen(nextFen);
      setLastChessMove([move.from, move.to]);
      setChessAnimation(describeChessMove(playedMove));
      moveAnimationEnd.current = animationEndsAt(SLIDE_MS);
      setChessSelection(null);
      if (next.isCheckmate()) {
        finish("player");
        return;
      }
      if (next.isDraw()) {
        finish("draw");
        return;
      }
      const legal = next.moves({ verbose: true }).map((candidate) => `${candidate.from}${candidate.to}${candidate.promotion ?? ""}`);
      runOpponentTurn("chess", nextFen, legal, () => chooseChessMove(nextFen), (chosen) => {
        const after = new Chess(nextFen);
        const agentMove = after.move({ from: chosen.slice(0, 2), to: chosen.slice(2, 4), promotion: chosen[4] ?? "q" });
        recordMove(`${opponentName} played ${agentMove.san}.`);
        setChessFen(after.fen());
        setLastChessMove([chosen.slice(0, 2) as Square, chosen.slice(2, 4) as Square]);
        setChessAnimation(describeChessMove(agentMove));
        moveAnimationEnd.current = animationEndsAt(SLIDE_MS);
        if (after.isCheckmate()) finish("opponent");
        else if (after.isDraw()) finish("draw");
      });
      return;
    }
    const piece = chess.get(square);
    if (piece?.color === "w" && chess.turn() === "w") setChessSelection(square);
    else setChessSelection(null);
  }

  function runCheckersOpponent(initialBoard: CheckersBoard) {
    const turnSession = session.current;
    setBusy(true);
    setOpponentCommentary("");
    void (async () => {
      let board = initialBoard;
      let forcedFrom: number | undefined;
      let explanation = "";
      let usedLocalMove = false;
      let apiError = "";
      for (let step = 0; step < 12; step += 1) {
        const legal = getCheckersLegalMoves(board, "b", forcedFrom);
        if (!legal.length) break;
        const keys = legal.map(checkersMoveKey);
        const agentResponse = opponentMode === "openspiel" && !usedLocalMove
          ? await askOpponent(opponentId, opponentLevel, "checkers", { board, turn: "b", forcedFrom }, keys, {
            player: score.player,
            opponent: score.opponent,
            draw: score.draw,
          }).catch((error: unknown) => {
            apiError = error instanceof Error ? error.message : `${opponentName} could not return a move.`;
            return null;
          })
          : null;
        let chosen = agentResponse?.move ?? null;
        if (agentResponse) explanation = agentResponse.explanation;
        if (!chosen) {
          usedLocalMove = true;
          if (opponentId === TEAM_ID) setOpponentMode("local");
          const local = chooseCheckersMove(board, "b", forcedFrom);
          chosen = local ? checkersMoveKey(local) : null;
          explanation = opponentId === TEAM_ID
            ? "This move was selected by the built-in checkers strategy. Restart the app so the OpenSpiel agent team can play."
            : `${opponentName} could not move, so the built-in checkers strategy played this turn.`;
        }
        if (!chosen || turnSession !== session.current) break;
        const [from, to] = chosen.split(":").map(Number);
        const move = legal.find((candidate) => candidate.from === from && candidate.to === to);
        if (!move) break;
        // Let the previous move (the player's, or this turn's last jump) finish animating first.
        const wait = moveAnimationEnd.current - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (turnSession !== session.current) break;
        recordMove(`${usedLocalMove ? "Local opponent" : opponentName} moved ${checkersCoordinate(move.from)} to ${checkersCoordinate(move.to)}${move.captured === null ? "" : " and captured a piece"}.`);
        const animation = describeCheckersMove(board, move);
        board = applyCheckersMove(board, move);
        // Show each jump of a multi-jump as it happens.
        setCheckersBoard(board);
        setCheckersAnimation(animation);
        moveAnimationEnd.current = animationEndsAt(checkersAnimationMs(animation));
        const chain = move.captured === null ? [] : getCheckersLegalMoves(board, "b", move.to);
        if (!chain.length) break;
        forcedFrom = move.to;
      }
      if (turnSession !== session.current) return;
      setCheckersBoard(board);
      setCheckersSelection(null);
      setCheckersForcedFrom(null);
      setCheckersTurn("r");
      setOpponentCommentary(explanation);
      if (!usedLocalMove && explanation) appendAgentMessage(explanation);
      if (apiError) appendSystemMessage(`${apiError} The game continued with the local opponent.`);
      if (!getCheckersLegalMoves(board, "r").length) finish("opponent");
      setBusy(false);
    })();
  }

  function playCheckersSquare(index: number) {
    if (watching || busy || result || checkersTurn !== "r") return;
    const legal = getCheckersLegalMoves(checkersBoard, "r", checkersForcedFrom ?? undefined);
    const move = checkersSelection === null ? undefined : legal.find((candidate) => candidate.from === checkersSelection && candidate.to === index);
    if (move) {
      const next = applyCheckersMove(checkersBoard, move);
      recordMove(`You moved ${checkersCoordinate(move.from)} to ${checkersCoordinate(move.to)}${move.captured === null ? "" : " and captured a piece"}.`);
      setCheckersBoard(next);
      const animation = describeCheckersMove(checkersBoard, move);
      setCheckersAnimation(animation);
      moveAnimationEnd.current = animationEndsAt(checkersAnimationMs(animation));
      const chain = move.captured === null ? [] : getCheckersLegalMoves(next, "r", move.to);
      if (chain.length) {
        setCheckersSelection(move.to);
        setCheckersForcedFrom(move.to);
        return;
      }
      setCheckersTurn("b");
      setCheckersSelection(null);
      setCheckersForcedFrom(null);
      if (!getCheckersLegalMoves(next, "b").length) finish("player");
      else runCheckersOpponent(next);
      return;
    }
    const piece = checkersBoard[index];
    if (piece?.toLowerCase() === "r" && (checkersForcedFrom === null || index === checkersForcedFrom)) {
      setCheckersSelection(index);
    } else if (checkersForcedFrom === null) {
      setCheckersSelection(null);
    }
  }

  function playGomoku(index: number) {
    if (busy || gameOver || gomokuBoard[index]) return;
    const next = [...gomokuBoard];
    next[index] = "X";
    recordMove(`You placed X at row ${Math.floor(index / 15) + 1}, column ${(index % 15) + 1}.`);
    setGomokuBoard(next);
    if (getGomokuWinner(next) === "X") {
      finish("player");
      return;
    }
    if (next.every(Boolean)) {
      finish("draw");
      return;
    }
    const legal = next.flatMap((mark, move) => mark ? [] : [String(move)]);
    runOpponentTurn("gomoku", next, legal, () => String(chooseGomokuMove(next)), (chosen) => {
      const after = [...next];
      after[Number(chosen)] = "O";
      recordMove(`${opponentName} placed O at row ${Math.floor(Number(chosen) / 15) + 1}, column ${(Number(chosen) % 15) + 1}.`);
      setGomokuBoard(after);
      if (getGomokuWinner(after) === "O") finish("opponent");
      else if (after.every(Boolean)) finish("draw");
    });
  }

  const matchGame = activeGame as MatchGame;
  const topFighter = watching ? resolveFighter(roster, matchGame, fighters[matchGame]?.second) : undefined;
  const bottomFighter = watching ? resolveFighter(roster, matchGame, fighters[matchGame]?.first) : undefined;
  const winnerFighter = matchOutcome?.winner === "first" ? bottomFighter : matchOutcome?.winner === "second" ? topFighter : undefined;
  // In a mirror match the agent's name can't tell the sides apart.
  const winnerName = matchOutcome?.winner && (topFighter?.id === bottomFighter?.id ? sideLabel(matchGame, matchOutcome.winner) : winnerFighter?.name);
  const watchLabel = matchStatus === "over" ? "Match finished"
    : matchThinking ? `${matchThinking === "first" ? bottomFighter?.name : topFighter?.name} is thinking`
      : matchStatus === "paused" ? "Match paused"
        : matchStatus === "running" ? "Match in progress"
          : "Choose two agents";
  const mateLabel = !chessMated ? null
    : watching ? "Checkmate"
      : chess.turn() === "b" ? "Checkmate · you win"
        : `Checkmate · ${opponentName} wins`;
  // "Check!" leads the label while a king is attacked; resigning is a quiet loss.
  const checkPrefix = activeGame === "chess" && chessInCheck && !chessMated ? "Check! " : "";
  const turnLabel = activeGame === "chess" && mateLabel ? mateLabel
    : watching ? `${matchStatus === "over" ? "" : checkPrefix}${watchLabel}`
    : resigned ? "You resigned"
    : checkPrefix && !result ? `${checkPrefix}${busy ? `${opponentName} is thinking` : chess.turn() === "w" ? "Your move" : `${opponentName} to move`}`
    : result === "player" ? "You took the match"
    : result === "opponent" ? `${opponentName} wins this one`
      : result === "draw" ? "A clean draw"
        : busy ? `${opponentName} is thinking`
          : activeGame === "chess" ? (chess.turn() === "w" ? "Your move" : `${opponentName} to move`)
            : activeGame === "checkers" ? (checkersTurn === "r" ? "Your move" : `${opponentName} to move`)
                : "Your move";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="The Thinking Room home" onClick={(event) => { event.preventDefault(); resetGame("chess"); }}>
          <span className="brand-mark"><Swords size={19} strokeWidth={2.4} /></span>
          <span className="brand-name">THE THINKING<br />ROOM<span className="brand-period">.</span></span>
        </a>

        <div className="sidebar-kicker">PICK YOUR GAME</div>
        <nav className="game-nav" aria-label="Choose a game">
          {games.map(({ id, name, detail, icon: Icon, number }) => (
            <button key={id} className={`game-nav-item ${activeGame === id ? "is-active" : ""}`} onClick={() => resetGame(id)} aria-current={activeGame === id ? "page" : undefined}>
              <span className="game-nav-icon"><Icon size={18} strokeWidth={1.9} /></span>
              <span className="game-nav-copy"><span>{name}</span><small>{detail}</small></span>
              <span className="game-nav-number">{number}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-status" title={engineStatus}><span className="online-dot" /> {opponentMode === "openspiel" ? "OPENSPIEL AGENTS READY" : "LOCAL MODE ACTIVE"}</div>
        </div>
      </aside>

      <main className="main-content" id="top">
        <section className="arena" aria-label={`${currentGame.name} game` }>
          <div className="arena-header">
            <div className="arena-title-group"><div><h2>{currentGame.name}</h2><span className="arena-subtitle">{currentGame.detail.toUpperCase()}</span></div></div>
            <div className={`turn-pill ${result || matchStatus === "over" ? "turn-finished" : ""} ${activeGame === "chess" && chessInCheck ? "turn-check" : ""}`}><span className={busy || matchThinking ? "turn-spinner" : "turn-dot"}>{busy || matchThinking ? <LoaderCircle size={14} /> : null}</span>{turnLabel}</div>
            {!watching && (
              <div className="record-box" aria-label="Match record" title={opponentMode !== "openspiel" ? "The OpenSpiel engine is offline" : `${opponentName} is playing at ${LEVEL_NAMES[opponentPlayingLevel]}`}>
                <div className="record-values"><span className="record-you">{String(score.player).padStart(2, "0")}</span><span className="record-separator">:</span><span className="record-opponent">{String(score.opponent).padStart(2, "0")}</span></div>
                <span className="record-caption">{playerWinRate === null ? "50% TARGET" : `YOU ${playerWinRate}% · 50% TARGET`}{score.draw ? ` · ${score.draw} DRAW${score.draw === 1 ? "" : "S"}` : ""}</span>
              </div>
            )}
            {matchGames.has(activeGame) && (
              <div className="view-toggle" role="group" aria-label="Game mode">
                <button className={watching ? "" : "is-active"} aria-pressed={!watching} onClick={() => changeMode(false)}>YOU VS AI</button>
                <button className={watching ? "is-active" : ""} aria-pressed={watching} onClick={() => changeMode(true)}>AI VS AI</button>
              </div>
            )}
            {games3d.has(activeGame) && (
              <div className="view-toggle" role="group" aria-label="Board view">
                {(["2d", "3d"] as const).map((view) => (
                  <button key={view} className={boardView === view ? "is-active" : ""} aria-pressed={boardView === view} onClick={() => changeBoardView(view)}>{view.toUpperCase()}</button>
                ))}
              </div>
            )}
            <button className="icon-button help-button" aria-label="Game rules" title="Game rules" onClick={() => window.alert(watching
              ? `${currentGame.name}, AI vs AI: choose an agent for each side and press Start match. You watch; the agents play. These matches don't count toward your record.`
              : `${currentGame.name}: ${currentGame.detail}. You play first. Choose your opponent and difficulty above the board, then make a move to start. Both are fixed until you start a new game.`)}><CircleHelp size={17} /></button>
            <button className="reset-button" onClick={() => resetGame()} title="Start a new game"><RotateCcw size={15} /><span>New game</span></button>
          </div>

          <div className={`play-area game-${activeGame}`}>
            <div className={`board-column ${watching ? "is-watching" : ""}`}>
              {matchOutcome && !resultDismissed && (
                <div className="result-overlay">
                  <div className={`result-card ${matchOutcome.winner ? "result-player" : "result-draw"}`} role="dialog" aria-modal="false" aria-labelledby="result-title">
                    <span className="result-badge">{matchOutcome.winner ? <Trophy size={22} /> : <Handshake size={22} />}</span>
                    <div className="result-kicker"><span className="result-dash" /> MATCH OVER · {currentGame.name.toUpperCase()}</div>
                    <h2 id="result-title" className="result-title">
                      {matchOutcome.winner ? <>{winnerName} <em>wins.</em></> : <>It&apos;s a <em>draw.</em></>}
                    </h2>
                    <p className="result-copy">
                      {matchOutcome.winner ? `${sideLabel(matchGame, matchOutcome.winner)} won ${matchOutcome.reason}.` : `The match ended ${matchOutcome.reason}.`}
                    </p>
                    <div className="result-actions">
                      <button className="result-secondary" onClick={() => setResultDismissed(true)}>View board</button>
                      <button className="result-primary" onClick={startMatch} autoFocus><RotateCcw size={14} /> Rematch</button>
                    </div>
                  </div>
                </div>
              )}
              {result && !resultDismissed && (
                <div className="result-overlay">
                  <div className={`result-card result-${result}`} role="dialog" aria-modal="false" aria-labelledby="result-title">
                    <span className="result-badge">
                      {result === "player" ? <Trophy size={22} /> : result === "opponent" ? <Bot size={22} /> : <Handshake size={22} />}
                    </span>
                    <div className="result-kicker"><span className="result-dash" /> MATCH OVER · {currentGame.name.toUpperCase()}</div>
                    <h2 id="result-title" className="result-title">
                      {result === "player" ? <>You <em>win.</em></> : result === "opponent" ? <>You <em>lose.</em></> : <>It&apos;s a <em>draw.</em></>}
                    </h2>
                    <p className="result-copy">
                      {resigned ? `You resigned against ${opponentName}. Run it back?`
                        : activeGame === "chess" && chessMated && result === "player" ? `You checkmated ${opponentName}. Can you do it again?`
                          : activeGame === "chess" && chessMated && result === "opponent" ? `${opponentName} checkmated you. Run it back?`
                            : result === "player" ? `You outplayed ${opponentName}. Can you do it again?`
                              : result === "opponent" ? `${opponentName} took this one. Run it back?`
                                : "Nobody broke through this time."}
                    </p>
                    <div className="result-score" aria-label="Session score">
                      <span><b className="record-you">{String(score.player).padStart(2, "0")}</b><small>YOU</small></span>
                      <span className="record-separator">:</span>
                      <span><b className="record-opponent">{String(score.opponent).padStart(2, "0")}</b><small>AGENTS</small></span>
                    </div>
                    {ollamaReady && <p className="result-note">The Coach is reviewing your match in the chat.</p>}
                    <div className="result-actions">
                      <button className="result-secondary" onClick={() => setResultDismissed(true)}>View board</button>
                      <button className="result-primary" onClick={() => resetGame()} autoFocus><RotateCcw size={14} /> Play again</button>
                    </div>
                  </div>
                </div>
              )}
              <div className="player-bar player-top">
                {watching
                  ? <div className="player-info"><span className="avatar opponent-avatar"><Bot size={18} /></span><span className="player-name">{topFighter?.name ?? "Agent"}<span className="player-label">{matchThinking === "second" ? "THINKING…" : topFighter && `${LEVEL_NAMES[fighterLevels[matchGame].second].toUpperCase()} · ${topFighter.license.toUpperCase()}`}</span></span></div>
                  : (
                    <div className="player-info">
                      <span className="avatar opponent-avatar"><Bot size={18} /></span>
                      <span className="player-name">
                        {opponentMode === "openspiel" && opponentOptions.length
                          ? (
                            <select
                              className="opponent-select"
                              aria-label="Choose your opponent"
                              title={gameStarted ? "Start a new game to change your opponent" : opponentPlayer?.summary}
                              value={opponentId}
                              disabled={gameStarted || busy}
                              onChange={(event) => setOpponentChoice((current) => ({ ...current, [activeGame]: event.target.value }))}
                            >
                              {opponentOptions.map((player) => (
                                <option key={player.id} value={player.id} disabled={!player.available}>{player.name}{player.available ? "" : " (not installed)"}</option>
                              ))}
                            </select>
                          )
                          : "Agent team"}
                        <span className="player-label">{opponentMode !== "openspiel" ? "LOCAL GAME AI"
                          : opponentId !== TEAM_ID ? "FIXED STRENGTH"
                            : opponentPlayingLevel !== opponentLevel ? `RECORD ADAPTED IT TO ${LEVEL_NAMES[opponentPlayingLevel].toUpperCase()}`
                              : "ADAPTS TO YOUR RECORD"}</span>
                      </span>
                    </div>
                  )}
                {!watching && opponentMode === "openspiel" && opponentOptions.length > 0 && (
                  <div className="player-difficulty">
                    <DifficultySlider
                      level={opponentLevel}
                      disabled={gameStarted || busy}
                      title={gameStarted ? "Start a new game to change the difficulty" : undefined}
                      onChange={(level) => setOpponentLevels((current) => ({ ...current, [activeGame]: level }))}
                    />
                  </div>
                )}
                <span className="player-piece-label">{activeGame === "chess" || activeGame === "checkers" ? "BLACK" : "O"}</span>
              </div>

              <div className="board-stage">

              {activeGame === "chess" && boardView === "3d" && (
                <ChessBoard3D
                  fen={chessFen}
                  selected={chessSelection}
                  legalTargets={chessLegal}
                  lastMove={lastChessMove}
                  onSquareClick={playChessSquare}
                  readOnly={watching}
                  onUnavailable={() => {
                    changeBoardView("2d");
                    appendSystemMessage("The 3D board could not start on this computer, so the 2D board is shown instead.");
                  }}
                />
              )}

              {activeGame === "chess" && boardView === "2d" && (
                <div className="chess-wrap">
                  <div className="chess-coordinates chess-files-top">{"abcdefgh".split("").map((file) => <span key={file}>{file}</span>)}</div>
                  <div className="chess-board" role="grid" aria-label="Chess board">
                    {chessBoard.map((row, rowIndex) => row.map((piece, colIndex) => {
                      const square = `${"abcdefgh"[colIndex]}${8 - rowIndex}` as Square;
                      const isDark = (rowIndex + colIndex) % 2 === 1;
                      const isLegal = chessLegal.includes(square);
                      const isSelected = chessSelection === square;
                      const isLastMove = lastChessMove?.includes(square) ?? false;
                      const isCheckedKing = checkedKing === square;
                      const arriving = piece && chessAnimation?.to === square ? chessAnimation : null;
                      const capturedGlyph = chessAnimation?.capturedSquare === square ? chessAnimation.capturedGlyph : null;
                      // The arriving piece starts on its old square: offsets in squares, used by the CSS animation.
                      const slide = arriving ? {
                        "--dx": "abcdefgh".indexOf(arriving.from[0]) - colIndex,
                        "--dy": (8 - Number(arriving.from[1])) - rowIndex,
                      } as CSSProperties : undefined;
                      return (
                        <button key={square} role="gridcell" aria-label={`${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : " empty"}`} className={`chess-square ${isDark ? "square-dark" : "square-light"} ${isSelected ? "selected" : ""} ${isLastMove ? "last-move" : ""} ${arriving ? "has-arrival" : ""} ${isCheckedKing ? (chessMated ? "checkmated" : "in-check") : ""}`} onClick={() => playChessSquare(square)}>
                          {capturedGlyph && chessAnimation && <span key={`captured-${chessAnimation.id}`} aria-hidden="true" className={`chess-piece chess-captured ${chessAnimation.capturedColor === "w" ? "piece-white" : "piece-black"}`}>{capturedGlyph}</span>}
                          {piece && <span key={arriving ? `move-${arriving.id}` : "piece"} style={slide} className={`chess-piece ${piece.color === "w" ? "piece-white" : "piece-black"} ${arriving ? "arriving" : ""} ${isCheckedKing && chessMated ? "toppled" : ""}`}>{pieceGlyphs[`${piece.color}${piece.type}`]}</span>}
                          {isLegal && <span className={`legal-marker ${piece ? "legal-capture" : ""}`} />}
                          {colIndex === 0 && <span className="rank-label">{8 - rowIndex}</span>}
                        </button>
                      );
                    }))}
                  </div>
                  <div className="chess-coordinates chess-files-bottom">{"abcdefgh".split("").map((file) => <span key={file}>{file}</span>)}</div>
                </div>
              )}

              {activeGame === "tictactoe" && <div className="tic-board" role="grid" aria-label="Tic-tac-toe board">{ticBoard.map((mark, index) => <button key={index} className={`tic-cell ${mark ? `mark-${mark.toLowerCase()}` : ""}`} aria-label={`Square ${index + 1}${mark ? ` ${mark}` : " empty"}`} disabled={Boolean(mark) || busy || gameOver} onClick={() => playTicTacToe(index)}>{mark && <span>{mark}</span>}</button>)}</div>}

              {activeGame === "checkers" && <div className="checkers-board" role="grid" aria-label="Checkers board">{checkersBoard.map((piece, index) => {
                const darkSquare = (Math.floor(index / 8) + index % 8) % 2 === 1;
                const legal = checkersTurn === "r" && getCheckersLegalMoves(checkersBoard, "r", checkersForcedFrom ?? undefined).some((move) => move.from === checkersSelection && move.to === index);
                const arriving = piece && checkersAnimation?.to === index ? checkersAnimation : null;
                const captured = !piece && checkersAnimation?.captured === index ? checkersAnimation.capturedPiece : null;
                // The arriving piece starts on its old square: offsets in squares, used by the CSS animation.
                const slide = arriving ? { "--dx": arriving.from % 8 - index % 8, "--dy": Math.floor(arriving.from / 8) - Math.floor(index / 8) } as CSSProperties : undefined;
                return <button key={index} className={`checkers-square ${darkSquare ? "checkers-dark" : "checkers-light"} ${checkersSelection === index ? "selected" : ""} ${legal ? "can-move" : ""} ${arriving ? "has-arrival" : ""}`} aria-label={`Row ${Math.floor(index / 8) + 1}, column ${index % 8 + 1}${piece ? ` ${piece.toLowerCase() === "r" ? "red" : "black"} piece` : ""}`} onClick={() => playCheckersSquare(index)}>
                  {piece && <span key={arriving ? `move-${arriving.id}` : "piece"} style={slide} className={`checker-piece checker-${piece.toLowerCase()} ${piece === piece.toUpperCase() ? "is-king" : ""} ${arriving ? `arriving ${arriving.captured === null ? "" : "jumping"} ${arriving.crowned ? "crowned" : ""}` : ""}`}>{piece === "R" || piece === "B" ? <Crown size={16} /> : null}</span>}
                  {captured && checkersAnimation && <span key={`captured-${checkersAnimation.id}`} aria-hidden="true" className={`checker-piece checker-${captured.toLowerCase()} checker-captured`}>{captured === "R" || captured === "B" ? <Crown size={16} /> : null}</span>}
                </button>;
              })}</div>}

              {activeGame === "gomoku" && <div className="gomoku-board" role="grid" aria-label="Gomoku board">{gomokuBoard.map((mark, index) => <button key={index} className={`gomoku-point ${mark ? `mark-${mark.toLowerCase()}` : ""}`} aria-label={`Intersection ${Math.floor(index / 15) + 1}, ${index % 15 + 1}${mark ? ` ${mark}` : " empty"}`} disabled={busy || gameOver || Boolean(mark)} onClick={() => playGomoku(index)}>{mark && <span />}</button>)}</div>}
              </div>

              <div className="player-bar player-bottom">
                {watching
                  ? <div className="player-info"><span className="avatar opponent-avatar"><Bot size={18} /></span><span className="player-name">{bottomFighter?.name ?? "Agent"}<span className="player-label">{matchThinking === "first" ? "THINKING…" : bottomFighter && `${LEVEL_NAMES[fighterLevels[matchGame].first].toUpperCase()} · ${bottomFighter.license.toUpperCase()}`}</span></span></div>
                  : <div className="player-info"><span className="avatar user-avatar"><UserRound size={17} /></span><span className="player-name">You</span></div>}
                {!watching && gameStarted && !result && (
                  <button className={`resign-button ${resignArmed ? "is-armed" : ""}`} onClick={resign} title="Give up this game. It counts as a loss.">
                    <Flag size={13} /> {resignArmed ? "Click again to resign" : "Resign"}
                  </button>
                )}
                <span className="player-piece-label">{activeGame === "chess" ? "WHITE" : activeGame === "checkers" ? "RED" : "X"}</span>
              </div>
            </div>

            <aside className="match-panel">
              {watching && (
                <AgentMatchPanel
                  game={matchGame}
                  players={roster}
                  fighters={fighters[matchGame]}
                  levels={fighterLevels[matchGame]}
                  status={matchStatus}
                  speed={matchSpeed}
                  thinking={matchThinking !== null}
                  engineReady={opponentMode === "openspiel"}
                  onChoose={(side, id) => setFighters((current) => ({ ...current, [matchGame]: { ...current[matchGame], [side]: id } }))}
                  onLevel={(side, level) => setFighterLevels((current) => ({ ...current, [matchGame]: { ...current[matchGame], [side]: level } }))}
                  onSpeed={changeMatchSpeed}
                  onStart={startMatch}
                  onPause={pauseMatch}
                  onResume={resumeMatch}
                  onStep={() => void runMatch(true)}
                />
              )}
              <section className="chat-interface" aria-label="Chat with Ollama about the game">
                <div className="chat-heading">
                  <span><MessageSquareText size={15} /> CHAT WITH OLLAMA</span>
                  <small className={ollamaReady ? "chat-connected" : "chat-disconnected"}>{ollamaReady ? "MODEL READY" : ollamaRunning ? "MODEL MISSING" : "OLLAMA OFFLINE"}</small>
                </div>
                <div ref={chatLog} className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
                  {chatMessages.length === 0
                    ? <p className="chat-empty">{watching ? "Each agent's reasoning appears here as the match plays." : ollamaReady ? `Ask about the board or why ${opponentName} chose its move.` : `The OpenSpiel agents explain their moves here. ${ollamaStatus}.`}</p>
                    : chatMessages.map((message, index) => (
                        <div key={`${message.role}-${index}`} className={`chat-message ${message.role === "user" ? "chat-user" : message.role === "system" ? "chat-system" : message.role === "coach" ? "chat-coach" : "chat-assistant"}`}>
                        <span>{message.role === "user" ? "YOU" : message.role === "system" ? "NOTICE" : message.role === "coach" ? "COACH" : "AGENTS"}</span>
                        <p>{message.content}</p>
                      </div>
                    ))}
                  {(chatBusy || coachBusy) && <p className="chat-typing">{coachBusy ? "Coach is reviewing your match..." : "Ollama Conversational agent is replying..."}</p>}
                </div>
                <form className="chat-form" onSubmit={sendChatMessage}>
                  <input
                    aria-label="Message Ollama"
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    placeholder={ollamaReady ? "Ask about the game..." : ollamaRunning ? "Download the chat model to start chatting" : "Start Ollama to chat"}
                    maxLength={1000}
                    disabled={!ollamaReady || chatBusy || busy}
                  />
                  <button type="submit" aria-label="Send message" title="Send message" disabled={!chatInput.trim() || !ollamaReady || chatBusy || busy}>
                    {chatBusy ? <LoaderCircle size={15} className="chat-send-spinner" /> : <Send size={15} />}
                  </button>
                </form>
              </section>
            </aside>
          </div>
        </section>
      </main>
    </div>
  );
}