"""Raven Checkers' agent (MIT-0, engine/vendor/raven) on The Thinking Room's board.

Raven plays English draughts, where crowning ends a turn; this app's rules let a
new king keep jumping. So Raven only ever picks among the app's legal moves, one
jump at a time, and its search treats later positions by its own rules.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor", "raven"))

import ai.games as raven_search  # noqa: E402
from game.checkers import Checkerboard, Checkers  # noqa: E402
from util.globalconst import BLACK, KING, MAN, WHITE, create_grid_map  # noqa: E402

# Both boards put the side that moves up the board at the bottom: Raven's black is this app's red.
_TO_RAVEN = {row * 8 + col: square for square, (row, col) in create_grid_map().items()}
_FROM_RAVEN = {square: index for index, square in _TO_RAVEN.items()}
_PIECES = {"r": BLACK | MAN, "R": BLACK | KING, "b": WHITE | MAN, "B": WHITE | KING}


def _load(cells: list, turn: str) -> Checkerboard:
    board = Checkerboard()
    board.clear()
    for index, square in _TO_RAVEN.items():
        if cells[index]:
            board.squares[square] = _PIECES[cells[index]]
    board.to_move = BLACK if turn == "r" else WHITE
    board.update_piece_count()
    return board


def _first_step(move) -> str:
    """The app's "from:to" for a Raven move's first step (a capture lists the jumped piece second)."""
    squares = move.affected_squares
    target = squares[1][0] if len(squares) == 2 else squares[2][0]
    return f"{_FROM_RAVEN[squares[0][0]]}:{_FROM_RAVEN[target]}"


class _RestrictedRoot(Checkers):
    """Raven's game with the first move of each search limited to the app's legal moves."""

    def __init__(self, board: Checkerboard, root_moves: list):
        super().__init__()
        self.curr_state = board
        self.root_moves = root_moves
        self.at_root = True

    def legal_moves(self, curr_state=None):
        if self.at_root:
            self.at_root = False
            return self.root_moves
        return super().legal_moves(curr_state)


def choose(cells: list, turn: str, legal_moves: list[str], max_depth: int, seconds: float) -> tuple[str, str]:
    """Returns the chosen legal move and a short description of how Raven picked it."""
    board = _load(cells, turn)
    captures = board.captures
    moves = captures or board.moves
    legal = set(legal_moves)
    root_moves = [move for move in moves if _first_step(move) in legal]
    if not root_moves:
        return legal_moves[0], "no move under its own rules, so it took the first legal move"
    if len(root_moves) == 1:
        return _first_step(root_moves[0]), "its only move"
    if captures:
        # Raven always takes the longest capture without searching.
        return _first_step(max(root_moves, key=lambda move: len(move.affected_squares))), "the longest capture"

    # Iterative deepening, as in Raven's own controller. A search can't stop midway,
    # so only start another depth if it is likely to finish in the time left.
    start = time.monotonic()
    best, reached = root_moves[0], 0
    for depth in range(1, max_depth + 1):
        began = time.monotonic()
        game = _RestrictedRoot(board, root_moves)
        best = raven_search.alphabeta_search(board, game, depth)
        reached = depth
        now = time.monotonic()
        if (now - start) + (now - began) * 4 > seconds:
            break
    return _first_step(best), f"alpha-beta, depth {reached}"
