import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type JoinAccepted,
  type ServerToClientEvents,
} from '@grey/shared';

export type GameClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Socket wrapper plus clock sync. `serverNow()` estimates the server's clock so remote
 * entities can be interpolated on the server timeline.
 */
export class Connection {
  readonly socket: GameClientSocket;
  rtt = 0;
  private clockOffset = 0;
  private clockSynced = false;
  private pingTimer: number | undefined;

  constructor() {
    // Same origin: Vite proxies /socket.io in dev, the game server serves the build in prod.
    this.socket = io({ transports: ['websocket'], autoConnect: false, reconnection: false });
    this.socket.on('clockPong', (clientTime, serverTime) => {
      const now = performance.now();
      const rtt = now - clientTime;
      this.rtt = this.rtt === 0 ? rtt : this.rtt * 0.8 + rtt * 0.2;
      this.observeServerTime(serverTime + rtt / 2, 0.2);
    });
  }

  /** Feed a server timestamp (already latency-adjusted) into the clock estimate. */
  observeServerTime(serverTime: number, weight: number): void {
    const offset = serverTime - performance.now();
    if (!this.clockSynced) {
      this.clockOffset = offset;
      this.clockSynced = true;
    } else {
      this.clockOffset += (offset - this.clockOffset) * weight;
    }
  }

  serverNow(): number {
    return performance.now() + this.clockOffset;
  }

  join(username: string): Promise<JoinAccepted> {
    return new Promise((resolve, reject) => {
      const s = this.socket;
      const cleanup = () => {
        s.off('joinAccepted');
        s.off('joinRejected');
        s.off('connect_error');
      };
      s.once('joinAccepted', (msg) => {
        cleanup();
        this.observeServerTime(msg.serverTime, 1);
        this.startPinging();
        resolve(msg);
      });
      s.once('joinRejected', ({ reason }) => {
        cleanup();
        reject(new Error(reason));
      });
      s.once('connect_error', () => {
        cleanup();
        reject(new Error('Cannot reach the server. Is it running?'));
      });
      s.once('connect', () => s.emit('join', { protocol: PROTOCOL_VERSION, username }));
      s.connect();
    });
  }

  private startPinging(): void {
    const ping = () => this.socket.emit('clockPing', performance.now());
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    this.socket.disconnect();
  }
}
