"""A small client for the UCI protocol that chess engines speak.

Outside engines run as their own programs and are only ever talked to over
stdin/stdout. Each move starts a fresh process, so no engine outlives its turn.
"""

from __future__ import annotations

import subprocess
import sys
import threading
from dataclasses import dataclass


class UciError(RuntimeError):
    """The engine failed to answer."""


@dataclass
class UciAnswer:
    move: str
    depth: int | None  # deepest search reached
    centipawns: int | None  # score for the side to move
    mate_in: int | None  # moves to mate; negative when the side to move is being mated


def _read_info(line: str, answer: UciAnswer) -> None:
    parts = line.split()
    for index, part in enumerate(parts[:-1]):
        if part == "depth":
            answer.depth = int(parts[index + 1])
        elif part == "score" and index + 2 < len(parts):
            kind, value = parts[index + 1], int(parts[index + 2])
            answer.centipawns, answer.mate_in = (value, None) if kind == "cp" else (None, value)


def best_move(command: list[str], fen: str, limit: str, options: dict[str, str] | None = None) -> UciAnswer:
    """`limit` is what follows UCI's `go` command, such as "movetime 500" or "depth 2"."""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, creationflags=flags,
        )
    except OSError as error:
        raise UciError(f"Could not start the engine: {error}") from error

    # A stuck engine must not hold up the game. This is generous because the first run on a PC can be slow.
    watchdog = threading.Timer(60, process.kill)
    watchdog.start()

    def send(text: str) -> None:
        process.stdin.write(text + "\n")
        process.stdin.flush()

    def read_until(prefix: str, answer: UciAnswer | None = None) -> str:
        for line in process.stdout:
            if line.startswith(prefix):
                return line.strip()
            if answer is not None and line.startswith("info "):
                _read_info(line, answer)
        raise UciError("The engine stopped without answering.")

    try:
        send("uci")
        read_until("uciok")
        for name, value in (options or {}).items():
            send(f"setoption name {name} value {value}")
        send("isready")
        read_until("readyok")
        send(f"position fen {fen}")
        send(f"go {limit}")
        answer = UciAnswer("", None, None, None)
        parts = read_until("bestmove", answer).split()
        if len(parts) < 2 or parts[1] == "(none)":
            raise UciError("The engine found no move.")
        answer.move = parts[1]
        send("quit")
        return answer
    except (OSError, ValueError) as error:
        raise UciError(f"The engine could not be reached: {error}") from error
    finally:
        watchdog.cancel()
        if process.poll() is None:
            process.kill()
        process.wait()
        process.stdin.close()
        process.stdout.close()
