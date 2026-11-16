/**
 * Smoke test: two fake browsers pair through a running server, swap an event over the WebSocket,
 * and swap state over the UDP data channel. Usage: npm run smoke -- [ws://localhost:8080]
 */
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'node-datachannel/polyfill';

const URL = process.argv[2] ?? 'ws://localhost:8080';

function client(name: string, find: object) {
  const ws = new WebSocket(URL);
  let pc: RTCPeerConnection | null = null;
  let dc: { readyState: string; send(s: string): void } | null = null;
  const got: { op: string; via: string; m?: unknown }[] = [];
  let paired: (host: boolean) => void;
  const pairedP = new Promise<boolean>((r) => (paired = r));
  let udpOpen: () => void;
  const udpP = new Promise<void>((r) => (udpOpen = r));
  ws.on('open', () => ws.send(JSON.stringify({ op: 'find', ...find })));
  ws.on('message', async (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.op === 'paired') paired(f.host);
    else if (f.op === 'rtc' && f.offer) {
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
    name, got, pairedP, udpP,
    event: (m: object) => ws.send(JSON.stringify({ op: 'msg', m })),
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

const timeout = (ms: number, what: string) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms));
const a = client('A', { mode: 'host', code: 'ABCDE' });
await new Promise((r) => setTimeout(r, 300));
const b = client('B', { mode: 'join', code: 'ABCDE' });
const [ha, hb] = await Promise.race([Promise.all([a.pairedP, b.pairedP]), timeout(5000, 'pairing')]);
console.log('paired: A host', ha, '· B host', hb);
// a server without UDP_PORT offers no data channel: allow a moment, then carry on over the WebSocket
const udp = await Promise.race([Promise.all([a.udpP, b.udpP]).then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 3000))]);
console.log(udp ? 'udp channels open' : 'no udp: state over the WebSocket');
a.event({ t: 'atk', k: 'light' });
for (let n = 0; n < 5; n++) b.state(n);
await new Promise((r) => setTimeout(r, 500));
console.log('B got:', JSON.stringify(b.got));
console.log('A got:', JSON.stringify(a.got));
a.close();
await new Promise((r) => setTimeout(r, 500));
console.log('B after A left:', JSON.stringify(b.got.at(-1)));
b.close();
const ok = b.got.some((f) => f.op === 'msg') && a.got.some((f) => f.op === 's' && f.via === (udp ? 'udp' : 'ws')) && b.got.at(-1)?.op === 'gone';
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
