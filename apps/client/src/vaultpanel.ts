import type { ClientCommand, ForgeEvent, GateName, GateStatus, VaultInfo } from '@deepanvil/shared';

// The Vault of Main as a panel (tap the door, or the "main" chip in the HUD): is main green, the
// rules Odin keeps (merge mode, gates and their commands, size limit, protected paths) and how
// the latest offerings fared: each gate with its output, and Odin's review. It refreshes while
// open, so you can watch a piece go through. Gate output and review text come from commands and a
// model, so they only ever go in via textContent.

type Send = (cmd: ClientCommand) => boolean;
type Offering = VaultInfo['recent'][number];

const STATE: Record<string, { icon: string; label: string }> = {
  merged: { icon: '✦', label: 'merged' },
  sent_back: { icon: '↩', label: 'sent back' },
  abandoned: { icon: '✕', label: 'abandoned' },
  awaiting_you: { icon: '⚖', label: 'waiting for you' },
  queued: { icon: '⏳', label: 'queued' },
  rebasing: { icon: '⏳', label: 'rebasing' },
  gates: { icon: '⏳', label: 'at the gates' },
  reviewing: { icon: '⏳', label: 'in review' },
};
const GATE: Record<GateStatus, string> = { running: '…', pass: '✓', fail: '✗', flaky: '~', skipped: '–' };
const GATE_NAME: Record<GateName, string> = { tests: 'Tests', types: 'Types', lint: 'Lint' };

export class VaultPanel {
  private root: HTMLElement;
  private send: Send;
  private names: Map<string, string>;
  private info?: VaultInfo;
  private health: { status: 'green' | 'red' | 'unknown'; failing?: string[] } = { status: 'unknown' };
  private open = new Set<string>();
  private visible = false;
  private repo?: string;
  private refresh?: ReturnType<typeof setTimeout>;

  constructor(root: HTMLElement, send: Send, names: Map<string, string>) {
    this.root = root;
    this.send = send;
    this.names = names;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'vault.health':
        this.health = { status: e.status, failing: e.failing };
        break;
      case 'vault.info':
        this.info = e.info;
        break;
      case 'forge.status':
        // The forge turned to another project: what we show is stale.
        if (this.repo !== undefined && this.repo !== e.repo) {
          this.info = undefined;
          this.open.clear();
          if (this.visible) this.send({ type: 'vault.open' });
        }
        this.repo = e.repo;
        break;
      case 'offering.opened':
      case 'offering.state':
      case 'offering.gate':
      case 'offering.review':
      case 'offering.merged':
        // Live while open: ask again shortly after things settle (events arrive in bursts).
        if (this.visible) {
          clearTimeout(this.refresh);
          this.refresh = setTimeout(() => this.send({ type: 'vault.open' }), 400);
        }
        return;
      default:
        return;
    }
    if (this.visible) this.render();
  }

  toggle(): void {
    this.visible = !this.visible;
    if (!this.visible) {
      clearTimeout(this.refresh);
      this.root.hidden = true;
      this.root.replaceChildren();
      return;
    }
    this.send({ type: 'vault.open' });
    this.render();
  }

  private render(): void {
    const panel = el('div', 'vaultp hud-card');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'The Vault of Main');

    const head = el('div', 'vp-head');
    const title = el('div', 'vp-title');
    title.textContent = 'Vault of Main';
    const chip = el('span', `vp-health vp-${this.health.status}`);
    chip.textContent = this.health.status === 'green' ? '🛡 main is green' : this.health.status === 'red' ? `🛡 main is red: ${(this.health.failing ?? []).join(', ')}` : '🛡 main not checked yet';
    const close = el('button', 'icon-btn');
    close.type = 'button';
    close.textContent = '✕';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close the vault panel');
    close.addEventListener('click', () => this.toggle());
    head.append(title, close);

    const body = el('div', 'vp-body');
    body.append(chip);
    if (this.info) {
      body.append(this.rules(this.info), this.recent(this.info));
    } else {
      const wait = el('div', 'vp-empty');
      wait.textContent = 'Odin is fetching the ledger…';
      body.append(wait);
    }
    panel.append(head, body);
    this.root.replaceChildren(panel);
    this.root.hidden = false;
  }

  private rules(info: VaultInfo): HTMLElement {
    const p = info.policy;
    const box = el('div', 'vp-rules');
    const mode = el('div', 'vp-line');
    mode.textContent = p.mode === 'auto' ? 'Odin merges what passes every gate and his review.' : 'Odin judges, then waits for your word before merging.';
    box.append(mode);
    for (const name of ['tests', 'types', 'lint'] as const) {
      const cmd = p.gates[name];
      const row = el('div', 'vp-line');
      const k = el('span', 'vp-k');
      k.textContent = GATE_NAME[name];
      const v = el('code', '');
      v.textContent = cmd ?? 'no command found: skipped';
      if (!cmd) v.className = 'vp-dim';
      row.append(k, v);
      box.append(row);
    }
    const limits = el('div', 'vp-line vp-dim');
    limits.textContent = `Pieces over ${p.maxDiffLines} lines go back to be split · gates time out after ${p.gateTimeoutSec}s · ${p.flakyRetries} retry for flaky gates`;
    box.append(limits);
    if (p.protectedPaths.length) {
      const prot = el('div', 'vp-line vp-dim');
      prot.textContent = `Always asks you before touching: ${p.protectedPaths.join(', ')}`;
      box.append(prot);
    }
    return box;
  }

  private recent(info: VaultInfo): HTMLElement {
    const wrap = el('div', 'vp-recent');
    const h = el('div', 'vp-sub');
    h.textContent = 'Recent offerings';
    wrap.append(h);
    if (!info.recent.length) {
      const none = el('div', 'vp-empty');
      none.textContent = 'Nothing has been offered yet.';
      wrap.append(none);
    }
    for (const o of info.recent) wrap.append(this.offering(o));
    return wrap;
  }

  private offering(o: Offering): HTMLElement {
    const box = el('details', 'vp-off');
    box.open = this.open.has(o.id);
    box.addEventListener('toggle', () => (box.open ? this.open.add(o.id) : this.open.delete(o.id)));
    const st = STATE[o.state] ?? { icon: '·', label: o.state };
    const sum = el('summary', `vp-sum vp-s-${o.state}`);
    const icon = el('span', 'vp-ico');
    icon.textContent = st.icon;
    const words = el('span', 'vp-words');
    const name = el('span', 'vp-name');
    name.textContent = o.title;
    const meta = el('span', 'vp-meta');
    meta.textContent = `${this.names.get(o.dwarfId) ?? o.dwarfId} · revision ${o.revision} · ${st.label}${o.reason ? ` (${o.reason})` : ''}${o.lines ? ` · ${o.lines} lines` : ''}`;
    words.append(name, meta);
    sum.append(icon, words);
    box.append(sum);

    const detail = el('div', 'vp-detail');
    if (o.gates.length) {
      const gates = el('div', 'vp-gates');
      for (const g of o.gates) {
        const chip = el('span', `chip gate-${g.status}`);
        chip.textContent = `${GATE[g.status]} ${GATE_NAME[g.gate]}${g.ms ? ` ${g.ms < 1000 ? `${g.ms}ms` : `${(g.ms / 1000).toFixed(1)}s`}` : ''}`;
        gates.append(chip);
      }
      detail.append(gates);
      // The output of anything that did not pass: what Odin saw.
      for (const g of o.gates.filter((x) => x.status === 'fail' || x.status === 'flaky')) {
        if (!g.tail.trim()) continue;
        const pre = el('pre', 'vp-tail');
        pre.textContent = g.tail.trimEnd();
        pre.title = `${GATE_NAME[g.gate]} output`;
        detail.append(pre);
      }
    }
    if (o.review) {
      const r = el('div', 'vp-review');
      r.textContent = `Odin ${o.review.decision === 'approve' ? 'approves' : 'asks for changes'}: ${o.review.summary}`;
      detail.append(r);
      for (const f of o.review.findings) {
        const row = el('div', `vp-finding vp-sev-${f.severity}`);
        row.textContent = `${f.severity} · ${f.file}${f.line ? `:${f.line}` : ''} — ${f.note}`;
        detail.append(row);
      }
    }
    if (!detail.childElementCount) {
      const none = el('div', 'vp-dim');
      none.textContent = 'No gate or review yet.';
      detail.append(none);
    }
    box.append(detail);
    return box;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
