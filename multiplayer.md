# Multiplayer

Ad Victorem duels are one-on-one, through a small duel server. The server pairs players and relays their messages; it does **not** simulate the fight. Each browser simulates its own fighter and trusts what the other side reports about theirs.

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
| client → server | `find {mode, code?}` | join the queue (`queue`), wait on a friend code (`host`), or dial one (`join`) |
| | `msg {m}` | a game event for the opponent |
| | `s {n, m}` | fighter state, only when the data channel is down |
| | `rtc {answer}` / `rtc {candidate}` | WebRTC signaling |
| | `ping` | keep-alive, once a second |
| server → client | `paired {host}` | matched. The host fights from the north gate, the guest from the south |
| | `fail {why}` | `taken` (code in use) or `missing` (nobody waiting on that code) |
| | `msg {m}` | the opponent's event |
| | `s {n, m}` | the opponent's state, when this client's data channel is down |
| | `rtc {offer}` / `rtc {candidate}` | WebRTC signaling |
| | `gone` | the opponent disconnected |
| | `pong` | keep-alive reply |

Data channel frames are `s {n, m}` only, in both directions. The server forwards each state frame as-is: over the partner's data channel if it is open, otherwise over their WebSocket.

## Matchmaking (server)

- **Open queue:** at most one player waits. The next `find queue` pairs with them, and the waiting player becomes host.
- **Friend codes:** `host` registers the code (5 characters, no look-alikes) or gets `fail taken`, in which case `main.ts` silently picks a new code. `join` pairs with whoever holds the code, or gets `fail missing`.
- **One search per WebSocket.** Cancelling a search, leaving a match or finding a new opponent all close the socket and open a new one.
- If the server can't be reached, or the connection drops before pairing, the client reports `unreachable` ("Could not reach the duel server").

## Keep-alive

- The client pings every second from a Web Worker timer, which browsers don't throttle in background tabs.
- Both client and server treat 20 s of silence as a dropped connection (`SILENT_MS`).
- A closed tab is noticed at once: the WebSocket closes and the server sends `gone` to the partner.
- While a tab is hidden there are no animation frames, so a 250 ms `setInterval` in `main.ts` keeps the match clock and bleeding running and sends a "standing still" state.

## Game messages (`Msg`)

The `m` inside `msg` and `s` frames. Defined in `src/net.ts`.

| Message | When | Payload |
|---|---|---|
| `gear` | once, on pairing | equipped item ids per slot, fighter name |
| `s` | 30 Hz (`SEND_HZ`) | position, velocity, facing, aim yaw, move input, flag bits (1 free, 2 backpedal, 4 ragdolled, 8 blocking), health 0..1 |
| `atk` | a move starts | move kind, facing, aim height, dodge direction |
| `rel` | heavy charge released | — |
| `hit` | attacker saw its blade connect | zone, raw damage, weapon edge, push direction, poise damage |
| `parried` | victim parried the blow | — |
| `blocked` | victim blocked the blow | — |
| `dead` | fighter died | — |
| `rematch` | wants another bout on the same connection | — |
| `leave` | gone for good | — |

## Authority: who decides what

The fight is still decided by the clients. The server only relays.

**The attacker decides whether a blow lands.** `resolveStrike` sweeps the weapon segment in 4 sub-steps per frame against the opponent's body parts as seen on the attacker's screen. It allows one hit per swing and sends `hit`. Riposte damage (×3 within 1.3 s of a successful parry) is also applied by the attacker.

**The victim decides what the blow does.** On `hit`, the victim's machine applies, in order:

1. Dodge invulnerability: the hit is ignored.
2. Parry, if the blow comes from the front (within about 70°): reply `parried`, and the attacker reels open to a riposte.
3. Block from the front: costs stamina (`BLOCK_STAMINA`), lets a little damage through (`BLOCK_CHIP`), and replies `blocked`. Without enough stamina the guard breaks and half the damage gets through.
4. Otherwise: armour protection for the struck zone, then damage, bleeding, and poise damage (stagger or a shove).

**Displaying the remote fighter (`updateFoe`).** The opponent's inputs are replayed through the same character code that drives the local player. Its position is pulled toward the last reported position, extrapolated by velocity × message age (age capped at 250 ms). It eases in normally and snaps if more than 3 m off. `atk` and `rel` force the matching moves.

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

## Match flow

1. **lobby** → **searching** (`findOpponent` opens a WebSocket and sends `find`).
2. `paired` → send `gear`, then `beginMatch` puts both fighters in their gateway rooms, healed, with gear locked and gates shut.
3. **countdown** (4 s) → **fight**.
4. `dead` → **over**.
5. Within 20 s (`REMATCH_WINDOW`), both sides may send `rematch` to fight again on the same connection. Otherwise either sends `leave`, and the socket closes after a 300 ms grace period so the message gets out.

## Running and deploying

The server lives in `server/` and builds with `tsc` to `server/dist/server.js`, which runs on any Node 18+. Settings come from the environment:

- `PORT`: WebSocket port (default 8080).
- `UDP_PORT`: the shared UDP port for state channels. Unset means no data channels, and state goes over the WebSocket.
- `ORIGINS`: allowed page origins, comma separated. Unset means any origin.

**Anywhere** (your laptop, any box): `server/run.sh` (or `npm run server` from the repo root) installs, builds and starts the server in the foreground. Run the game with `npm run dev`. With `VITE_SERVER_URL` unset, it connects to `ws://<page host>:8080`.

**Smoke test:** from `server/`, run `npm run smoke -- ws://localhost:8080`. It pairs two fake clients and checks events, state (over UDP if the server offers it, otherwise the WebSocket) and the partner-left notice.

**Class box (codehw):** the repo is cloned to `~/projects/ad-victorem`, and the server runs as the `svc` service `<STUDENT>-duel` on the student's `$PORT`. The box's Caddy proxies `https://<STUDENT>.api.codehw.net` (and `wss://`) to it, with TLS and CORS. To deploy what is pushed to GitHub:

```
DUEL_HOST=<class account>@<server> STUDENT=<student> server/deploy.sh
```

It clones the repo on first use, then pulls, rebuilds and restarts. Keep the account and address in your shell environment, never in the repo (class rules). On the box itself, `cd ~/projects/ad-victorem && git pull && server/run.sh` does the same thing. Logs: `svc logs duel`.

The class box's firewall only allows TCP 22, 80 and 443, so the server runs there without `UDP_PORT`, and all traffic, state included, goes over the WebSocket. Enabling UDP would need a teacher to open one UDP port to the student, plus `UDP_PORT=<port>` in the service.

**Game:** set `VITE_SERVER_URL=wss://<STUDENT>.api.codehw.net` in `.env.production`, then run `npm run deploy` (Firebase Hosting only).
