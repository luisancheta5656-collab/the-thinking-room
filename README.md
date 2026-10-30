# The Thinking Room

A four-game board-game arcade for Windows: chess, tic-tac-toe, checkers, and Gomoku. Your opponent is a multi-agent team built on [OpenSpiel](https://github.com/google-deepmind/open_spiel), Google DeepMind's game-AI framework. A local Ollama model can optionally add chat and post-game coaching. Everything runs on your own computer.

## Install and play (Windows)

1. Download `The Thinking Room Setup 0.1.0.exe` from this repository's **Releases** page.
2. Run it. It installs for your user account only (no administrator rights needed) and adds Start-menu and desktop shortcuts.

The installer includes everything the games need: Python and OpenSpiel are bundled inside the app.

- **Requirements:** 64-bit Windows 10 or 11, about 640 MB of disk space, and a screen of at least 1024 × 700.
- **SmartScreen warning:** the installer isn't code-signed, so Windows may show "Windows protected your PC" on first run. Choose **More info**, then **Run anyway**.
- **Chat and coaching** are optional and need Ollama; see [below](#optional-chat-and-coaching-with-ollama). The games work fully without it.

## The agent team

Each AI move is made by three OpenSpiel agents:

- **Strategist**: Monte Carlo tree search (OpenSpiel's `MCTSBot`). It uses random rollouts for tic-tac-toe and a position heuristic for chess, checkers, and Gomoku.
- **Challenger**: an independent iterative-deepening alpha-beta search over the same OpenSpiel states.
- **Referee**: takes any immediately winning move, rejects proposals that allow an immediate loss (and blocks the threat instead), and otherwise picks the proposal the two searches rate higher. It explains its decision in the chat panel.

Chess, tic-tac-toe, and Gomoku use OpenSpiel's built-in games. Checkers is registered as a Python OpenSpiel game, because the built-in version can't be loaded from a custom position and ends a turn on crowning, which this app's rules don't.

The session win-rate display uses decisive games (wins and losses, excluding draws) and targets 50%. When either side leads by at least two wins, the search budget adapts. If the player is ahead, the agents search more (more MCTS simulations, deeper alpha-beta). If the agents are ahead, they search less and sample among their top moves. This tuning nudges the session toward 50/50 but doesn't guarantee it. The game rules engine still validates and applies every move. If the OpenSpiel engine is unavailable, the built-in local game AI plays instead.

## Boards and animation

Chess can be played on a 3D board (Three.js) or the flat 2D board; use the **2D / 3D** switch in the game header, and the choice is remembered. The 3D camera is fixed at a tilted view from White's side. To play with the keyboard (Tab and Enter), use the 2D board. If the computer cannot run 3D graphics, the app switches to 2D automatically. On laptops with two graphics cards, the app asks Windows for the dedicated one.

Pieces in chess and checkers slide to their new square, and captured pieces shrink away. In checkers, captures jump over the taken piece, each jump of a multi-jump plays in turn, and a newly crowned king glows. The opponent's reply waits until your move has finished animating. If Windows' **Animation effects** setting is off (Settings > Accessibility > Visual effects), pieces move without animation.

## Optional: chat and coaching with Ollama

The **Conversational** chat and the post-game **Coach** need a language model, which OpenSpiel doesn't provide. To enable them:

1. Install and start [Ollama for Windows](https://ollama.com/download/windows).
2. Download the default model:

```powershell
   ollama pull llama3.2:3b
```

To change the model or service URL, set `OLLAMA_MODEL` or `OLLAMA_BASE_URL` in `.env.local` (see `.env.example`). The model runs locally; nothing is sent to an online service.

## Development

You need Node.js 20.9+ and Python 3.11 (the `py -3.11` launcher).

Run `launch-app.bat`. It:

- checks for Node.js (and for Python when the engine isn't installed yet);
- installs the packages on first run, and again whenever `package-lock.json` changes, for example after you pull a change that adds a package;
- creates the OpenSpiel engine's environment in `engine\.venv` on first run, and updates it whenever `engine\requirements.txt` changes;
- starts Ollama if it's installed, and warns if the chat model is missing;
- opens the app in its desktop window (`npm run desktop`).

Only one development copy can run per project folder; the launcher tells you if one is already open.

To run it in a browser at http://localhost:3000 instead:

```bash
npm install
npm run setup:engine   # once: engine/.venv with open_spiel
npm run engine         # OpenSpiel engine on http://127.0.0.1:8765
npm run dev
```

Run `npm run desktop` from a normal terminal. VS Code's integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which stops Electron from opening a window (`launch-app.bat` clears it for you).

### Project layout

| Path | Contents |
| --- | --- |
| `app/page.tsx` | The game screen: boards, turns, score, chat, and the end-of-match card |
| `app/api/opponent/` | API routes: agent moves (`route.ts`), chat, and coaching |
| `components/ChessBoard3D.tsx` | The 3D chess board |
| `lib/games.ts` | Game rules and the built-in fallback AI |
| `lib/animation.ts` | Move-animation timings (keep the matching CSS in `app/globals.css` in step) |
| `lib/agent-configs.ts`, `lib/agent-factory.ts`, `lib/ollama.ts` | The Ollama chat and Coach agents |
| `lib/openspiel.ts` | Client for the OpenSpiel engine |
| `engine/` | The OpenSpiel engine: HTTP server, agent team, and game adapters (Python) |
| `electron/main.js` | The desktop shell: starts the engine and the game server, opens the window |
| `scripts/` | Installer build steps |
| `public/models/chess/` | 3D chess piece models |

## Build the installer

```bash
npm run dist
```

This needs an internet connection. It builds Next.js as a standalone server and downloads Python 3.11's embeddable build into `build\python` with OpenSpiel installed (`scripts\prepare-python.ps1`). It then packages everything with electron-builder into `dist\The Thinking Room Setup 0.1.0.exe` (about 190 MB). Inside the app, Electron starts the engine and the game server on private loopback ports and shows the game in its own window.

To publish a version, upload the `.exe` to a GitHub release. It is too large to commit: GitHub rejects files over 100 MB, and `dist/` is ignored by Git.

The build is unsigned, so Windows SmartScreen warns on first run until you sign it with a code-signing certificate. The app uses the default Electron icon; add `build/icon.ico` (256×256) to brand it.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

## Credits and licenses

- [OpenSpiel](https://github.com/google-deepmind/open_spiel): Apache-2.0
- [Electron](https://www.electronjs.org/), [Next.js](https://nextjs.org/), [React](https://react.dev/), [Three.js](https://threejs.org/): MIT
- [chess.js](https://github.com/jhlywa/chess.js): BSD-2-Clause
- [Lucide](https://lucide.dev/) icons: ISC
- Python (bundled in the installer): Python Software Foundation License
- [3D chess pieces by tunakron](https://opengameart.org/node/157258): CC0 (public domain); see `public/models/chess/CREDITS.txt`
- The optional chat model, Llama 3.2, is downloaded separately through Ollama under Meta's Llama 3.2 Community License.

## Team

| Member | Role |
| --- | --- |
| Hakuryu Acosta Kato | Full Stack Developer / AI Engineer / Project Lead |
| Luis Fernando A. Nival | Backend Developer / Debugging Engineer |
| Zerwin Kurt D. Ventura | Quality Assurance Tester / Documentation / Researcher |
| Mickaela Paula R. Orillosa | Quality Assurance Tester / Documentation / Researcher |
