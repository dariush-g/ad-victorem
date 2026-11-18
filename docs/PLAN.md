# Plan: Gladiators multiplayer

## Who is there together

Two to four people in one arena, fighting at the same moment.

- **Free-for-all:** strangers from the open queue. The lobby starts when four people are in it, or earlier once at least two are in and every one of them has voted to start.
- **Duel:** two friends. One shares a 5-character code and the other types it in.

Each fighter enters from their own gate (north, south, east, west). The last one standing wins.

## What one person does, and what the others see

| Action | What changes on everyone else's screen | How fast |
|---|---|---|
| Move, turn, aim, block | The fighter's position, facing, guard and health bar | Sent 30 times a second. Others see it within about 50–100 ms. Smoothing covers the gaps, and a fighter more than 3 m off snaps into place |
| Start an attack, dodge or parry | The same move plays on their fighter | Right away (one network trip), so the defender can react in time |
| Release a charged heavy blow | The swing comes down | Right away |
| Land a blow | The victim's screen decides: dodged, parried, blocked or hit. The victim staggers, bleeds or loses health, and the attacker sees a parry or block bounce back | One round trip. A late parry feels unfair |
| Fall | Their body ragdolls, and they drop out of the fight for everyone | Right away. This decides who wins |
| Vote to start (lobby) | The lobby list shows their vote | Under a second |

Fighter state is sent unreliably: only the newest copy matters, so a lost one is skipped. Events (attacks, hits, falls) must arrive exactly once and in order, so they go over the WebSocket.

## What everyone must agree on

**Who is still standing in the match.** The server holds the roster (seat, gate and name of each fighter) and marks each one as fallen or fled as `dead` and leave messages arrive. That decides the winner and the XP, gold and win/loss record that go with it. Moment-to-moment combat is decided by the players' own machines and is only relayed. The result is the one thing the server records for everyone.

## Joining and leaving

- **Late arrival:** a match is closed once it starts. Someone who queues while a fight is on starts a new lobby and sees the people waiting in it. The fight already running is unaffected. Within a lobby, a newcomer takes the first free gate and everyone's lobby list updates.
- **Closing the tab:** the server notices at once and tells everyone else (`left`). That fighter disappears from the arena and counts as fled: they don't win, and they don't record a loss either. If only one fighter is left, that fighter wins. A connection that dies without closing (wifi drop) counts as gone after 20 seconds of silence.
- **Hidden tab:** the player stays in the match and keeps sending a "standing still" state, so they don't drop out by accident.
- **After a fall:** in a free-for-all the fallen can stay and watch the rest of the fight.

## Why it is better together

Alone, it is a dummy you swing at. The game is about reading another person: timing a parry against someone's real rhythm, baiting a heavy blow, and deciding whether to hold back while two others wear each other down. Gear and levels only mean something when someone you actually beat sees them, and a win only counts in the record when someone fell against you. Without the others there is no opponent, no stakes and nothing to prove.
