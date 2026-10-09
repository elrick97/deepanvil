import type { ClientCommand, ForgeEvent } from '@deepanvil/shared';

// Your hands on the forge: ask Thráin for a quest, approve or redraw his blueprint,
// and answer the bell when a smith wants permission. All plain DOM, phone-friendly.

type Send = (cmd: ClientCommand) => boolean;

interface Ask {
  requestId: string;
  dwarfId: string;
  action: string;
}

export class Controls {
  private composer: HTMLFormElement;
  private input: HTMLInputElement;
  private bell: HTMLElement;
  private send: Send;
  private names: Map<string, string>;
  private asks: Ask[] = [];
  private live = false;
  private busy = false;
  /** The quest is being forged: the composer becomes a way to change the plan. */
  private forging?: string;

  constructor(root: HTMLElement, send: Send, names: Map<string, string>) {
    this.send = send;
    this.names = names;
    root.innerHTML = `
      <div class="bell-card hud-card" data-bell hidden></div>
      <form class="composer hud-card" data-composer hidden>
        <input data-input type="text" enterkeyhint="send" autocomplete="off" maxlength="2000"
               placeholder="Ask Thráin for a quest…" aria-label="Quest for the Forgemaster" />
        <button class="btn btn-primary" type="submit" data-send aria-label="Send quest">⚒</button>
        <button class="btn btn-stop" type="button" data-stop aria-label="Stop the quest" hidden>⏹ Stop</button>
      </form>`;
    this.composer = root.querySelector('[data-composer]')!;
    this.input = root.querySelector('[data-input]')!;
    this.bell = root.querySelector('[data-bell]')!;

    this.composer.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      if (this.forging) {
        // Mid-quest the same box rescopes: Thráin looks at where everything stands and proposes a re-cut.
        if (this.send({ type: 'quest.rescope', questId: this.forging, note: text })) {
          this.input.value = '';
          this.input.blur();
        }
        return;
      }
      if (this.busy) return;
      if (this.send({ type: 'quest.request', text })) {
        this.input.value = '';
        this.input.blur();
        this.setBusy(true);
      }
    });
    root.querySelector('[data-stop]')!.addEventListener('click', () => {
      if (confirm('Stop the current quest? Smiths down tools; finished pieces stay merged.')) this.send({ type: 'quest.abort' });
    });
    this.bell.addEventListener('click', (ev) => {
      const btn = (ev.target as Element).closest<HTMLButtonElement>('button[data-req]');
      if (!btn) return;
      this.send({ type: 'permission.answer', requestId: btn.dataset.req!, approved: btn.dataset.ok === '1' });
      btn.closest('.bell-row')?.classList.add('answered');
    });
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (!busy) this.forging = undefined;
    const rescope = busy && !!this.forging;
    this.input.disabled = busy && !rescope;
    this.input.placeholder = rescope ? 'Change the plan… e.g. “skip the docs, add a CLI flag”' : busy ? 'The forge is busy…' : 'Ask Thráin for a quest…';
    this.input.setAttribute('aria-label', rescope ? 'Change the plan for Thráin' : 'Quest for the Forgemaster');
    // While busy, the send button becomes a stop button; while forging it stays, as the rescope button.
    const send = this.composer.querySelector<HTMLElement>('[data-send]')!;
    send.hidden = busy && !rescope;
    send.textContent = rescope ? '✎' : '⚒';
    send.setAttribute('aria-label', rescope ? 'Send the change to Thráin' : 'Send quest');
    this.composer.querySelector<HTMLElement>('[data-stop]')!.hidden = !busy;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'forge.status':
        this.live = e.mode === 'live';
        this.composer.hidden = !this.live;
        this.setBusy(e.busy && this.live);
        break;
      case 'blueprint.approved':
        if (!this.live) break;
        this.forging = e.questId;
        this.setBusy(this.busy);
        break;
      case 'permission.request':
        if (!this.live) break;
        this.asks.push({ requestId: e.requestId, dwarfId: e.dwarfId, action: e.action });
        this.renderBell();
        break;
      case 'permission.resolved':
        this.asks = this.asks.filter((a) => a.requestId !== e.requestId);
        this.renderBell();
        break;
    }
  }

  private renderBell(): void {
    this.bell.hidden = this.asks.length === 0;
    // Agent-provided text (commands, paths) goes in via textContent only.
    this.bell.replaceChildren(
      ...this.asks.map((a) => {
        const row = document.createElement('div');
        row.className = 'bell-row';
        const text = document.createElement('div');
        text.className = 'bell-text';
        text.textContent = `🔔 ${this.names.get(a.dwarfId) ?? a.dwarfId} asks to ${a.action}`;
        const yes = Object.assign(document.createElement('button'), { className: 'btn btn-primary', textContent: 'Allow' });
        yes.dataset.req = a.requestId;
        yes.dataset.ok = '1';
        const no = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Deny' });
        no.dataset.req = a.requestId;
        no.dataset.ok = '0';
        row.append(text, yes, no);
        return row;
      }),
    );
  }
}
