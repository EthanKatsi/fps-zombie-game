import { GROUPS, type GroupInvite, type GroupOp, type GroupView } from '@grey/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * Group panel (G): create a group, answer invites, invite players, and (leader) kick / promote.
 * Pure view: every action is a request to the server.
 */
export class GroupPanel {
  private readonly screen = $('group-panel');
  private readonly body = $('group-body');
  isOpen = false;
  private group: GroupView | null = null;
  private invites: (GroupInvite & { expires: number })[] = [];

  constructor(
    private readonly myId: string,
    private readonly act: (op: GroupOp) => void,
  ) {}

  get current(): GroupView | null {
    return this.group;
  }

  setGroup(g: GroupView | null): void {
    this.group = g;
    if (g) this.invites = [];
    this.render();
  }

  addInvite(inv: GroupInvite): void {
    this.invites = this.invites.filter((i) => i.groupId !== inv.groupId);
    this.invites.push({ ...inv, expires: Date.now() + GROUPS.inviteTtlSec * 1000 });
    this.render();
  }

  get pendingInvites(): number {
    this.invites = this.invites.filter((i) => i.expires > Date.now());
    return this.invites.length;
  }

  open(): void {
    this.isOpen = true;
    this.screen.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.isOpen = false;
    this.screen.classList.add('hidden');
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = el('button', `gp-btn ${cls}`, label);
    b.addEventListener('click', onClick);
    return b;
  }

  /** A text field with a button; Enter submits too. */
  private field(placeholder: string, label: string, submit: (v: string) => void): HTMLElement {
    const row = el('div', 'gp-row');
    const input = el('input');
    input.placeholder = placeholder;
    input.maxLength = 24;
    const go = () => {
      const v = input.value.trim();
      if (v) submit(v);
      input.value = '';
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') this.close();
    });
    row.append(input, this.button(label, go));
    return row;
  }

  render(): void {
    if (!this.isOpen) return;
    const b = this.body;
    b.replaceChildren();
    const g = this.group;
    if (!g) {
      b.append(el('h3', '', 'No group'));
      b.append(el('p', 'gp-help', 'Groups share chat, see each other on the map and compass and through walls, and can\'t hurt each other.'));
      b.append(this.field('Group name', 'Create', (name) => this.act({ op: 'create', name })));
      const invites = this.invites.filter((i) => i.expires > Date.now());
      if (invites.length) {
        b.append(el('div', 'section-label', 'Invites'));
        for (const inv of invites) {
          const row = el('div', 'gp-row');
          row.append(el('span', 'gp-grow', `"${inv.groupName}" from ${inv.from}`));
          row.append(
            this.button('Accept', () => this.act({ op: 'accept', groupId: inv.groupId }), 'ok'),
            this.button('Decline', () => {
              this.act({ op: 'decline', groupId: inv.groupId });
              this.invites = this.invites.filter((i) => i !== inv);
              this.render();
            }),
          );
          b.append(row);
        }
      }
      return;
    }
    const lead = g.leaderId === this.myId;
    b.append(el('h3', '', g.name));
    b.append(el('div', 'section-label', `Members ${g.members.length}/${GROUPS.maxMembers}`));
    const sorted = [...g.members].sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
    for (const m of sorted) {
      const row = el('div', 'gp-row');
      row.append(el('span', `gp-dot ${m.online ? 'on' : 'off'}`));
      const name = el('span', 'gp-grow', `${m.name}${m.id === g.leaderId ? '  ★ leader' : ''}${m.id === this.myId ? '  (you)' : ''}`);
      row.append(name);
      if (lead && m.id !== this.myId) {
        row.append(
          this.button('Make leader', () => this.act({ op: 'promote', playerId: m.id })),
          this.button('Kick', () => this.act({ op: 'kick', playerId: m.id }), 'danger'),
        );
      }
      b.append(row);
    }
    if (g.members.length < GROUPS.maxMembers) {
      b.append(el('div', 'section-label', 'Invite a survivor (must be online)'));
      b.append(this.field('Name', 'Invite', (username) => this.act({ op: 'invite', username })));
    }
    const leave = el('div', 'gp-row gp-end');
    leave.append(this.button('Leave group', () => this.act({ op: 'leave' }), 'danger'));
    b.append(leave);
  }
}
