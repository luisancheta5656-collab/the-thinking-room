"use client";

import { Chess, type Move, type Square } from "chess.js";
import {
  Blocks,
  Bot,
  CircleHelp,
  Crown,
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

type AgentMove = { move: string; explanation: string };
type AgentScore = { player: number; opponent: number; draw: number };

async function askAgentTeam(game: GameId, board: unknown, legalMoves: string[], sessionScore: AgentScore): Promise<AgentMove | null> {
  const response = await fetch("/api/opponent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game, board, legalMoves, sessionScore }),
  });
  if (!response.ok) {
    const data = await response.json() as { error?: unknown };
    throw new Error(typeof data.error === "string" ? data.error : "The OpenSpiel agents could not return a move.");
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
  const [score, setScore] = useState({ player: 0, opponent: 0, draw: 0 });
  const session = useRef(0);
  const resultRecorded = useRef(false);
  const coachRequestedForSession = useRef(-1);
  const moveHistory = useRef<string[]>([]);
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
  const chess = new Chess(chessFen);
  const chessBoard = chess.board();
  const chessLegal = chessSelection
    ? chess.moves({ square: chessSelection, verbose: true }).map((move) => move.to)
    : [];
  const chessEnded = chess.isGameOver();
  const ticWinner = getTicTacToeWinner(ticBoard);
  const gomokuWinner = getGomokuWinner(gomokuBoard);
  const gameOver = activeGame === "chess" ? chessEnded
    : activeGame === "tictactoe" ? ticWinner !== null
        : activeGame === "gomoku" ? gomokuWinner !== null || gomokuBoard.every(Boolean)
          : result !== null;
    const decisiveGames = score.player + score.opponent;
    const playerWinRate = decisiveGames ? Math.round(score.player / decisiveGames * 100) : null;
    const balanceDifference = score.player - score.opponent;
    const challengeLabel = opponentMode !== "openspiel" ? "ENGINE OFFLINE"
      : balanceDifference >= 2 ? "CHALLENGE RISING"
        : balanceDifference <= -2 ? "CHALLENGE EASING"
          : "CHALLENGE BALANCED";

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
        const response = await askAgentTeam(game, board, legalMoves, {
          player: score.player,
          opponent: score.opponent,
          draw: score.draw,
        }).catch((error: unknown) => {
          apiError = error instanceof Error ? error.message : "The OpenSpiel agent team could not return a move.";
          return null;
        });
        if (response) {
          move = response.move;
          explanation = response.explanation;
          usedEngine = true;
        }
      }
      if (!move) {
        setOpponentMode("local");
        move = fallback();
        explanation = "This move was selected by the built-in local strategy. Restart the app so the OpenSpiel Strategist, Challenger, and Referee agents can play.";
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
      recordMove(`Opponent placed O at row ${Math.floor(Number(move) / 3) + 1}, column ${(Number(move) % 3) + 1}.`);
      setTicBoard(after);
      const outcome = getTicTacToeWinner(after);
      if (outcome) finish(outcome === "X" ? "player" : outcome === "O" ? "opponent" : "draw");
    });
  }

  function playChessSquare(square: Square) {
    if (busy || gameOver) return;
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
        recordMove(`Agent team played ${agentMove.san}.`);
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
          ? await askAgentTeam("checkers", { board, turn: "b", forcedFrom }, keys, {
            player: score.player,
            opponent: score.opponent,
            draw: score.draw,
          }).catch((error: unknown) => {
            apiError = error instanceof Error ? error.message : "The OpenSpiel agent team could not return a move.";
            return null;
          })
          : null;
        let chosen = agentResponse?.move ?? null;
        if (agentResponse) explanation = agentResponse.explanation;
        if (!chosen) {
          usedLocalMove = true;
          setOpponentMode("local");
          const local = chooseCheckersMove(board, "b", forcedFrom);
          chosen = local ? checkersMoveKey(local) : null;
          explanation = "This move was selected by the built-in checkers strategy. Restart the app so the OpenSpiel agent team can play.";
        }
        if (!chosen || turnSession !== session.current) break;
        const [from, to] = chosen.split(":").map(Number);
        const move = legal.find((candidate) => candidate.from === from && candidate.to === to);
        if (!move) break;
        // Let the previous move (the player's, or this turn's last jump) finish animating first.
        const wait = moveAnimationEnd.current - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (turnSession !== session.current) break;
        recordMove(`${usedLocalMove ? "Local opponent" : "Agent team"} moved ${checkersCoordinate(move.from)} to ${checkersCoordinate(move.to)}${move.captured === null ? "" : " and captured a piece"}.`);
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
    if (busy || result || checkersTurn !== "r") return;
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
      recordMove(`Agent team placed O at row ${Math.floor(Number(chosen) / 15) + 1}, column ${(Number(chosen) % 15) + 1}.`);
      setGomokuBoard(after);
      if (getGomokuWinner(after) === "O") finish("opponent");
      else if (after.every(Boolean)) finish("draw");
    });
  }

  const turnLabel = result === "player" ? "You took the match"
    : result === "opponent" ? "Agent team wins this one"
      : result === "draw" ? "A clean draw"
        : busy ? "Agents are thinking"
          : activeGame === "chess" ? (chess.turn() === "w" ? "Your move" : "Agent team to move")
            : activeGame === "checkers" ? (checkersTurn === "r" ? "Your move" : "Agent team to move")
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
            <div className={`turn-pill ${result ? "turn-finished" : ""}`}><span className={busy ? "turn-spinner" : "turn-dot"}>{busy ? <LoaderCircle size={14} /> : null}</span>{turnLabel}</div>
            <div className="record-box" aria-label="Match record" title={`Adaptive level: ${challengeLabel.toLowerCase()}`}>
              <div className="record-values"><span className="record-you">{String(score.player).padStart(2, "0")}</span><span className="record-separator">:</span><span className="record-opponent">{String(score.opponent).padStart(2, "0")}</span></div>
              <span className="record-caption">{playerWinRate === null ? "50% TARGET" : `YOU ${playerWinRate}% · 50% TARGET`}{score.draw ? ` · ${score.draw} DRAW${score.draw === 1 ? "" : "S"}` : ""}</span>
            </div>
            {games3d.has(activeGame) && (
              <div className="view-toggle" role="group" aria-label="Board view">
                {(["2d", "3d"] as const).map((view) => (
                  <button key={view} className={boardView === view ? "is-active" : ""} aria-pressed={boardView === view} onClick={() => changeBoardView(view)}>{view.toUpperCase()}</button>
                ))}
              </div>
            )}
            <button className="icon-button help-button" aria-label="Game rules" title="Game rules" onClick={() => window.alert(`${currentGame.name}: ${currentGame.detail}. You play first. Make a move on the board to challenge the OpenSpiel agent team.`)}><CircleHelp size={17} /></button>
            <button className="reset-button" onClick={() => resetGame()} title="Start a new game"><RotateCcw size={15} /><span>New game</span></button>
          </div>

          <div className={`play-area game-${activeGame}`}>
            <div className="board-column">
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
                      {result === "player" ? "You outplayed the agent team. Can you do it again?"
                        : result === "opponent" ? "The agent team took this one. Run it back?"
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
                <div className="player-info"><span className="avatar opponent-avatar"><Bot size={18} /></span><span className="player-name">Agent team<span className="player-label">{opponentMode === "openspiel" ? "3 OPENSPIEL AGENTS" : "LOCAL GAME AI"}</span></span></div>
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
                      const arriving = piece && chessAnimation?.to === square ? chessAnimation : null;
                      const capturedGlyph = chessAnimation?.capturedSquare === square ? chessAnimation.capturedGlyph : null;
                      // The arriving piece starts on its old square: offsets in squares, used by the CSS animation.
                      const slide = arriving ? {
                        "--dx": "abcdefgh".indexOf(arriving.from[0]) - colIndex,
                        "--dy": (8 - Number(arriving.from[1])) - rowIndex,
                      } as CSSProperties : undefined;
                      return (
                        <button key={square} role="gridcell" aria-label={`${square}${piece ? ` ${piece.color === "w" ? "white" : "black"} ${piece.type}` : " empty"}`} className={`chess-square ${isDark ? "square-dark" : "square-light"} ${isSelected ? "selected" : ""} ${isLastMove ? "last-move" : ""} ${arriving ? "has-arrival" : ""}`} onClick={() => playChessSquare(square)}>
                          {capturedGlyph && chessAnimation && <span key={`captured-${chessAnimation.id}`} aria-hidden="true" className={`chess-piece chess-captured ${chessAnimation.capturedColor === "w" ? "piece-white" : "piece-black"}`}>{capturedGlyph}</span>}
                          {piece && <span key={arriving ? `move-${arriving.id}` : "piece"} style={slide} className={`chess-piece ${piece.color === "w" ? "piece-white" : "piece-black"} ${arriving ? "arriving" : ""}`}>{pieceGlyphs[`${piece.color}${piece.type}`]}</span>}
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
                <div className="player-info"><span className="avatar user-avatar"><UserRound size={17} /></span><span className="player-name">You</span></div>
                <span className="player-piece-label">{activeGame === "chess" ? "WHITE" : activeGame === "checkers" ? "RED" : "X"}</span>
              </div>
            </div>

            <aside className="match-panel">
              <section className="chat-interface" aria-label="Chat with Ollama about the game">
                <div className="chat-heading">
                  <span><MessageSquareText size={15} /> CHAT WITH OLLAMA</span>
                  <small className={ollamaReady ? "chat-connected" : "chat-disconnected"}>{ollamaReady ? "MODEL READY" : ollamaRunning ? "MODEL MISSING" : "OLLAMA OFFLINE"}</small>
                </div>
                <div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions text">
                  {chatMessages.length === 0
                    ? <p className="chat-empty">{ollamaReady ? "Ask about the board or why the agent team chose its move." : `The OpenSpiel agents explain their moves here. ${ollamaStatus}.`}</p>
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
                    placeholder={ollamaReady ? "Ask the agent team about the game..." : ollamaRunning ? "Download the chat model to start chatting" : "Start Ollama to chat"}
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