/**
 * Smoke test against a running server. Usage: npm run smoke -- [ws://localhost:8080]
 *
 *  1. Duel: a host and a friend meet by code, swap an event over the WebSocket and state over the
 *     UDP data channel (or the WebSocket, on a server without UDP), and the friend hears the host leave.
 *  2. Free-for-all: three fighters join the open queue, all vote to start, and the match begins with
 *     each in their own seat. A message addressed to one seat reaches only that fighter.
 */
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

const URL = process.argv[2] ?? 'ws://localhost:8080';

type Frame = { op: string; via: string; [k: string]: unknown };

function client(name: string, find: object) {
  const ws = new WebSocket(URL);
  let pc: RTCPeerConnection | null = null;
  let dc: { readyState: string; send(s: string): void } | null = null;
  const got: Frame[] = [];
  let started: (f: Frame) => void;
  const startP = new Promise<Frame>((r) => (started = r));
  let udpOpen: () => void;
  const udpP = new Promise<void>((r) => (udpOpen = r));
  ws.on('open', () => ws.send(JSON.stringify({ op: 'find', name, ...find })));
  ws.on('message', async (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.op === 'start') started({ ...f, via: 'ws' });
    if (f.op === 'rtc' && f.offer) {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.onicecandidate = (e: any) => e.candidate && ws.send(JSON.stringify({ op: 'rtc', candidate: e.candidate.toJSON() }));
      pc.ondatachannel = (e: any) => {
        dc = e.channel;
        e.channel.onopen = () => udpOpen();
        if (e.channel.readyState === 'open') udpOpen();
        e.channel.onmessage = (m: any) => got.push({ ...JSON.parse(m.data), via: 'udp' });
      };
      await pc.setRemoteDescription(f.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      ws.send(JSON.stringify({ op: 'rtc', answer: { type: 'answer', sdp: pc.localDescription!.sdp } }));
    } else if (f.op === 'rtc' && f.candidate && pc) await pc.addIceCandidate(f.candidate).catch(() => {});
    else if (f.op !== 'rtc') got.push({ ...f, via: 'ws' });
  });
  return {
    name, got, startP, udpP,
    event: (m: object, to?: number) => ws.send(JSON.stringify(to === undefined ? { op: 'msg', m } : { op: 'msg', m, to })),
    vote: () => ws.send(JSON.stringify({ op: 'vote', on: true })),
    state: (n: number) => {
      const raw = JSON.stringify({ op: 's', n, m: { t: 's', from: name } });
      if (dc?.readyState === 'open') dc.send(raw);
      else ws.send(raw); // no UDP on this server: state over the WebSocket
    },
    close: () => {
      pc?.close();
      ws.close();
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const timeout = (ms: number, what: string) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms));
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => {
  checks.push([what, ok]);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

// --- 1. duel by friend code ---
const a = client('A', { mode: 'host', code: 'ABCDE' });
await wait(300);
const b = client('B', { mode: 'join', code: 'ABCDE' });
const [sa, sb] = await Promise.race([Promise.all([a.startP, b.startP]), timeout(5000, 'duel start')]);
check('duel starts in seats 0 and 1', sa.mode === 'duel' && sb.mode === 'duel' && sa.seat === 0 && sb.seat === 1);
// a server without UDP_PORT offers no data channel: allow a moment, then carry on over the WebSocket
const udp = await Promise.race([Promise.all([a.udpP, b.udpP]).then(() => true), wait(3000).then(() => false)]);
console.log(udp ? '     udp channels open' : '     no udp: state over the WebSocket');
a.event({ t: 'atk', k: 'light' });
for (let n = 0; n < 5; n++) b.state(n);
await wait(500);
check('event relayed with its sender', b.got.some((f) => f.op === 'msg' && f.from === 0));
check('state relayed with its sender', a.got.some((f) => f.op === 's' && f.from === 1 && f.via === (udp ? 'udp' : 'ws')));
a.close();
await wait(500);
check('the friend hears the host leave', b.got.some((f) => f.op === 'left' && f.seat === 0));
b.close();

// --- 2. free-for-all from the open queue ---
const ffa = ['C', 'D', 'E'].map((n) => client(n, { mode: 'queue' }));
await wait(600);
const lobbies = ffa.map((c) => c.got.filter((f) => f.op === 'lobby').at(-1) as Frame | undefined);
check('three fighters share one lobby', lobbies.every((l) => Array.isArray(l?.players) && (l!.players as unknown[]).length === 3));
ffa[0].vote();
ffa[1].vote();
await wait(300);
check('no start until everyone has voted', ffa.every((c) => !c.got.some((f) => f.op === 'start')));
ffa[2].vote();
const starts = await Promise.race([Promise.all(ffa.map((c) => c.startP)), timeout(5000, 'ffa start')]);
check('free-for-all starts with three seats', starts.every((s) => s.mode === 'ffa' && (s.players as unknown[]).length === 3) && new Set(starts.map((s) => s.seat)).size === 3);
const [c0, c1, c2] = ffa, [s1, s2] = [starts[1].seat as number, starts[2].seat as number];
c0.event({ t: 'hit', zone: 'head' }, s1);
await wait(400);
check('a message to one seat reaches only that fighter', c1.got.some((f) => f.op === 'msg' && (f.m as { t: string }).t === 'hit') && !c2.got.some((f) => f.op === 'msg' && (f.m as { t: string }).t === 'hit'));
c1.event({ t: 'dead' });
await wait(300);
check('a fall is told to everyone else', c0.got.some((f) => f.op === 'msg' && f.from === s1 && (f.m as { t: string }).t === 'dead') && c2.got.some((f) => f.op === 'msg' && (f.m as { t: string }).t === 'dead'));
c2.close();
await wait(400);
check('the others hear a fighter leave', c0.got.some((f) => f.op === 'left' && f.seat === s2) && c1.got.some((f) => f.op === 'left' && f.seat === s2));
c0.close();
c1.close();

const ok = checks.every(([, v]) => v);
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
