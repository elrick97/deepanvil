import type { ClientCommand, Envelope, ForgeEvent } from '@deepanvil/shared';

type Listener = (event: ForgeEvent) => void;

/** WebSocket link to the forge server, with gentle auto-reconnect. */
export class ForgeLink {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private retry = 500;
  connected = false;
  onStatus?: (connected: boolean) => void;

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.setStatus(true);
    };
    ws.onmessage = (msg) => {
      const env = JSON.parse(msg.data as string) as Envelope;
      for (const l of this.listeners) l(env.event);
    };
    ws.onclose = () => {
      this.setStatus(false);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  /** Send a command to the forge (ask for a quest, approve, answer the bell). */
  send(cmd: ClientCommand): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(cmd));
    return true;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(connected: boolean): void {
    this.connected = connected;
    this.onStatus?.(connected);
  }
}
