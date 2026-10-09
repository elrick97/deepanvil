import type { ForgeEvent } from '@deepanvil/shared';

// Bottom banner: the current quest, its phase, and one chip per blueprint task.

type TaskState = 'waiting' | 'working' | 'offered' | 'done' | 'stuck';

interface Task {
  id: string;
  title: string;
  state: TaskState;
  who?: string;
}

const PHASE: Record<string, string> = {
  drafting: 'Thráin drafts a blueprint — awaiting your approval',
  forging: 'The forges are lit',
  merging: 'Into the minecart — merged',
};

export class QuestBanner {
  private el: HTMLElement;
  private names: Map<string, string>;
  private title = '';
  private phase = '';
  private tasks: Task[] = [];
  private hideTimer?: ReturnType<typeof setTimeout>;

  constructor(el: HTMLElement, names: Map<string, string>) {
    this.el = el;
    this.names = names;
  }

  handle(e: ForgeEvent): void {
    const task = (id: string) => this.tasks.find((t) => t.id === id);
    switch (e.type) {
      case 'blueprint.proposed':
        clearTimeout(this.hideTimer);
        this.title = e.title;
        this.phase = 'drafting';
        this.tasks = e.tasks.map((t) => ({ ...t, state: 'waiting' }));
        break;
      case 'blueprint.rejected':
        clearTimeout(this.hideTimer);
        this.tasks = [];
        this.el.classList.add('hidden');
        return;
      case 'blueprint.approved':
        this.phase = 'forging';
        break;
      case 'task.assigned': {
        const t = task(e.taskId);
        if (t) Object.assign(t, { state: 'working', who: this.names.get(e.dwarfId) ?? e.dwarfId });
        break;
      }
      case 'escalation': {
        const t = task(e.taskId);
        if (t) t.state = 'stuck';
        break;
      }
      case 'test.pass':
      case 'tool': {
        const t = task(e.taskId);
        if (t?.state === 'stuck') t.state = 'working';
        break;
      }
      case 'offering.opened': {
        const t = task(e.taskId);
        if (t && t.state !== 'done') t.state = 'offered';
        break;
      }
      case 'offering.state': {
        if (e.state !== 'sent_back') return;
        const t = this.tasks.find((x) => e.offeringId.endsWith(`-${x.id}`));
        if (t) t.state = 'working';
        break;
      }
      case 'task.done': {
        const t = task(e.taskId);
        if (t) t.state = 'done';
        break;
      }
      case 'merge':
        this.phase = 'merging';
        this.hideTimer = setTimeout(() => this.el.classList.add('hidden'), 6000);
        break;
      default:
        return;
    }
    this.render();
  }

  private render(): void {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const icon: Record<TaskState, string> = { waiting: '○', working: '⚒', offered: '⚖', done: '✦', stuck: '!' };
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="quest-phase">${esc(PHASE[this.phase] ?? '')}</div>
      <div class="quest-title">${esc(this.title)}</div>
      <div class="quest-tasks">${this.tasks
        .map((t) => `<span class="chip ${t.state}">${icon[t.state]} ${esc(t.title)}${t.who ? ` · ${esc(t.who)}` : ''}</span>`)
        .join('')}</div>`;
  }
}
