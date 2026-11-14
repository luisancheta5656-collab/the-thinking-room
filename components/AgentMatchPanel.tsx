"use client";

import { Pause, Play, Swords, StepForward } from "lucide-react";
import DifficultySlider from "@/components/DifficultySlider";
import {
  resolveFighter,
  sideLabel,
  type Fighters,
  type MatchGame,
  type MatchSide,
  type MatchSpeed,
  type MatchStatus,
  type RosterPlayer,
} from "@/lib/agent-match";

type Props = {
  game: MatchGame;
  players: RosterPlayer[];
  fighters: Fighters;
  levels: Record<MatchSide, number>;
  status: MatchStatus;
  speed: MatchSpeed;
  thinking: boolean;
  engineReady: boolean;
  onChoose: (side: MatchSide, id: string) => void;
  onLevel: (side: MatchSide, level: number) => void;
  onSpeed: (speed: MatchSpeed) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStep: () => void;
};

const speeds: MatchSpeed[] = ["slow", "normal", "fast"];

/** Chooses the two agents for an AI vs AI match and controls its playback. */
export default function AgentMatchPanel({
  game, players, fighters, levels, status, speed, thinking, engineReady,
  onChoose, onLevel, onSpeed, onStart, onPause, onResume, onStep,
}: Props) {
  const roster = players.filter((player) => player.games.includes(game));
  const locked = status !== "setup";

  return (
    <section className="agent-match" aria-label="AI vs AI match">
      <div className="agent-match-heading"><Swords size={14} /> CHOOSE THE AGENTS</div>
      {(["first", "second"] as const).map((side) => {
        const chosen = resolveFighter(players, game, fighters[side]);
        return (
          <div key={side} className="agent-pick">
            <span className="agent-pick-side">{sideLabel(game, side).toUpperCase()}</span>
            <select aria-label={`Agent playing ${sideLabel(game, side)}`} value={chosen?.id ?? ""} disabled={locked || !chosen} onChange={(event) => onChoose(side, event.target.value)}>
              {!chosen && <option value="">{engineReady ? "Loading agents…" : "Engine offline"}</option>}
              {roster.map((player) => (
                <option key={player.id} value={player.id} disabled={!player.available}>
                  {player.name}{player.available ? "" : " (not installed)"}
                </option>
              ))}
            </select>
            {chosen && <small title={`${chosen.summary} · ${chosen.license}`}>{chosen.summary} · {chosen.license}</small>}
            <div className="agent-pick-level">
              <DifficultySlider
                level={levels[side]}
                disabled={locked || !chosen}
                label={`Difficulty for ${sideLabel(game, side)}`}
                onChange={(level) => onLevel(side, level)}
              />
            </div>
          </div>
        );
      })}
      <div className="agent-controls">
        {status === "setup" && (
          <button className="agent-primary" disabled={!engineReady || roster.length === 0} onClick={onStart}><Play size={13} /> Start match</button>
        )}
        {status === "running" && <button className="agent-primary" onClick={onPause}><Pause size={13} /> Pause</button>}
        {status === "paused" && <button className="agent-primary" disabled={thinking} onClick={onResume}><Play size={13} /> Resume</button>}
        {status === "paused" && <button className="agent-secondary" disabled={thinking} onClick={onStep} title="Play one move"><StepForward size={13} /> Step</button>}
        {status === "over" && <span className="agent-finished">Match finished</span>}
      </div>
      <div className="agent-speed" role="group" aria-label="Match speed">
        <span>SPEED</span>
        {speeds.map((option) => (
          <button key={option} className={speed === option ? "is-active" : ""} aria-pressed={speed === option} onClick={() => onSpeed(option)}>{option}</button>
        ))}
      </div>
    </section>
  );
}
