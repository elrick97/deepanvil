import type { ClientCommand, ForgeEvent } from '@deepanvil/shared';

// Bell alerts on your phone. Registers the service worker, and offers an "alerts" toggle.
// iPhone rule: web push only works once Deepanvil is installed to the Home Screen.

type Send = (cmd: ClientCommand) => boolean;

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class Alerts {
  private btn: HTMLButtonElement;
  private send: Send;
  private publicKey?: string;
  private reg?: ServiceWorkerRegistration;

  constructor(container: HTMLElement, send: Send) {
    this.send = send;
    this.btn = Object.assign(document.createElement('button'), { className: 'sound-btn', type: 'button' });
    this.btn.setAttribute('aria-label', 'Bell alerts');
    this.btn.hidden = true;
    this.btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.enable();
    });
    container.appendChild(this.btn);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((r) => {
        this.reg = r;
        void this.refresh();
      }, (err) => console.warn('[alerts] service worker failed', err));
    }
  }

  handle(e: ForgeEvent): void {
    if (e.type !== 'push.config') return;
    this.publicKey = e.publicKey;
    void this.refresh();
  }

  private label(text: string, title: string): void {
    this.btn.hidden = false;
    this.btn.textContent = text;
    this.btn.title = title;
  }

  /** Show the right state, and re-send an existing subscription (the forge may have lost it). */
  private async refresh(): Promise<void> {
    if (!this.reg || !this.publicKey) return;
    if (!('PushManager' in window) || !('Notification' in window)) {
      if (isIOS() && !standalone()) this.label('🔕 alerts', 'Add Deepanvil to your Home Screen (Share → Add to Home Screen) to get bell alerts');
      return;
    }
    if (Notification.permission === 'denied') return this.label('🔕 alerts blocked', 'Notifications are blocked in your browser settings');
    const sub = await this.reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
      this.send({ type: 'push.subscribe', subscription: sub.toJSON() as never });
      return this.label('🔔 alerts', 'Bell alerts are on');
    }
    this.label('🔕 alerts', 'Tap to get a notification when a smith rings the bell');
  }

  private async enable(): Promise<void> {
    if (!this.reg || !this.publicKey) return;
    if (!('PushManager' in window)) {
      alert(isIOS() ? 'On iPhone: tap Share → “Add to Home Screen”, open Deepanvil from there, then tap alerts again.' : 'This browser does not support push notifications.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return this.refresh();
    const sub =
      (await this.reg.pushManager.getSubscription()) ??
      (await this.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(this.publicKey) }));
    this.send({ type: 'push.subscribe', subscription: sub.toJSON() as never });
    this.label('🔔 alerts', 'Bell alerts are on');
  }
}
