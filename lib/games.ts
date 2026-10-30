import { Chess } from "chess.js";

export type Mark = "X" | "O" | "";
export type CheckersPiece = "r" | "R" | "b" | "B" | null;
export type CheckersBoard = CheckersPiece[];
export type CheckersMove = { from: number; to: number; captured: number | null };

export const createTicTacToeBoard = (): Mark[] => Array<Mark>(9).fill("");
export const createGomokuBoard = (): Mark[] => Array<Mark>(225).fill("");

export function createCheckersBoard(): CheckersBoard {
  const board: CheckersBoard = Array<CheckersPiece>(64).fill(null);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if ((row + col) % 2 === 1) board[row * 8 + col] = "b";
    }
  }
  for (let row = 5; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      if ((row + col) % 2 === 1) board[row * 8 + col] = "r";
    }
  }
  return board;
}

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export function getTicTacToeWinner(board: Mark[]): Mark | "draw" | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return board.every(Boolean) ? "draw" : null;
}

export function chooseTicTacToeMove(board: Mark[]): number {
  const minimax = (position: Mark[], player: "X" | "O", depth: number): number => {
    const winner = getTicTacToeWinner(position);
    if (winner === "O") return 10 - depth;
    if (winner === "X") return depth - 10;
    if (winner === "draw") return 0;

    let best = player === "O" ? -Infinity : Infinity;
    for (let index = 0; index < position.length; index += 1) {
      if (position[index]) continue;
      position[index] = player;
      const score = minimax(position, player === "O" ? "X" : "O", depth + 1);
      position[index] = "";
      best = player === "O" ? Math.max(best, score) : Math.min(best, score);
    }
    return best;
  };

  let bestIndex = -1;
  let bestScore = -Infinity;
  for (let index = 0; index < board.length; index += 1) {
    if (board[index]) continue;
    board[index] = "O";
    const score = minimax(board, "X", 1);
    board[index] = "";
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function checkersCaptures(board: CheckersBoard, from: number): CheckersMove[] {
  const piece = board[from];
  if (!piece) return [];
  const row = Math.floor(from / 8);
  const col = from % 8;
  const isKing = piece === "R" || piece === "B";
  const forward = piece.toLowerCase() === "r" ? -1 : 1;
  const directions = isKing ? [-1, 1] : [forward];
  const moves: CheckersMove[] = [];
  for (const dr of directions) {
    for (const dc of [-1, 1]) {
      const nextRow = row + dr * 2;
      const nextCol = col + dc * 2;
      const middleRow = row + dr;
      const middleCol = col + dc;
      if (nextRow < 0 || nextRow > 7 || nextCol < 0 || nextCol > 7) continue;
      const middle = board[middleRow * 8 + middleCol];
      const target = nextRow * 8 + nextCol;
      if (middle && middle.toLowerCase() !== piece.toLowerCase() && !board[target]) {
        moves.push({ from, to: target, captured: middleRow * 8 + middleCol });
      }
    }
  }
  return moves;
}

export function getCheckersLegalMoves(board: CheckersBoard, player: "r" | "b", forcedFrom?: number): CheckersMove[] {
  const moves: CheckersMove[] = [];
  const fromIndexes = forcedFrom === undefined
    ? board.flatMap((piece, index) => piece?.toLowerCase() === player ? [index] : [])
    : [forcedFrom];
  for (const from of fromIndexes) {
    const piece = board[from];
    if (!piece) continue;
    moves.push(...checkersCaptures(board, from));
  }
  if (moves.length || forcedFrom !== undefined) return moves;

  for (const from of fromIndexes) {
    const piece = board[from];
    if (!piece) continue;
    const row = Math.floor(from / 8);
    const col = from % 8;
    const directions = piece === "R" || piece === "B" ? [-1, 1] : [player === "r" ? -1 : 1];
    for (const dr of directions) {
      for (const dc of [-1, 1]) {
        const nextRow = row + dr;
        const nextCol = col + dc;
        if (nextRow >= 0 && nextRow < 8 && nextCol >= 0 && nextCol < 8) {
          const to = nextRow * 8 + nextCol;
          if (!board[to]) moves.push({ from, to, captured: null });
        }
      }
    }
  }
  return moves;
}

export function applyCheckersMove(board: CheckersBoard, move: CheckersMove): CheckersBoard {
  const next = [...board];
  let piece = next[move.from];
  next[move.from] = null;
  if (move.captured !== null) next[move.captured] = null;
  const row = Math.floor(move.to / 8);
  if (piece === "r" && row === 0) piece = "R";
  if (piece === "b" && row === 7) piece = "B";
  next[move.to] = piece;
  return next;
}

export function chooseCheckersMove(board: CheckersBoard, player: "r" | "b", forcedFrom?: number): CheckersMove | null {
  const moves = getCheckersLegalMoves(board, player, forcedFrom);
  if (!moves.length) return null;
  return moves.reduce((best, move) => {
    const score = (move.captured === null ? 0 : 10) +
      (player === "b" && Math.floor(move.to / 8) === 7 ? 8 : 0) +
      (player === "r" && Math.floor(move.to / 8) === 0 ? 8 : 0) +
      (3.5 - Math.abs(3.5 - move.to % 8));
    const bestScore = (best.captured === null ? 0 : 10) +
      (player === "b" && Math.floor(best.to / 8) === 7 ? 8 : 0) +
      (player === "r" && Math.floor(best.to / 8) === 0 ? 8 : 0) +
      (3.5 - Math.abs(3.5 - best.to % 8));
    return score > bestScore ? move : best;
  });
}

export function getGomokuWinner(board: Mark[]): Mark | null {
  for (let index = 0; index < board.length; index += 1) {
    const mark = board[index];
    if (!mark) continue;
    const row = Math.floor(index / 15);
    const col = index % 15;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let count = 1;
      for (const direction of [-1, 1]) {
        let nextRow = row + dr * direction;
        let nextCol = col + dc * direction;
        while (nextRow >= 0 && nextRow < 15 && nextCol >= 0 && nextCol < 15 && board[nextRow * 15 + nextCol] === mark) {
          count += 1;
          nextRow += dr * direction;
          nextCol += dc * direction;
        }
      }
      if (count >= 5) return mark;
    }
  }
  return null;
}

function gomokuShapeScore(board: Mark[], index: number, mark: Mark): number {
  const row = Math.floor(index / 15);
  const col = index % 15;
  let total = 0;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1;
    let open = 0;
    for (const direction of [-1, 1]) {
      let nextRow = row + dr * direction;
      let nextCol = col + dc * direction;
      while (nextRow >= 0 && nextRow < 15 && nextCol >= 0 && nextCol < 15 && board[nextRow * 15 + nextCol] === mark) {
        count += 1;
        nextRow += dr * direction;
        nextCol += dc * direction;
      }
      if (nextRow >= 0 && nextRow < 15 && nextCol >= 0 && nextCol < 15 && !board[nextRow * 15 + nextCol]) open += 1;
    }
    total += count >= 5 ? 100000 : count === 4 ? (open === 2 ? 12000 : 2500) : count === 3 ? (open === 2 ? 700 : 90) : count === 2 ? (open === 2 ? 70 : 12) : 1;
  }
  return total;
}

export function chooseGomokuMove(board: Mark[]): number {
  if (board.every((cell) => !cell)) return 112;
  const candidates = new Set<number>();
  for (let index = 0; index < board.length; index += 1) {
    if (board[index]) continue;
    const row = Math.floor(index / 15);
    const col = index % 15;
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < 15 && c >= 0 && c < 15 && board[r * 15 + c]) candidates.add(index);
      }
    }
  }
  let bestIndex = -1;
  let bestScore = -Infinity;
  for (const index of candidates) {
    board[index] = "O";
    const attack = gomokuShapeScore(board, index, "O");
    board[index] = "X";
    const defense = gomokuShapeScore(board, index, "X");
    board[index] = "";
    const score = attack + defense * 0.92;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function chooseChessMove(fen: string): string | null {
  const game = new Chess(fen);
  const moves = game.moves({ verbose: true });
  if (!moves.length) return null;
  const values: Record<string, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
  const evaluate = (position: Chess): number => position.board().reduce((score, row) =>
    score + row.reduce((rowScore, piece) => {
      if (!piece) return rowScore;
      const value = values[piece.type] ?? 0;
      return rowScore + (piece.color === "w" ? value : -value);
    }, 0), 0);

  let bestMove: string | null = null;
  let bestScore = Infinity;
  for (const move of moves) {
    const candidate = new Chess(fen);
    candidate.move({ from: move.from, to: move.to, promotion: move.promotion });
    if (candidate.isCheckmate()) return `${move.from}${move.to}${move.promotion ?? ""}`;
    let score = evaluate(candidate);
    const replies = candidate.moves({ verbose: true });
    if (replies.length) {
      score = -Infinity;
      for (const reply of replies) {
        const response = new Chess(candidate.fen());
        response.move({ from: reply.from, to: reply.to, promotion: reply.promotion });
        const responseScore = response.isCheckmate() ? 100000 : evaluate(response);
        score = Math.max(score, responseScore);
      }
    }
    if (score < bestScore) {
      bestScore = score;
      bestMove = `${move.from}${move.to}${move.promotion ?? ""}`;
    }
  }
  return bestMove;
}
