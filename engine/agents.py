"""The OpenSpiel agent team: Strategist (MCTS), Challenger (alpha-beta) and Referee."""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from open_spiel.python.algorithms import mcts

from games import ADAPTERS, Adapter, EngineError

DEFAULT_LEVEL = 3
# Difficulty level -> longest the Challenger may search, in seconds.
LEVEL_SECONDS = {1: 1.0, 2: 1.0, 3: 2.0, 4: 3.0, 5: 5.0}
# The lowest levels make mistakes on purpose: they may play any of the top N moves
# rated within this margin of the best (a value of 0.12 is about a pawn in chess).
SLOPPY_LEVELS = {1: (5, 0.5), 2: (3, 0.2)}


def clean_level(level) -> int:
    return level if isinstance(level, int) and level in LEVEL_SECONDS else DEFAULT_LEVEL


@dataclass
class Proposal:
    action: int
    value: float  # expected outcome for the agent team, in [-1, 1]
    detail: str


class _Evaluator(mcts.Evaluator):
    """Leaf values from rollouts or the game heuristic; root restricted to the app's legal moves."""

    def __init__(self, adapter: Adapter, root_length: int, root_actions: list[int], rng: np.random.RandomState):
        self.adapter = adapter
        self.root_length = root_length
        self.root_actions = root_actions
        self.rng = rng

    def evaluate(self, state):
        if state.is_terminal():
            return np.array(state.returns())
        if self.adapter.rollouts:
            working = state.clone()
            while not working.is_terminal():
                working.apply_action(self.rng.choice(working.legal_actions()))
            return np.array(working.returns())
        value = self.adapter.evaluate(state, 0)
        return np.array([value, -value])

    def prior(self, state):
        if len(state.history()) == self.root_length:
            actions = self.root_actions
        else:
            actions = self.adapter.candidates(state) or state.legal_actions()
        return self.adapter.priors(state, actions)


def _search_root(adapter: Adapter, state, allowed: list[int]) -> list[int]:
    """Root moves for both searches: the adapter's candidates that the app allows."""
    allowed_set = set(allowed)
    root = [action for action in adapter.candidates(state) if action in allowed_set]
    return root or allowed


def strategist(adapter: Adapter, state, allowed: list[int], level: int, rng: np.random.RandomState, agent: int):
    simulations, _ = adapter.budgets[level]
    evaluator = _Evaluator(adapter, len(state.history()), _search_root(adapter, state, allowed), rng)
    bot = mcts.MCTSBot(
        adapter.game,
        uct_c=2.0 if adapter.informed_priors else 1.4,
        max_simulations=simulations,
        evaluator=evaluator,
        solve=True,
        random_state=rng,
        child_selection_fn=mcts.SearchNode.puct_value if adapter.informed_priors else mcts.SearchNode.uct_value,
    )
    root = bot.mcts_search(state)

    def value(child):
        if child.outcome is not None:
            return float(child.outcome[agent])
        return child.total_reward / child.explore_count if child.explore_count else 0.0

    ranked = sorted(root.children, key=lambda child: (value(child) >= 1.0, child.explore_count, value(child)), reverse=True)
    choice = ranked[0]
    if level in SLOPPY_LEVELS and len(ranked) > 1:
        # Sample among the top moves in proportion to visits for a softer opponent.
        width, margin = SLOPPY_LEVELS[level]
        top = [child for child in ranked[:width] if child.explore_count and value(child) >= value(ranked[0]) - margin]
        if top:
            weights = np.array([child.explore_count for child in top], dtype=float)
            choice = top[rng.choice(len(top), p=weights / weights.sum())]
    values = {child.action: value(child) for child in root.children if child.explore_count or child.outcome is not None}
    proposal = Proposal(choice.action, value(choice), f"MCTS, {simulations} simulations")
    return proposal, values


class _OutOfTime(Exception):
    pass


def _minimax(adapter: Adapter, state, depth: int, alpha: float, beta: float, ply: int, deadline: float, agent: int) -> float:
    if state.is_terminal():
        outcome = state.returns()[agent]
        # Prefer quick wins and slow losses.
        return outcome * (1.0 - 0.005 * ply)
    if depth == 0:
        return 0.9 * adapter.evaluate(state, agent)
    if time.monotonic() > deadline:
        raise _OutOfTime
    maximizing = state.current_player() == agent
    best = -2.0 if maximizing else 2.0
    for action in adapter.candidates(state) or state.legal_actions():
        score = _minimax(adapter, state.child(action), depth - 1, alpha, beta, ply + 1, deadline, agent)
        if maximizing:
            best = max(best, score)
            alpha = max(alpha, best)
        else:
            best = min(best, score)
            beta = min(beta, best)
        if beta <= alpha:
            break
    return best


def challenger(adapter: Adapter, state, allowed: list[int], level: int, agent: int, rng: np.random.RandomState):
    """Iterative-deepening alpha-beta over OpenSpiel states, within a time budget."""
    _, max_depth = adapter.budgets[level]
    seconds = LEVEL_SECONDS[level]
    deadline = time.monotonic() + seconds
    root = _search_root(adapter, state, allowed)
    best: Proposal | None = None
    scores: dict[int, float] = {}
    for depth in range(1, max_depth + 1):
        try:
            depth_scores: dict[int, float] = {}
            alpha = -2.0
            # Search the previous best move first for better pruning.
            order = sorted(root, key=lambda action: scores.get(action, -2.0), reverse=True)
            for action in order:
                score = _minimax(adapter, state.child(action), depth - 1, alpha, 2.0, 1, deadline, agent)
                depth_scores[action] = score
                alpha = max(alpha, score)
        except _OutOfTime:
            break
        scores = depth_scores
        action = max(scores, key=scores.get)
        best = Proposal(action, scores[action], f"alpha-beta, depth {depth}")
        if scores[action] >= 0.9:
            break  # forced win found
    if best is None:
        raise EngineError("The Challenger ran out of time before finishing a search.")
    if level in SLOPPY_LEVELS and scores:
        width, margin = SLOPPY_LEVELS[level]
        ranked = sorted(scores, key=scores.get, reverse=True)[:width]
        close = [action for action in ranked if scores[action] >= best.value - margin]
        action = close[rng.choice(len(close))]
        best = Proposal(action, scores[action], best.detail)
    return best, scores


def _wins_now(state, action: int, agent: int) -> bool:
    child = state.child(action)
    return child.is_terminal() and child.returns()[agent] > 0


def _losing_replies(state, action: int, agent: int) -> int:
    """How many opponent replies would end the game in their favour."""
    child = state.child(action)
    if child.is_terminal() or child.current_player() == agent:
        return 0
    return sum(
        grandchild.is_terminal() and grandchild.returns()[agent] < 0
        for grandchild in (child.child(reply) for reply in child.legal_actions())
    )


def _loses_next(state, action: int, agent: int) -> bool:
    return _losing_replies(state, action, agent) > 0


def referee(adapter: Adapter, state, allowed: list[int], strategy: Proposal, challenge: Proposal,
            mcts_values: dict[int, float], ab_scores: dict[int, float], agent: int) -> tuple[int, str]:
    for action in allowed:
        if _wins_now(state, action, agent):
            return action, "it wins the game immediately"

    proposals = [strategy.action] if strategy.action == challenge.action else [strategy.action, challenge.action]
    safe = [action for action in proposals if not _loses_next(state, action, agent)]
    if not safe:
        for action in _search_root(adapter, state, allowed) + allowed:
            if not _loses_next(state, action, agent):
                return action, "both proposals allowed an immediate loss, so it blocks the threat instead"
        # Every move loses: block as many of the opponent's winning replies as possible.
        options = proposals + [action for action in _search_root(adapter, state, allowed) if action not in proposals]
        return min(options, key=lambda action: _losing_replies(state, action, agent)), \
            "the opponent has more than one winning threat, so it blocks as many as it can"
    if len(safe) == 1:
        if len(proposals) == 1:
            return safe[0], "the Strategist and Challenger agreed on it"
        rejected = "Strategist" if safe[0] == challenge.action else "Challenger"
        return safe[0], f"the {rejected}'s move allowed an immediate loss"

    def combined(action):
        ab = ab_scores.get(action)
        mc = mcts_values.get(action)
        known = [value for value in (ab, mc) if value is not None]
        return sum(known) / len(known) if known else -2.0

    if combined(challenge.action) > combined(strategy.action) + 0.02:
        return challenge.action, "the Challenger's deeper tactical search rated it higher"
    return strategy.action, "the Strategist's search rated it higher overall"


def prepare(game: str, board, legal_moves: list[str]):
    """Rebuild the position; returns its adapter, state, action-to-move map and sorted actions."""
    adapter = ADAPTERS.get(game)
    if adapter is None:
        raise EngineError(f"Unsupported game {game!r}.")
    state = adapter.build(board)

    legal_actions = set(state.legal_actions())
    to_move: dict[int, str] = {}
    for move in legal_moves:
        action = adapter.move_to_action(state, move)
        if action in legal_actions:
            to_move[action] = move
    if not to_move:
        raise EngineError("None of the app's legal moves are legal in the OpenSpiel state.")
    return adapter, state, to_move, sorted(to_move)


def win_chance(value: float) -> int:
    return round((max(-1.0, min(1.0, value)) + 1) * 50)


def choose_move(game: str, board, legal_moves: list[str], level=DEFAULT_LEVEL, seed: int | None = None) -> dict:
    """The full team: Strategist and Challenger propose, the Referee decides."""
    level = clean_level(level)
    adapter, state, to_move, allowed = prepare(game, board, legal_moves)
    agent = state.current_player()

    rng = np.random.RandomState(seed)
    strategy, mcts_values = strategist(adapter, state, allowed, level, rng, agent)
    challenge, ab_scores = challenger(adapter, state, allowed, level, agent, rng)
    action, reason = referee(adapter, state, allowed, strategy, challenge, mcts_values, ab_scores, agent)

    value = mcts_values.get(action, ab_scores.get(action, 0.0))
    chance = win_chance(value)
    explanation = (
        f"Strategist ({strategy.detail}) proposed {adapter.describe(state, strategy.action)}; "
        f"Challenger ({challenge.detail}) proposed {adapter.describe(state, challenge.action)}. "
        f"Referee picked {adapter.describe(state, action)} because {reason}. "
        f"Estimated win chance: {chance}%."
    )
    return {
        "move": to_move[action],
        "explanation": explanation,
        "winChance": chance,
        "agents": {
            "strategist": {"move": to_move.get(strategy.action), "value": round(strategy.value, 3), "search": strategy.detail},
            "challenger": {"move": to_move.get(challenge.action), "value": round(challenge.value, 3), "search": challenge.detail},
            "referee": {"move": to_move[action], "reason": reason},
        },
    }


def solo_strategist(game: str, board, legal_moves: list[str], level=DEFAULT_LEVEL, seed: int | None = None) -> dict:
    adapter, state, to_move, allowed = prepare(game, board, legal_moves)
    rng = np.random.RandomState(seed)
    proposal, _ = strategist(adapter, state, allowed, clean_level(level), rng, state.current_player())
    chance = win_chance(proposal.value)
    return {
        "move": to_move[proposal.action],
        "explanation": f"Strategist ({proposal.detail}) chose {adapter.describe(state, proposal.action)}. Estimated win chance: {chance}%.",
        "winChance": chance,
    }


def solo_challenger(game: str, board, legal_moves: list[str], level=DEFAULT_LEVEL, seed: int | None = None) -> dict:
    adapter, state, to_move, allowed = prepare(game, board, legal_moves)
    rng = np.random.RandomState(seed)
    proposal, _ = challenger(adapter, state, allowed, clean_level(level), state.current_player(), rng)
    chance = win_chance(proposal.value)
    return {
        "move": to_move[proposal.action],
        "explanation": f"Challenger ({proposal.detail}) chose {adapter.describe(state, proposal.action)}. Estimated win chance: {chance}%.",
        "winChance": chance,
    }
