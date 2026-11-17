# Multiplayer

Gladiators matches run through a small match server. There are two kinds:

- **Free-for-all** (the open queue, the menu's main button): up to four fighters, one per gate (north, south, east, west). Last one standing wins.
- **Duel** (friend codes): one-on-one, with rematches.

The server groups players and relays their messages; it does **not** simulate the fight. Each browser simulates its own fighter and trusts what the others report about theirs.

Code:
- `src/net.ts`: client connections, matchmaking requests, keep-alive.
- `src/main.ts`: match flow, message handling, combat authority.
- `server/server.ts`: matchmaking and relay.
- `server/run.sh`, `server/deploy.sh`: build-and-start, and deploy to the class box.
- `server/smoke.ts`: end-to-end test.

`src/relay.ts` and `database.rules.json` belong to the earlier peer-to-peer version and are no longer used.

## Connections

Each client holds two connections to the server:

| Connection | Protocol | Carries |
|---|---|---|
| WebSocket | TCP, TLS in production (`wss://`) | matchmaking, WebRTC signaling, every game event, in order |
| WebRTC data channel `state` | SCTP over DTLS over **UDP** | fighter state at 30 Hz, unordered, never retransmitted |

When the server runs with `UDP_PORT` set, it creates the data channel and sends the offer over the WebSocket as soon as a client connects. The browser answers, and the two swap ICE candidates over the same WebSocket. If the channel never opens (UDP blocked on that network, or `UDP_PORT` unset), state goes over the WebSocket instead, on both legs of the relay. Nothing else changes. The class box currently runs without UDP (see below).

### Why UDP for state

State packets only matter until the next one arrives, 33 ms later. Over TCP, or a reliable data channel, one lost packet holds up everything behind it while it is resent (head-of-line blocking), which shows up as the opponent stuttering. On the unordered, no-retransmit channel a lost packet is simply skipped. Each state frame carries a sequence number `n`, and the receiver drops any frame older than the newest it has seen.

Events (`hit`, `atk`, `dead`, ...) must arrive exactly once and in order, so they stay on the WebSocket.

## Protocol stack

```
          Events + signaling                 Fighter state
        ┌──────────────────────┐        ┌──────────────────────┐
  app   │ JSON frames {op,...} │        │ JSON {op:'s', n, m}  │
        ├──────────────────────┤        ├──────────────────────┤
        │ WebSocket            │        │ WebRTC data channel  │
        │ TLS (via Caddy)      │        │ SCTP (unordered,     │
        │                      │        │   maxRetransmits 0)  │
        │                      │        │ DTLS (encryption)    │
        │                      │        │ ICE                  │
  wire  │ TCP :443             │        │ UDP :UDP_PORT        │
        └──────────────────────┘        └──────────────────────┘
          browser ⇄ Caddy ⇄ node          browser ⇄ node
```

**Opening the state channel:**

1. **Signaling:** on connect, the server creates a `PeerConnection` (node-datachannel / libdatachannel) and a data channel. It sends its SDP offer and ICE candidates over the WebSocket, and the browser replies with its answer and candidates.
2. **ICE:** the server's candidate is its public IP on `UDP_PORT`. Every client shares that one port (ICE UDP mux), so the firewall needs only one UDP port open. The browser reaches it directly. STUN (Google) only helps the browser learn its own public address.
3. **DTLS handshake:** sets up encryption. Each side checks the other's certificate against the fingerprint in the SDP.
4. **SCTP:** opens the `state` channel inside DTLS.

**Encryption:**
- The WebSocket is TLS from the browser to Caddy, then plain HTTP on localhost to the Node process.
- The data channel is DTLS from the browser to the Node process.
- The server reads every message, because it relays them.

## Wire format

WebSocket frames are JSON objects with an `op`:

| Direction | `op` | Meaning |
|---|---|---|
| client → server | `find {mode, code?, name?}` | join the free-for-all queue (`queue`), wait on a friend code (`host`), or dial one (`join`). `name` is a guest's typed name |
| | `vote {on}` | in a free-for-all lobby: vote to start now (or take it back) |
| | `msg {m, to?}` | a game event: for the fighter in seat `to`, or for everyone else |
| | `s {n, m}` | fighter state, only when the data channel is down |
| | `rtc {answer}` / `rtc {candidate}` | WebRTC signaling |
| | `ping` | keep-alive, once a second |
| server → client | `lobby {seat, players}` | free-for-all lobby: who is in it (`[{seat, name, vote}]`), sent whenever it changes |
| | `start {seat, mode, players}` | the match begins. `seat` (0–3) is also the gate: 0 north, 1 south, 2 east, 3 west |
| | `fail {why}` | `taken` (code in use) or `missing` (nobody waiting on that code) |
| | `msg {m, from}` | another fighter's event, with their seat |
| | `s {n, m, from}` | another fighter's state, when this client's data channel is down |
| | `rtc {offer}` / `rtc {candidate}` | WebRTC signaling |
| | `left {seat}` | that fighter left the match (closed the tab, or chose to leave) |
| | `pong` | keep-alive reply |

Data channel frames are `s` only, in both directions. The server stamps each state frame with the sender's seat (`from`) and forwards it to every other fighter: over their data channel if it is open, otherwise over their WebSocket. Sequence numbers (`n`) are per sender.

## Matchmaking (server)

- **Free-for-all queue:** one lobby fills at a time, up to four (`FFA_SIZE`). Each newcomer takes the first free seat. The lobby starts by itself when full, or earlier once at least two are in and **every** one of them has voted (`vote`, key **V** in the game). Anyone leaving the lobby frees their seat; the votes of those left still count.
- **Friend codes (duels):** `host` registers the code (5 characters, no look-alikes) or gets `fail taken`, in which case `main.ts` silently picks a new code. `join` starts a duel with whoever holds the code (host in seat 0, friend in seat 1), or gets `fail missing`.
- **Names:** an account fights under its username; a guest under the name sent with `find`. `lobby` and `start` carry everyone's names, so nobody can fight under a registered player's name.
- **One search per WebSocket.** Cancelling a search, leaving a match or finding a new match all close the socket and open a new one.
- If the server can't be reached, or the connection drops before the match starts, the client reports `unreachable` ("Could not reach the match server").

## Keep-alive

- The client pings every second from a Web Worker timer, which browsers don't throttle in background tabs.
- Both client and server treat 20 s of silence as a dropped connection (`SILENT_MS`).
- A closed tab is noticed at once: the WebSocket closes and the server sends `left {seat}` to everyone else in the match.
- While a tab is hidden there are no animation frames, so a 250 ms `setInterval` in `main.ts` keeps the match clock and bleeding running and sends a "standing still" state.

## Game messages (`Msg`)

The `m` inside `msg` and `s` frames. Defined in `src/net.ts`.

| Message | When | Payload |
|---|---|---|
| `gear` | once, when the match starts | equipped item ids per slot |
| `s` | 30 Hz (`SEND_HZ`) | position, velocity, facing, aim yaw, move input, flag bits (1 free, 2 backpedal, 4 ragdolled, 8 blocking), health 0..1 |
| `atk` | a move starts | move kind, facing, aim height, dodge direction |
| `rel` | heavy charge released | — |
| `hit` | attacker saw its blade connect (sent `to` the victim's seat) | zone, raw damage, weapon edge, push direction, poise damage |
| `parried` | victim parried the blow (sent `to` the attacker) | — |
| `blocked` | victim blocked the blow (sent `to` the attacker) | — |
| `dead` | fighter died | — |
| `rematch` | duels only: wants another bout on the same connection | — |
| `leave` | gone for good (the server turns it into `left` for the others) | — |

Everything else goes to every other fighter in the match.

## Authority: who decides what

The fight is still decided by the clients. The server only relays.

**The attacker decides whether a blow lands.** `resolveStrike` sweeps the weapon segment in 4 sub-steps per frame against every standing opponent's body parts as seen on the attacker's screen. It allows one hit per opponent per swing (a wide swing can catch two) and sends each `hit` to its victim. Riposte damage (×3 within 1.3 s of a successful parry) is also applied by the attacker.

**The victim decides what the blow does.** On `hit`, the victim's machine applies, in order:

1. Dodge invulnerability: the hit is ignored.
2. Parry, if the blow comes from the front (within about 70°): reply `parried`, and the attacker reels open to a riposte.
3. Block from the front: costs stamina (`BLOCK_STAMINA`), lets a little damage through (`BLOCK_CHIP`), and replies `blocked`. Without enough stamina the guard breaks and half the damage gets through.
4. Otherwise: armour protection for the struck zone, then damage, bleeding, and poise damage (stagger or a shove).

**Displaying the other fighters (`updateFoes`).** Each opponent's inputs are replayed through the same character code that drives the local player. Its position is pulled toward the last reported position, extrapolated by velocity × message age (age capped at 250 ms). It eases in normally and snaps if more than 3 m off. `atk` and `rel` force the matching moves.

## Validation and trust

**Server:**
- Frames are limited to 2000 bytes and 120 per second per client. A client that goes over is disconnected.
- Malformed JSON gets a client disconnected.
- Friend codes are checked against the code alphabet.
- WebSocket connections are accepted only from the origins in `ORIGINS`.
- Game messages are forwarded without inspection.

**Client:** everything from the opponent is untrusted.
- Numbers are clamped through `num()`.
- Gear ids must exist in `ITEMS` and fit their slot. Move kinds and zones are checked against their lists. Names go through `cleanName`.

There is **no cheat prevention**, because clients are authoritative: a modified client could fake hits (damage is clamped to 0–200 per hit), ignore hits, or misreport health. With a server in the middle, server-side checks can be added later, such as hit plausibility (distance, timing) or fully authoritative simulation.

## Accounts and leaderboard

Optional. Guests play as before; logged-in players keep their inventory and a win/loss record.

- **Storage:** `server/accounts.ts` keeps everything in one JSON file, `DATA_FILE` (default `server/data/accounts.json`, gitignored). Writes go to a temp file that is renamed over the old one. Back this file up: it is the whole account database.
- **Passwords:** never stored. Each account has a random salt and a scrypt hash. Logins compare hashes in constant time, and unknown names are hashed too, so reply timing doesn't reveal which names exist.
- **Usernames:** 3–16 letters, digits or `_`, unique ignoring case.
- **Sessions:** logging in returns a random token, which the client keeps in localStorage. The file stores only the token's SHA-256. Sessions last 30 days.
- **Limits:** 30 logins or sign-ups per address per minute (the real address comes from `X-Forwarded-For` when behind the local proxy). After 5 wrong passwords in a row an account refuses logins for a minute. Saved progress is capped at 1500 characters.
- **Requests** (any WebSocket): `register` / `login {id, name, password}`, `resume {id, token}`, `logout {token}`, `save {id, token, progress}`, `board {id}`. Each is answered by `reply {id, ok, ...}`.
- **Recording results:** `find` may carry the session `token`. The server settles each bout itself: a fighter who sends `dead` has fallen, one who leaves mid-bout has fled, and the last one standing wins. A logged-in winner gets the win's XP and gold, and each logged-in fighter who fell (not fled, and not the winner's own account) records a loss against them. Everyone involved then gets a `profile` frame. In a duel, a new bout starts once both send `rematch`.
- **Leaderboard:** the 10 accounts with the most wins (ties: fewer losses, then the older account). The menu shows it, with the leader starred.
- **Career** (`src/career.ts`, with a server copy in `server/career.ts`; keep the two in step):
  - Each win: +100 XP and +50 gold.
  - Next level needs `100 + 25 × (level − 1)` XP.
  - Each level brings +1 skill point and +100 gold. Points raise strength, stamina, health or agility, up to 10.
  - **Logged in:** the server awards a win's XP and money when it settles the bout (against an account or a guest) and pushes the new career in the `profile` frame. `spend {id, token, stat}` spends a point after checking there is one and the stat isn't at its cap.
  - **Guests:** the client awards wins itself and keeps the career in localStorage only.
  - **Sign-up:** `register` may carry `career`, the guest's, which the server cleans (whole numbers in range, points recomputed, stats reset if they claim more raises than the level allows). The browser then clears its local copy.
  - A win where every opponent fled (nobody fell) earns nothing, and stats are fixed for the length of a bout.
- **Items and shop:**
  - Everyone starts with the wooden sword and loincloth (`STARTER`). Everything else is bought with gold. Prices are in `src/items.ts` (`price`), with a server copy in `server/shop.ts`; keep the two in step.
  - The server keeps each account's `owned` list. `buy {id, token, item}` checks the price and that the item isn't already owned. `save` refuses any arrangement holding an item the account doesn't own, or one item twice.
  - Guests keep owned items and gear in localStorage. Signing up carries them over (`owned` and `progress` in `register`).
  - Bumping `GEAR_VERSION` in `server/accounts.ts` resets every account to the starting kit at the next server start, keeping level and gold.
- **Admins:** `cd server && npm run make-admin -- <name>` asks for a password and stores only its hash in `data/admins.json` (`ADMINS_FILE`, gitignored, read at each admin login, so no restart is needed). Admins own every item, and nobody can register an admin's name. For `npm run dev` only, `VITE_DEV_ADMIN_PASSWORD` in `.env.development.local` lets `admin` log in when the server can't be reached. Production builds drop that code and the password.
- **Limit:** since clients are authoritative, a modified client can still fake hits, and two accounts owned by one person can trade wins. A guest career lives in the browser, so it can be edited before it is carried into a new account.

## Match flow

1. **lobby** (the main menu) → **searching** (`findOpponent` opens a WebSocket and sends `find`). Queueing or holding a code puts the player in the north gateway room to wait; joining a code waits on the menu.
2. `start` → send `gear`, then `beginMatch` puts every fighter in the gateway room for their seat, healed, with gear locked and gates shut.
3. **countdown** (4 s) → **fight**: every occupied gate rises, and each drops again once its fighter is 3 m out on the sand.
4. Falling (`dead`) → **over** with Defeat. A fighter whose every opponent has fallen or fled → **over** with Victory. In a free-for-all the fallen can stay and watch the rest.
5. A free-for-all ends there: **Find a new match** or **Main menu**. A duel may rematch: within 20 s (`REMATCH_WINDOW`) both send `rematch` to fight again on the same connection. Leaving sends `leave`, and the socket closes after a 300 ms grace period so the message gets out.

## Running and deploying

The server lives in `server/` and builds with `tsc` to `server/dist/server.js`, which runs on any Node 18+. Settings come from the environment:

- `PORT`: WebSocket port (default 8080).
- `UDP_PORT`: the shared UDP port for state channels. Unset means no data channels, and state goes over the WebSocket.
- `ORIGINS`: allowed page origins, comma separated. Unset means any origin.

**Anywhere** (your laptop, any box): `server/run.sh` (or `npm run server` from the repo root) installs, builds and starts the server in the foreground. Run the game with `npm run dev`. With `VITE_SERVER_URL` unset, it connects to `ws://<page host>:8080`.

**Smoke test:** from `server/`, run `npm run smoke -- ws://localhost:8080`. It runs a duel by code (events, state over UDP if the server offers it or else the WebSocket, and the left notice), then a three-fighter free-for-all (shared lobby, unanimous vote to start, a message to one seat, a fall, a leave).

**Class box (codehw):** the repo is cloned to `~/projects/gladiators`, and the server runs as the `svc` service `<STUDENT>-duel` on the student's `$PORT`. The box's Caddy proxies `https://<STUDENT>.api.codehw.net` (and `wss://`) to it, with TLS and CORS. To deploy what is pushed to GitHub:

```
DUEL_HOST=<class account>@<server> STUDENT=<student> server/deploy.sh
```

It clones the repo on first use, then pulls, rebuilds and restarts. Keep the account and address in your shell environment, never in the repo (class rules). On the box itself, `cd ~/projects/gladiators && git pull && server/run.sh` does the same thing. Logs: `svc logs duel`.

The class box's firewall only allows TCP 22, 80 and 443, so the server runs there without `UDP_PORT`, and all traffic, state included, goes over the WebSocket. Enabling UDP would need a teacher to open one UDP port to the student, plus `UDP_PORT=<port>` in the service.

**Game:** set `VITE_SERVER_URL=wss://<STUDENT>.api.codehw.net` in `.env.production`, then run `npm run deploy` (Firebase Hosting only).
