"""The roster: the agents you can choose to play against, or to play each other.

The OpenSpiel agents run in this process. Stockfish and Sunfish (GPL-3.0) run as
separate programs over UCI. Raven Checkers (MIT-0) is vendored in engine/vendor.
"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
from dataclasses import dataclass
from typing import Callable

import agents
import uci
from games import ADAPTERS, EngineError

# What each difficulty level (1 to 5) means for the outside agents; the OpenSpiel
# agents' levels are in games.py and agents.py.
_STOCKFISH_LEVELS = {
    1: ({"Skill Level": "0"}, "movetime 100"),
    2: ({"UCI_LimitStrength": "true", "UCI_Elo": "1320"}, "movetime 300"),
    3: ({"UCI_LimitStrength": "true", "UCI_Elo": "1700"}, "movetime 500"),
    4: ({"UCI_LimitStrength": "true", "UCI_Elo": "2300"}, "movetime 1000"),
    5: ({}, "movetime 2000"),
}
_SUNFISH_LEVELS = {1: "depth 1", 2: "depth 2", 3: "depth 3", 4: "movetime 1000", 5: "movetime 3000"}
_RAVEN_LEVELS = {1: (1, 1.0), 2: (2, 1.0), 3: (4, 1.0), 4: (6, 2.0), 5: (10, 4.0)}  # (depth, seconds)
_STOCKFISH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "stockfish", "stockfish.exe")


def _stockfish_ready() -> bool:
    return os.path.exists(_STOCKFISH)


def _sunfish_ready() -> bool:
    return importlib.util.find_spec("sunfish") is not None


def _always() -> bool:
    return True


@dataclass(frozen=True)
class Player:
    id: str
    name: str
    summary: str
    games: tuple[str, ...]
    license: str
    available: Callable[[], bool] = _always


_ALL_GAMES = ("chess", "tictactoe", "checkers", "gomoku")
PLAYERS = (
    Player("team", "OpenSpiel Team", "Strategist, Challenger and Referee together", _ALL_GAMES, "Apache-2.0"),
    Player("strategist", "Strategist", "OpenSpiel Monte Carlo tree search", _ALL_GAMES, "Apache-2.0"),
    Player("challenger", "Challenger", "Alpha-beta search over OpenSpiel states", _ALL_GAMES, "Apache-2.0"),
    Player("stockfish", "Stockfish", "World-class chess engine", ("chess",), "GPL-3.0", _stockfish_ready),
    Player("sunfish", "Sunfish", "Small chess engine written in Python", ("chess",), "GPL-3.0", _sunfish_ready),
    Player("raven", "Raven", "Raven Checkers' alpha-beta agent", ("checkers",), "MIT-0"),
)
_BY_ID = {player.id: player for player in PLAYERS}


def listing() -> list[dict]:
    return [
        {
            "id": player.id,
            "name": player.name,
            "summary": player.summary,
            "games": list(player.games),
            "license": player.license,
            "available": player.available(),
        }
        for player in PLAYERS
    ]


def _chess_engine(player: Player, board, legal_moves: list[str], level: int) -> dict:
    adapter, state, to_move, _ = agents.prepare("chess", board, legal_moves)
    fen = board.get("fen") if isinstance(board, dict) else board
    if player.id == "sunfish":
        command, options, limit = [sys.executable, "-I", "-c", "import sunfish; sunfish.main()"], None, _SUNFISH_LEVELS[level]
    else:
        command = [_STOCKFISH]
        options, limit = _STOCKFISH_LEVELS[level]
    answer = uci.best_move(command, fen, limit, options)

    if answer.move not in legal_moves:
        raise EngineError(f"{player.name} chose a move the app does not allow: {answer.move}.")
    action = next(action for action, move in to_move.items() if move == answer.move)
    if answer.mate_in is not None:
        chance = 99 if answer.mate_in > 0 else 1
    elif answer.centipawns is not None:
        chance = agents.win_chance(math.tanh(answer.centipawns / 400))
    else:
        chance = None
    search = f"depth {answer.depth}" if answer.depth else limit.replace("movetime", "search,").strip()
    estimate = f" Estimated win chance: {chance}%." if chance is not None else ""
    return {
        "move": answer.move,
        "explanation": f"{player.name} ({search}) chose {adapter.describe(state, action)}.{estimate}",
        "winChance": chance,
    }


def _raven(board, legal_moves: list[str], level: int) -> dict:
    import raven_agent  # Only loaded when Raven plays.

    adapter, state, to_move, _ = agents.prepare("checkers", board, legal_moves)
    max_depth, seconds = _RAVEN_LEVELS[level]
    move, detail = raven_agent.choose(board["board"], board["turn"], legal_moves, max_depth, seconds)
    action = next(action for action, candidate in to_move.items() if candidate == move)
    return {
        "move": move,
        "explanation": f"Raven ({detail}) chose {adapter.describe(state, action)}.",
        "winChance": None,
    }


def play(player_id, game, board, legal_moves: list[str], level=None) -> dict:
    player = _BY_ID.get(player_id)
    if player is None:
        raise EngineError(f"Unknown player {player_id!r}.")
    if game not in ADAPTERS or game not in player.games:
        raise EngineError(f"{player.name} does not play {game}.")
    if not player.available():
        raise EngineError(f"{player.name} is not installed on this computer.")
    level = agents.clean_level(level)

    if player.id == "team":
        return agents.choose_move(game, board, legal_moves, level)
    if player.id == "strategist":
        return agents.solo_strategist(game, board, legal_moves, level)
    if player.id == "challenger":
        return agents.solo_challenger(game, board, legal_moves, level)
    if player.id == "raven":
        return _raven(board, legal_moves, level)
    return _chess_engine(player, board, legal_moves, level)
