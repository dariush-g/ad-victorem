# Gladiators

A browser arena fighter built with Three.js. Duel a friend with a 5-character code, or join a free-for-all of up to four players. Win bouts and slay opponents to earn experience and gold, level up your stats, and buy gear (weapons, shields, armor) from the shop.

## Run it

```sh
npm install
npm run dev        # game client (Vite)
npm run server     # duel/match server, port 8080 by default
```

Other scripts:

- `npm run build`: typecheck and build the client into `dist/`
- `npm run deploy`: build and deploy to Firebase Hosting
- `server/deploy.sh`: deploy the match server

## Layout

- `src/`: game client (arena, fighters, combat, ragdolls, inventory, networking)
- `server/`: WebSocket match server, accounts, careers, shop
- `docs/`: [PLAN.md](docs/PLAN.md) (multiplayer design), [multiplayer.md](docs/multiplayer.md), [todo.md](docs/todo.md)

## Accounts

Accounts are optional. Guests keep their career in browser storage. Logged-in players' careers live on the server, which does all the awarding.
