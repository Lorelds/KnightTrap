# Knight Trap

A browser game for two players on a 7×7 board, built for the AI course proposal *"Implementasi AI pada Game Knight Trap Menggunakan Algoritma Minimax dengan Alpha-Beta Pruning"* (Universitas Ciputra, 2026/2027).

You move a knight, the square you leave burns, and then you destroy one more square as a trap. A player who has no legal jump on their turn loses.

Modes:
- **Single Player**: play against the Minimax AI (Easy, Medium, Hard, Expert), with a live AI stats panel and an Alpha-Beta on/off switch.
- **Multiplayer, Local**: two players take turns on one device.
- **Multiplayer, Online**: one player creates a room and the other joins with its code. It runs peer-to-peer over PeerJS, so there is no backend of our own.

The game is plain HTML, CSS and JavaScript ES modules. There is no framework and no build step.

For the NPLC Universitas Ciputra rally (theme: Human vs AI), Single Player games also earn points, and teams are ranked on an online leaderboard. That part is two Vercel Serverless Functions backed by Upstash Redis.

## Points and leaderboard

Only Single Player games against the AI score. Local and Online games give no points. There are two kinds of points, both multiplied by the level (defaults: Easy ×1, Medium ×1.5, Hard ×2, Expert ×2.5):

| What | Points (× level) |
|---|---|
| Each of your moves | 10 |
| Winning | +200 |

A loss keeps its move points. The defaults live in `SCORING` in `js/config.js`. The Single Player screen shows what each level is worth, every difficulty card shows its points per move, and the move history shows what each of your moves earned.

### Changing the points (admin)

Open `/admin.html` and sign in with the `ADMIN_KEY` value. You can change the points per move, the win bonus and the four level multipliers (points are whole numbers 0–100000; multipliers 0–100 with up to two decimals, so ×1.5 works). A preview table shows what each level will be worth. **Save** stores the values in Redis, and **Restore defaults** goes back to `SCORING`.

- New values apply to games submitted after saving. Team totals already on the leaderboard do not change.
- A game in progress keeps the values it started with.
- After 10 wrong keys, an IP is locked out of the admin API for 10 minutes.

Before the first Single Player game the game asks for a team or player name (2–20 characters, saved in the browser). After a game, **Submit score** sends the full move log to `POST /api/score`. The server replays it through `js/rules.js` and `js/scoring.js`, rejects illegal moves and unfinished games, and computes the points itself; it ignores any score the client sends. It also allows one submission per 10 seconds per IP and accepts each game only once.

The leaderboard (`GET /api/leaderboard`) ranks teams by their total points over all submitted games, then by wins, then by who submitted first. It shows the top 20, highlights your team and refreshes every 15 seconds while it is open. If the API cannot be reached, the game keeps working: the score is saved on the device and sent the next time the leaderboard loads.

## Deploy on Vercel

1. Import the repository in Vercel. No framework preset and no build command are needed; `vercel.json` serves the folder as is and `api/` becomes the functions.
2. In the project, open **Storage** (or the **Marketplace**), add **Upstash for Redis**, and connect the database to the project. This sets the connection variables for you.
3. Check **Settings → Environment Variables**. The functions read either pair:
   - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN` (the names the Marketplace integration may use).
   Also add `ADMIN_KEY`: a long random password for `/admin.html` (for example the output of `openssl rand -hex 16`). Without it the admin page shows "Admin is off".
   Never commit these values.
4. Redeploy so the functions pick up the variables, then open `/api/leaderboard`. It should return `{"ok":true,"teams":[]}`. A `503 not-configured` response means the variables are missing.

Local testing with the real functions:

```bash
npm install
npm i -g vercel        # once
vercel link            # once, links the folder to the Vercel project
vercel env pull        # writes .env.local with the Redis variables (git-ignored)
vercel dev             # serves the game and /api on http://localhost:3000
```

With `npx serve .` the game runs, but `/api` does not exist, so the leaderboard shows "Leaderboard offline". That is expected.

### Reset the leaderboard before the event

Open the database in the Upstash console (Vercel → Storage → your database → Open in Upstash), go to the **CLI** tab, and run:

```
DEL kt:total kt:wins kt:games kt:name kt:first
```

That clears every team and keeps the admin's point values (`kt:rules`). Rate-limit and duplicate-game keys (`kt:rl:*`, `kt:game:*`) expire on their own. If the database is used only by this game, `FLUSHDB` does the same in one step.

## Run the game

The AI runs in a module Web Worker, so the page has to come from a web server. Opening `index.html` as a file will not work.

```bash
cd KnightTrap
npx serve .            # or: python -m http.server 8000
```

Then open the printed URL, for example http://localhost:3000.

Online play loads PeerJS 1.5.4 from unpkg and uses the public PeerJS broker (0.peerjs.com) only to connect the two players. After that, moves go directly between the browsers. Both players need internet access. On some strict networks (for example a symmetric NAT without a TURN server) a direct WebRTC connection can fail. Single Player and Local mode work fully offline, apart from the Google Fonts, which fall back to system fonts.

## Run the tests

```bash
node tests/run.mjs           # full run: 100 games per level per opponent (about 4–5 minutes)
node tests/run.mjs --quick   # 20 games per match-up (about 25 seconds)
```

This needs Node 18 or newer and no packages (the API tests use an in-memory Redis stand-in). The script checks:

1. **Rules**: legal jumps, burning, trap placement, the occupied-square block, loss detection, and serialization.
2. **Alpha-Beta correctness**: 30 positions from seeded random play of 4–8 turns (seeds `20261028 + k`, printed). Alpha-Beta and plain Minimax must return identical scores and moves at depths 1, 2 and 3. It prints the node counts for both.
3. **Strength**: each level plays 100 games against a random player and 100 against a greedy player, alternating who moves first, with the 4-second limit on. Medium and above must win at least 90% against random.
4. **Response time**: average, p95 and maximum think time per level. Every level must stay under 4 s, and Easy through Hard under 1 s.
5. **Online host validation**: drives the real `Game` class as host and checks that it rejects out-of-turn and illegal guest moves and accepts a legal one.
6. **Points and leaderboard**: the per-move points and win bonus at all four levels, no points in Local or Online mode, and the server: a tampered move log, a forged score, an unfinished game, the rate limit, duplicate games, team totals and tie-breaking, the admin point values (validation, wrong key, lockout, saved values used for new submissions, reset), plus all three `/api` handlers.

The script exits with code 1 if any check fails.

## Files

```
index.html          screens and markup, plus the knight SVG symbol
css/style.css       all styling: responsive layout and reduced-motion support
js/config.js        start squares, difficulty depths, AI limits, network, scoring and leaderboard constants
js/rules.js         game rules, the single source of truth (no DOM)
js/scoring.js       points for a move log, team-name cleaning (no DOM; shared with the API)
js/ai.js            Minimax + Alpha-Beta, BFS/DFS evaluation, random and greedy baselines
js/ai.worker.js     runs ai.js off the main thread
js/ai-client.js     promise wrapper around the worker (falls back to the main thread)
js/game.js          turn flow for every mode, and host-side move validation
js/board.js         board rendering, jump arc animation, burn and trap effects
js/net.js           PeerJS room create/join, heartbeat, disconnect handling
js/main.js          screens, menus, settings, online lobby, and the side panels
js/fx.js            canvas particles and the ember background
js/audio.js         WebAudio-synthesized sound effects
js/i18n.js          Bahasa Indonesia (default) and English strings
api/score.js        POST /api/score: replay a finished game and add its points
api/leaderboard.js  GET /api/leaderboard: top 20 teams
api/config.js       GET /api/config: point values; POST (with ADMIN_KEY): change them
admin.html          admin page for the point values (js/admin.js)
js/points-table.js  the "points per level" table used by the game and the admin page
api/_lib/           Redis client and leaderboard storage (not deployed as endpoints)
vercel.json         static hosting of the folder, JS module headers
tests/run.mjs       the test runner described above
```

## Proposal requirements → implementation

| Proposal requirement | Where |
|---|---|
| 7×7 board, turns, L-shaped knight jump | `js/rules.js` (`NEIGHBORS`, `legalJumps`) |
| Square left behind burns | `js/rules.js` `applyJump` |
| Destroy one open square as a trap after jumping | `js/rules.js` `applyTrap`, `validateMove` |
| Cannot land on burned, trap or occupied squares | `js/rules.js` `isOpen` |
| No legal jump on your turn = you lose | `js/rules.js` `winner` |
| Board is a 1-D array of 49 cells (empty/burned/trap) plus two knight positions | `js/rules.js` `createState` |
| Knight neighbors precomputed once | `js/rules.js` `NEIGHBORS` |
| Make/undo on the same board, no copying | `js/ai.js` `make` / `unmake` |
| Minimax with Alpha-Beta, AI = MAX, follows the pseudocode in Figure 2.1.1 | `js/ai.js` `search` → `ab` |
| Alpha-Beta on/off switch | `prune` option in `js/ai.js`; switches in Single Player setup and the in-game panel |
| BFS territory + 0.5 × mobility difference (ties go to the side to move) | `js/ai.js` `bfs`, `evaluate` |
| DFS flood fill to detect a split board and score by area difference | `js/ai.js` `dfs`, `evaluate` |
| Difficulty depths: Easy 1, Medium 2, Hard 3, Expert 4 | `js/config.js` `DIFFICULTY` |
| At most 12 trap candidates (opponent's jump targets, then squares two jumps away) | `js/ai.js` `trapCandidates` |
| Move ordering by static evaluation at remaining depth ≥ 2 | `js/ai.js` `orderMoves` |
| 4-second limit; on timeout, return the best fully evaluated move | `js/ai.js` `search` (deadline + `timedOut`) |
| Stats panel: depth, positions examined, branches pruned, time, score | `js/main.js` `ui.stats`, `#ai-panel` in `index.html` |
| Input/output: board, knights, turn, depth, pruning flag → (jump, trap) + stats | `js/ai.worker.js` message in/out |
| Comparison with plain Minimax on 30 seeded positions, identical scores | `tests/run.mjs` section 2 |
| Win rate against random and greedy baselines, 100 games per level | `tests/run.mjs` section 3 |
| Response time per level (< 4 s; Easy–Hard < 1 s) | `tests/run.mjs` section 4 |
| Runs in the browser with HTML, CSS and JavaScript | the whole project, no build step |

The AI uses only Minimax, Alpha-Beta Pruning, BFS and DFS, as the assignment requires. There are no transposition tables, no MCTS and no learned models.

## Design decisions not fixed by the proposal

- **Start squares**: P1 (blue) starts on a1, P2 (orange) on g7, and P1 moves first (`START` in `js/config.js`). In Single Player, whoever moves first plays blue.
- **Split-board weight**: when the board is split, the area difference is multiplied by 100 so it always outranks a territory score (`SPLIT_WEIGHT` in `js/ai.js`).
- **Terminal scores**: ±1,000,000 adjusted by depth, so the AI prefers faster wins and slower losses.
- **Greedy baseline**: jumps to the square with the most follow-up jumps, then traps the opponent's best follow-up square.
- **Online**: the room creator hosts and is authoritative. It checks every guest move with `rules.js` and replies with `reject` plus the true state when a move is illegal. Sides swap on each rematch.
- **Trap hints**: in trap mode, the squares your opponent could jump to next are striped, so new players can see the good trap targets.
- **Undo jump**: before you place your trap you can take back the jump (the "Undo jump" button, a click on your knight, or Esc). This changes nothing for the AI or the opponent, because a turn only counts once its trap is placed.
