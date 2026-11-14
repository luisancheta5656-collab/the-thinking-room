"use client";

import { LEVEL_NAMES, LEVELS } from "@/lib/agent-match";

type Props = {
  level: number;
  disabled?: boolean;
  /** Says which agent this is for when a screen shows more than one slider. */
  label?: string;
  title?: string;
  onChange: (level: number) => void;
};

/** A five-stop difficulty slider. It is a native range input, so arrow keys work too. */
export default function DifficultySlider({ level, disabled = false, label = "Difficulty", title, onChange }: Props) {
  return (
    <label className="difficulty" title={title}>
      <span className="difficulty-label">Difficulty <b>({LEVEL_NAMES[level]})</b></span>
      <span className="difficulty-track">
        <span className="difficulty-dots" aria-hidden="true">
          {LEVELS.map((stop) => <i key={stop} />)}
        </span>
        <input
          type="range"
          min={LEVELS[0]}
          max={LEVELS[LEVELS.length - 1]}
          step={1}
          value={level}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={LEVEL_NAMES[level]}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
    </label>
  );
}
