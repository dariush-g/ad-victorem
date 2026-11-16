/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The duel server's WebSocket, e.g. wss://duel.example.com. Unset: ws://<this page's host>:8080, for local dev. */
  readonly VITE_SERVER_URL?: string;
  /** Firebase Realtime Database for the old peer-to-peer relay (src/relay.ts, no longer used). */
  readonly VITE_FIREBASE_DATABASE_URL?: string;
}
