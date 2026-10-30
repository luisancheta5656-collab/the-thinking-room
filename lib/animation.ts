// Board move-animation timings, in milliseconds. Used by app/page.tsx (to time the
// opponent's reply), components/ChessBoard3D.tsx, and the matching CSS animations in
// app/globals.css, whose durations must be kept equal to these.

/** A piece sliding to its square: a checkers step and every chess move. */
export const SLIDE_MS = 480;
/** A checkers capture: the piece jumps in an arc over the taken piece. */
export const JUMP_MS = 650;
/** A new checkers king's glow, after it lands. */
export const KING_GLOW_MS = 1000;
/** A captured chess piece shrinks away as the attacker lands on it. */
export const CHESS_CAPTURED_DELAY_MS = 150;
export const CHESS_CAPTURED_MS = 330;
/** Pause between one move landing and the next starting. */
export const MOVE_GAP_MS = 120;
