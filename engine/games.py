"""Adapters that rebuild The Thinking Room's boards as OpenSpiel states.

Chess, tic-tac-toe and Gomoku use OpenSpiel's built-in games.
Checkers is registered as a Python OpenSpiel game because the built-in one
cannot be loaded from a custom position and uses different crowning rules.

The agent team plays O, black or black. That is OpenSpiel player 1 in every
game except chess, where OpenSpiel numbers black as player 0.
"""

from __future__ import annotations

import math

import pyspiel

class EngineError(ValueError):
    """The request cannot be mapped onto an OpenSpiel state."""


class Adapter:
    """Per-game glue between the app's board format and a pyspiel state."""

    name = ""
    game: pyspiel.Game
    # OpenSpiel player id of the agent team.
    agent = 1
    # MCTS leaf evaluation: random rollouts (cheap C++ games) or the heuristic.
    rollouts = False
    # Use PUCT with heuristic priors instead of plain UCT.
    informed_priors = False
    # challenge mode -> (MCTS simulations, alpha-beta depth)
    budgets: dict[str, tuple[int, int]] = {}

    def build(self, board) -> pyspiel.State:
        raise NotImplementedError

    def move_to_action(self, state: pyspiel.State, move: str) -> int:
        try:
            return int(move)
        except ValueError as error:
            raise EngineError(f"Unrecognized move {move!r}.") from error

    def describe(self, state: pyspiel.State, action: int) -> str:
        return str(action)

    def candidates(self, state: pyspiel.State) -> list[int]:
        """Actions worth searching, best-first. Defaults to every legal action."""
        return state.legal_actions()

    def priors(self, state: pyspiel.State, actions: list[int]) -> list[tuple[int, float]]:
        share = 1.0 / len(actions)
        return [(action, share) for action in actions]

    def evaluate(self, state: pyspiel.State, player: int) -> float:
        """Heuristic value in (-1, 1) of a non-terminal state for `player`."""
        return 0.0


def _marks(board, size: int) -> list[str]:
    if not isinstance(board, list) or len(board) != size or any(mark not in ("X", "O", "") for mark in board):
        raise EngineError(f"Expected a board of {size} cells containing X, O or empty strings.")
    return board


def _replay_alternating(game: pyspiel.Game, cells: list[str]) -> pyspiel.State:
    """Rebuild a placement game by alternating X and O stones in any order.

    Every prefix of the replay is a subset of the final (unfinished) position,
    so no intermediate state can already be won.
    """
    xs = [index for index, mark in enumerate(cells) if mark == "X"]
    os = [index for index, mark in enumerate(cells) if mark == "O"]
    if len(xs) != len(os) + 1:
        raise EngineError("It must be the agent team's turn (one more X than O).")
    state = game.new_initial_state()
    try:
        for x, o in zip(xs, os):
            state.apply_action(x)
            state.apply_action(o)
        state.apply_action(xs[-1])
    except pyspiel.SpielError as error:
        raise EngineError(f"The board is not a reachable position: {error}") from error
    if state.is_terminal():
        raise EngineError("The game is already over.")
    return state


class TicTacToe(Adapter):
    name = "tictactoe"
    rollouts = True
    budgets = {"eased": (40, 1), "balanced": (400, 9), "increased": (1500, 9)}

    def __init__(self):
        self.game = pyspiel.load_game("tic_tac_toe")

    def build(self, board):
        return _replay_alternating(self.game, _marks(board, 9))

    def describe(self, state, action):
        return f"row {action // 3 + 1}, column {action % 3 + 1}"


GOMOKU_SIZE = 15
_GOMOKU_PATTERNS = (
    (".pppp.", 12000),
    ("pppp.", 1500), (".pppp", 1500), ("pp.pp", 1500), ("ppp.p", 1500), ("p.ppp", 1500),
    (".ppp.", 700), (".pp.p.", 500), (".p.pp.", 500),
    ("ppp..", 80), ("..ppp", 80),
    (".pp.", 30),
)


def _gomoku_cells(state: pyspiel.State) -> list[str]:
    rows = [line for line in str(state).splitlines() if len(line) == GOMOKU_SIZE]
    return list("".join(rows[-GOMOKU_SIZE:]))


def _gomoku_lines(cells: list[str]) -> list[str]:
    n = GOMOKU_SIZE
    lines = ["".join(cells[row * n:(row + 1) * n]) for row in range(n)]
    lines += ["".join(cells[row * n + col] for row in range(n)) for col in range(n)]
    for start in range(-(n - 5), n - 4):
        diagonal = [cells[row * n + row + start] for row in range(n) if 0 <= row + start < n]
        anti = [cells[row * n + (n - 1 - row - start)] for row in range(n) if 0 <= n - 1 - row - start < n]
        lines += ["".join(diagonal), "".join(anti)]
    return lines


def _gomoku_shape(cells: list[str], index: int, stone: str) -> int:
    """Local strength of placing `stone` at `index` (mirrors the TypeScript AI)."""
    n = GOMOKU_SIZE
    row, col = divmod(index, n)
    total = 0
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        count, open_ends = 1, 0
        for direction in (-1, 1):
            r, c = row + dr * direction, col + dc * direction
            while 0 <= r < n and 0 <= c < n and cells[r * n + c] == stone:
                count += 1
                r, c = r + dr * direction, c + dc * direction
            if 0 <= r < n and 0 <= c < n and cells[r * n + c] == ".":
                open_ends += 1
        if count >= 5:
            total += 100000
        elif count == 4:
            total += 12000 if open_ends == 2 else 2500
        elif count == 3:
            total += 700 if open_ends == 2 else 90
        elif count == 2:
            total += 70 if open_ends == 2 else 12
        else:
            total += 1
    return total


class Gomoku(Adapter):
    name = "gomoku"
    informed_priors = True
    budgets = {"eased": (150, 1), "balanced": (500, 2), "increased": (1000, 3)}
    search_width = 10

    def __init__(self):
        self.game = pyspiel.load_game("gomoku")

    def build(self, board):
        return _replay_alternating(self.game, _marks(board, GOMOKU_SIZE * GOMOKU_SIZE))

    def describe(self, state, action):
        row, col = divmod(action, GOMOKU_SIZE)
        return f"row {row + 1}, column {col + 1}"

    def _scored(self, state):
        cells = _gomoku_cells(state)
        if all(cell == "." for cell in cells):
            return [(112, 1.0)]
        mine, theirs = ("b", "w") if state.current_player() == 0 else ("w", "b")
        n = GOMOKU_SIZE
        scored = []
        for index in state.legal_actions():
            row, col = divmod(index, n)
            near = any(
                cells[r * n + c] != "."
                for r in range(max(0, row - 2), min(n, row + 3))
                for c in range(max(0, col - 2), min(n, col + 3))
            )
            if near:
                score = _gomoku_shape(cells, index, mine) + 0.92 * _gomoku_shape(cells, index, theirs)
                scored.append((index, score))
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored

    def candidates(self, state):
        return [index for index, _ in self._scored(state)[:self.search_width]]

    def priors(self, state, actions):
        scores = dict(self._scored(state))
        weights = [math.sqrt(scores.get(action, 1.0)) for action in actions]
        total = sum(weights)
        return [(action, weight / total) for action, weight in zip(actions, weights)]

    def evaluate(self, state, player):
        lines = _gomoku_lines(_gomoku_cells(state))
        mine, theirs = ("b", "w") if player == 0 else ("w", "b")

        def side_score(stone):
            return sum(
                line.count(pattern.replace("p", stone)) * weight
                for line in lines
                for pattern, weight in _GOMOKU_PATTERNS
            )

        own, other = side_score(mine), side_score(theirs)
        # The side to move gets the next tempo.
        if state.current_player() == player:
            own *= 1.25
        else:
            other *= 1.25
        return math.tanh((own - other) / 4000)


_CHESS_VALUES = {"p": 1.0, "n": 3.0, "b": 3.25, "r": 5.0, "q": 9.0, "k": 0.0}


class Chess(Adapter):
    name = "chess"
    agent = 0  # OpenSpiel chess: black is player 0, white is player 1.
    budgets = {"eased": (120, 1), "balanced": (500, 3), "increased": (1500, 4)}

    def __init__(self):
        self.game = pyspiel.load_game("chess")

    def build(self, board):
        fen = board.get("fen") if isinstance(board, dict) else board
        if not isinstance(fen, str) or len(fen) > 100:
            raise EngineError("Expected a chess FEN string.")
        try:
            state = self.game.new_initial_state(fen)
        except pyspiel.SpielError as error:
            raise EngineError(f"Invalid FEN: {error}") from error
        if state.is_terminal() or state.current_player() != self.agent:
            raise EngineError("It must be black's turn in an unfinished game.")
        return state

    def move_to_action(self, state, move):
        try:
            return state.parse_move_to_action(move)
        except pyspiel.SpielError as error:
            raise EngineError(f"Unrecognized chess move {move!r}.") from error

    def describe(self, state, action):
        return state.action_to_string(action)

    def candidates(self, state):
        # Captures, promotions and checks first.
        def forcing(action):
            san = state.action_to_string(action)
            return ("x" not in san, "=" not in san, "+" not in san)
        return sorted(state.legal_actions(), key=forcing)

    def evaluate(self, state, player):
        placement = str(state).split(" ", 1)[0]
        queens_on = "q" in placement or "Q" in placement
        balance = 0.0
        for rank_index, rank in enumerate(placement.split("/")):
            file = 0
            for char in rank:
                if char.isdigit():
                    file += int(char)
                    continue
                kind, white = char.lower(), char.isupper()
                # Ranks advanced from this side's back rank (0..7).
                advance = 7 - rank_index if white else rank_index
                centre = 3.5 - max(abs(3.5 - file), abs(3.5 - rank_index))  # 0 at edge .. 3 in centre
                value = _CHESS_VALUES[kind]
                if kind == "p":
                    value += 0.04 * advance + (0.1 if 2 <= file <= 5 and advance >= 2 else 0)
                elif kind in ("n", "b"):
                    value += 0.08 * centre - (0.15 if advance == 0 else 0)  # develop minor pieces
                elif kind == "k" and queens_on:
                    value -= 0.15 * advance + (0.25 if 2 <= file <= 5 else 0)  # keep the king tucked away
                balance += value if white else -value
                file += 1
        if player == 0:
            balance = -balance
        return math.tanh(balance / 8)


# ---------------------------------------------------------------------------
# Checkers as a Python OpenSpiel game, following lib/games.ts exactly:
# mandatory captures, multi-jumps continue with the same piece (even after
# crowning), kings move one square in any diagonal direction, and a player
# with no legal move loses.
# ---------------------------------------------------------------------------

_CHECKERS_MAX_PLIES = 300
_CHECKERS_NO_CAPTURE_LIMIT = 80

_CHECKERS_TYPE = pyspiel.GameType(
    short_name="python_thinking_room_checkers",
    long_name="The Thinking Room Checkers",
    dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
    chance_mode=pyspiel.GameType.ChanceMode.DETERMINISTIC,
    information=pyspiel.GameType.Information.PERFECT_INFORMATION,
    utility=pyspiel.GameType.Utility.ZERO_SUM,
    reward_model=pyspiel.GameType.RewardModel.TERMINAL,
    max_num_players=2,
    min_num_players=2,
    provides_information_state_string=False,
    provides_information_state_tensor=False,
    provides_observation_string=False,
    provides_observation_tensor=False,
    parameter_specification={},
)
_CHECKERS_INFO = pyspiel.GameInfo(
    num_distinct_actions=64 * 64,
    max_chance_outcomes=0,
    num_players=2,
    min_utility=-1.0,
    max_utility=1.0,
    utility_sum=0.0,
    max_game_length=_CHECKERS_MAX_PLIES,
)
_OWNER = {"r": 0, "R": 0, "b": 1, "B": 1}


def _checkers_captures(board: list, origin: int) -> list[tuple[int, int, int]]:
    piece = board[origin]
    row, col = divmod(origin, 8)
    forward = -1 if piece in ("r", "R") else 1
    directions = (-1, 1) if piece in ("R", "B") else (forward,)
    moves = []
    for dr in directions:
        for dc in (-1, 1):
            to_row, to_col = row + 2 * dr, col + 2 * dc
            if not (0 <= to_row < 8 and 0 <= to_col < 8):
                continue
            middle = (row + dr) * 8 + col + dc
            target = to_row * 8 + to_col
            jumped = board[middle]
            if jumped and _OWNER[jumped] != _OWNER[piece] and not board[target]:
                moves.append((origin, target, middle))
    return moves


def checkers_legal_moves(board: list, player: int, forced: int | None) -> list[tuple[int, int, int | None]]:
    origins = [forced] if forced is not None else [i for i, piece in enumerate(board) if piece and _OWNER[piece] == player]
    captures = [move for origin in origins if board[origin] for move in _checkers_captures(board, origin)]
    if captures or forced is not None:
        return captures
    moves = []
    for origin in origins:
        piece = board[origin]
        row, col = divmod(origin, 8)
        directions = (-1, 1) if piece in ("R", "B") else ((-1,) if player == 0 else (1,))
        for dr in directions:
            for dc in (-1, 1):
                to_row, to_col = row + dr, col + dc
                if 0 <= to_row < 8 and 0 <= to_col < 8 and not board[to_row * 8 + to_col]:
                    moves.append((origin, to_row * 8 + to_col, None))
    return moves


class CheckersState(pyspiel.State):
    def __init__(self, game):
        super().__init__(game)
        self.board: list = [None] * 64
        for index in range(64):
            row, col = divmod(index, 8)
            if (row + col) % 2 == 1:
                self.board[index] = "b" if row < 3 else "r" if row > 4 else None
        self.player = 0
        self.forced: int | None = None
        self.plies = 0
        self.quiet_plies = 0
        self.winner: int | None = None
        self.finished = False

    def current_player(self):
        return pyspiel.PlayerId.TERMINAL if self.finished else self.player

    def _moves(self):
        return checkers_legal_moves(self.board, self.player, self.forced)

    def _legal_actions(self, player):
        return sorted(origin * 64 + target for origin, target, _ in self._moves())

    def _apply_action(self, action):
        origin, target = divmod(action, 64)
        captured = next(jumped for start, end, jumped in self._moves() if start == origin and end == target)
        piece = self.board[origin]
        self.board[origin] = None
        if captured is not None:
            self.board[captured] = None
        if piece == "r" and target < 8:
            piece = "R"
        elif piece == "b" and target >= 56:
            piece = "B"
        self.board[target] = piece
        self.plies += 1
        self.quiet_plies = 0 if captured is not None else self.quiet_plies + 1

        if captured is not None and _checkers_captures(self.board, target):
            self.forced = target
        else:
            self.forced = None
            self.player = 1 - self.player
            if not self._moves():
                self.winner = 1 - self.player
                self.finished = True
        if self.plies >= _CHECKERS_MAX_PLIES or self.quiet_plies >= _CHECKERS_NO_CAPTURE_LIMIT:
            self.finished = True

    def _action_to_string(self, player, action):
        return f"{action // 64}:{action % 64}"

    def is_terminal(self):
        return self.finished

    def returns(self):
        if self.winner is None:
            return [0.0, 0.0]
        return [1.0, -1.0] if self.winner == 0 else [-1.0, 1.0]

    def __str__(self):
        rows = ["".join(piece or "." for piece in self.board[row * 8:(row + 1) * 8]) for row in range(8)]
        return "\n".join(rows) + f"\nplayer={self.player} forced={self.forced}"


class CheckersGame(pyspiel.Game):
    def __init__(self, params=None):
        super().__init__(_CHECKERS_TYPE, _CHECKERS_INFO, params or dict())

    def new_initial_state(self):
        return CheckersState(self)


pyspiel.register_game(_CHECKERS_TYPE, CheckersGame)


def _checkers_square(index: int) -> str:
    return f"{'abcdefgh'[index % 8]}{8 - index // 8}"


class Checkers(Adapter):
    name = "checkers"
    budgets = {"eased": (100, 2), "balanced": (400, 4), "increased": (800, 6)}

    def __init__(self):
        self.game = pyspiel.load_game(_CHECKERS_TYPE.short_name)

    def build(self, board):
        if not isinstance(board, dict):
            raise EngineError("Expected a checkers state with board, turn and forcedFrom.")
        cells, turn, forced = board.get("board"), board.get("turn"), board.get("forcedFrom")
        if not isinstance(cells, list) or len(cells) != 64 or any(cell not in (None, "r", "R", "b", "B") for cell in cells):
            raise EngineError("Expected 64 checkers squares.")
        if turn != "b":
            raise EngineError("It must be black's (the agent team's) turn.")
        if forced is not None and not (isinstance(forced, int) and 0 <= forced < 64 and cells[forced] in ("b", "B")):
            raise EngineError("forcedFrom must point at a black piece.")
        state = self.game.new_initial_state()
        state.board = list(cells)
        state.player = self.agent
        state.forced = forced
        if not state.legal_actions():
            raise EngineError("Black has no legal move.")
        return state

    def move_to_action(self, state, move):
        try:
            origin, target = (int(part) for part in move.split(":"))
        except ValueError as error:
            raise EngineError(f"Unrecognized checkers move {move!r}.") from error
        return origin * 64 + target

    def describe(self, state, action):
        origin, target = divmod(action, 64)
        jump = " with a capture" if abs(origin // 8 - target // 8) == 2 else ""
        return f"{_checkers_square(origin)} to {_checkers_square(target)}{jump}"

    def candidates(self, state):
        return state.legal_actions()

    def evaluate(self, state, player):
        balance = 0.0
        for index, piece in enumerate(state.board):
            if not piece:
                continue
            value = 1.6 if piece in ("R", "B") else 1.0 + 0.04 * (7 - index // 8 if piece == "r" else index // 8)
            balance += value if _OWNER[piece] == player else -value
        return math.tanh(balance / 4)


ADAPTERS: dict[str, Adapter] = {
    adapter.name: adapter
    for adapter in (Chess(), TicTacToe(), Checkers(), Gomoku())
}
