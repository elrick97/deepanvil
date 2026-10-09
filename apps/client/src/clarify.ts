import type { ClientCommand, ForgeEvent, PlanAnswer, PlanQuestion } from '@deepanvil/shared';

// Thráin's clarifying questions as a small form (like an ask-question tool): each question
// has a chip, a few options with one-line descriptions and his pick pre-selected (★), and an
// "in your own words" line. Send your answers, or tell him to just draft with his own picks.
// The question text comes from a model, so it only ever goes in through textContent.

type Send = (cmd: ClientCommand) => boolean;

export class ClarifyForm {
  private root: HTMLElement;
  private send: Send;
  private questId?: string;

  constructor(root: HTMLElement, send: Send) {
    this.root = root;
    this.send = send;
  }

  handle(e: ForgeEvent): void {
    switch (e.type) {
      case 'plan.questions':
        this.show(e.questId, e.round, e.rounds, e.questions);
        break;
      case 'plan.answered':
      case 'blueprint.proposed':
        this.hide();
        break;
      case 'forge.status':
        if (!e.busy) this.hide(); // stopped or failed: nobody is waiting any more
        break;
    }
  }

  private hide(): void {
    this.questId = undefined;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  private show(questId: string, round: number, rounds: number, questions: PlanQuestion[]): void {
    this.questId = questId;
    const form = el('form', 'clarify hud-card');
    form.setAttribute('aria-label', 'Thráin has questions');

    const head = el('div', 'clarify-head');
    const title = el('div', 'clarify-title');
    title.textContent = 'Thráin asks';
    const meta = el('div', 'clarify-meta');
    meta.textContent = `${rounds > 1 ? `round ${round} of ${rounds} · ` : ''}★ marks his pick`;
    head.append(title, meta);

    const body = el('div', 'clarify-body');
    questions.forEach((q, qi) => body.append(this.question(questId, q, qi)));

    const actions = el('div', 'clarify-actions');
    const skip = el('button', 'btn');
    skip.type = 'button';
    skip.textContent = 'Just draft it';
    skip.title = 'Thráin goes ahead with his own picks';
    skip.addEventListener('click', () => this.finish(undefined));
    const go = el('button', 'btn btn-primary');
    go.type = 'submit';
    go.textContent = 'Send answers';
    actions.append(skip, go);

    form.append(head, body, actions);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.finish(this.collect(form, questions));
    });
    this.root.replaceChildren(form);
    this.root.hidden = false;
  }

  private question(questId: string, q: PlanQuestion, qi: number): HTMLElement {
    const box = el('fieldset', 'clarify-q');
    const legend = el('legend', 'clarify-legend');
    const chip = el('span', 'chip');
    chip.textContent = q.header;
    const text = el('span', 'clarify-text');
    text.textContent = q.question;
    legend.append(chip, text);
    box.append(legend);

    q.options.forEach((o, oi) => {
      const label = el('label', 'clarify-opt');
      const input = el('input', '');
      input.type = q.multiSelect ? 'checkbox' : 'radio';
      input.name = `${questId}-${qi}`;
      input.value = o.label;
      input.checked = q.recommended.includes(o.label);
      input.id = `${questId}-${qi}-${oi}`;
      const words = el('span', 'clarify-words');
      const name = el('span', 'clarify-label');
      name.textContent = `${q.recommended.includes(o.label) ? '★ ' : ''}${o.label}`;
      const desc = el('span', 'clarify-desc');
      desc.textContent = o.description;
      words.append(name, desc);
      label.append(input, words);
      box.append(label);
    });

    const other = el('input', 'clarify-other');
    other.type = 'text';
    other.maxLength = 600;
    other.placeholder = 'Or in your own words…';
    other.dataset.other = String(qi);
    other.setAttribute('aria-label', `Your own answer to: ${q.question}`);
    box.append(other);
    return box;
  }

  private collect(form: HTMLFormElement, questions: PlanQuestion[]): Record<string, PlanAnswer> {
    const answers: Record<string, PlanAnswer> = {};
    questions.forEach((q, qi) => {
      const picks = [...form.querySelectorAll<HTMLInputElement>(`input[name$="-${qi}"]:checked`)].map((i) => i.value);
      const other = form.querySelector<HTMLInputElement>(`input[data-other="${qi}"]`)?.value.trim();
      answers[q.id] = { picks, ...(other ? { other } : {}) };
    });
    return answers;
  }

  private finish(answers: Record<string, PlanAnswer> | undefined): void {
    const questId = this.questId;
    if (!questId) return;
    const ok = this.send(answers ? { type: 'plan.answer', questId, answers } : { type: 'plan.skip', questId });
    if (ok) this.hide();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
