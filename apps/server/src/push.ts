import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import { CREW, type ForgeEvent } from '@deepanvil/shared';
import type { Store } from './store.ts';

// Web Push: the bell rings on your phone. VAPID keys are generated once and kept in WSL
// (~/.deepanvil/vapid.json); subscriptions live in the forge's database.

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };

const names = new Map(CREW.map((d) => [d.id, d.name]));

export class Pusher {
  readonly publicKey: string;
  private store: Store;

  constructor(store: Store, path = join(homedir(), '.deepanvil', 'vapid.json')) {
    this.store = store;
    let keys: { publicKey: string; privateKey: string };
    if (existsSync(path)) keys = JSON.parse(readFileSync(path, 'utf8'));
    else {
      keys = webpush.generateVAPIDKeys();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(keys), { mode: 0o600 });
    }
    this.publicKey = keys.publicKey;
    webpush.setVapidDetails(process.env.DEEPANVIL_PUSH_SUBJECT ?? 'mailto:forge@deepanvil.dev', keys.publicKey, keys.privateKey);
  }

  /** Only real push services: the forge must not be talked into POSTing to arbitrary URLs. */
  subscribe(sub: Subscription): void {
    let url: URL;
    try {
      url = new URL(sub.endpoint);
    } catch {
      return;
    }
    const known = ['fcm.googleapis.com', 'web.push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
    if (url.protocol !== 'https:' || !known.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) {
      console.warn('[push] refused subscription to', url.hostname);
      return;
    }
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return;
    this.store.addPushSub(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }));
  }

  /** Turn the forge events you'd want in your pocket into notifications. */
  notifyFor(e: ForgeEvent): void {
    const who = (id: string) => names.get(id) ?? id;
    switch (e.type) {
      case 'permission.request':
        return this.send({ title: `🔔 ${who(e.dwarfId)} rings the bell`, body: `May I ${e.action}?`, tag: e.requestId, data: { requestId: e.requestId } });
      case 'permission.resolved':
        return; // the notification for it just goes stale; the bell card updates in-app
      case 'plan.questions':
        return this.send({ title: 'Thráin has questions', body: `${e.questions.length} quick question${e.questions.length === 1 ? '' : 's'} before he draws up the blueprint.`, tag: e.questId });
      case 'blueprint.proposed':
        return this.send({ title: 'Thráin’s blueprint is ready', body: `${e.title} — ${e.tasks.length} task(s). Light the forges?`, tag: e.questId });
      case 'merge':
        return this.send({ title: 'Into the minecart!', body: `Quest merged (${e.branch}).`, tag: e.questId });
      case 'offering.state':
        if (e.state !== 'awaiting_you') return;
        return this.send({ title: '⚖ Odin awaits your verdict', body: `An offering passed every gate${e.reason ? ` (${e.reason})` : ''}. Merge it?`, tag: e.offeringId });
      case 'vault.health':
        if (e.status !== 'red') return;
        return this.send({ title: 'The Vault of Main is cracked', body: `${(e.failing ?? []).join(' and ')} fail on main.`, tag: 'vault-health' });
      case 'forge.rest':
        return this.send(e.resting
          ? { title: '😴 The forge is resting', body: `Subscription limit reached${e.until ? `; work resumes around ${new Date(e.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.`, tag: 'forge-rest' }
          : { title: '⚒ The forge is awake', body: 'The limit has reset; the crew is back at work.', tag: 'forge-rest' });
      case 'forge.error':
        return this.send({ title: 'Trouble at the forge', body: e.message, tag: 'forge-error' });
    }
  }

  private send(payload: { title: string; body: string; tag: string; data?: Record<string, unknown> }): void {
    for (const { endpoint, json } of this.store.pushSubs()) {
      webpush.sendNotification(JSON.parse(json) as Subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }).catch((err: { statusCode?: number }) => {
        // Gone or unknown: the phone unsubscribed or reinstalled the app.
        if (err.statusCode === 404 || err.statusCode === 410) this.store.removePushSub(endpoint);
        else console.error('[push] failed', err.statusCode ?? err);
      });
    }
  }
}
