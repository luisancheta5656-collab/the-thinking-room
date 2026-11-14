// AI vs AI: shared types and rules. "first" plays White or Red; "second" plays Black.

export type MatchGame = "chess" | "checkers";
export type MatchSide = "first" | "second";
export type MatchStatus = "setup" | "running" | "paused" | "over";
export type MatchSpeed = "slow" | "normal" | "fast";
export type MatchOutcome = { winner: MatchSide | null; reason: string };
export type Fighters = Record<MatchSide, string>;

export type RosterPlayer = {
  id: string;
  name: string;
  summary: string;
  games: string[];
  license: string;
  available: boolean;
};

export const matchGames = new Set<string>(["chess", "checkers"]);

// Difficulty: every agent plays at one of these five levels.
export const LEVELS = [1, 2, 3, 4, 5];
export const LEVEL_NAMES: Record<number, string> = { 1: "Beginner", 2: "Easy", 3: "Medium", 4: "Hard", 5: "Expert" };
export const DEFAULT_LEVEL = 3;

export function cleanLevel(level: unknown): number {
  return typeof level === "number" && LEVELS.includes(level) ? level : DEFAULT_LEVEL;
}

/** OpenSpiel Team plays one level up when you lead the session by two wins, and one down when it does. */
export function adaptedLevel(level: number, score: { player: number; opponent: number }): number {
  const lead = score.player - score.opponent;
  const shift = lead >= 2 ? 1 : lead <= -2 ? -1 : 0;
  return Math.min(LEVELS[LEVELS.length - 1], Math.max(LEVELS[0], level + shift));
}

export const DEFAULT_FIGHTERS: Record<MatchGame, Fighters> = {
  chess: { first: "stockfish", second: "team" },
  checkers: { first: "raven", second: "team" },
};

/** Extra pause after each move lands, so a match can be followed at any speed. */
export const MATCH_PAUSE_MS: Record<MatchSpeed, number> = { slow: 1500, normal: 500, fast: 0 };
// Agents can shuffle pieces forever, so a match also ends in a draw on any of these.
export const REPETITION_LIMIT = 3;
export const CHECKERS_NO_CAPTURE_LIMIT = 80;
export const MATCH_MAX_PLIES = 400;

export function sideLabel(game: MatchGame, side: MatchSide): string {
  if (side === "second") return "Black";
  return game === "chess" ? "White" : "Red";
}

/** The saved choice if it can play right now, otherwise the first agent that can. */
export function resolveFighter(players: RosterPlayer[], game: string, id: string): RosterPlayer | undefined {
  const options = players.filter((player) => player.games.includes(game) && player.available);
  return options.find((player) => player.id === id) ?? options[0];
}
