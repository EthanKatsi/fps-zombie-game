import { CHAT, type ChatMessage } from '@grey/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * Chat box (bottom left). Enter opens the input; Tab switches Global / Group; Enter sends,
 * Escape cancels. Lines fade out after a while unless the box is open.
 */
export class Chat {
  private readonly log = $('chat-log');
  private readonly row = $('chat-input-row');
  private readonly input = $<HTMLInputElement>('chat-input');
  private readonly chan = $('chat-channel');
  isOpen = false;
  private channel: 'global' | 'group' = 'global';
  private inGroup = false;

  constructor(
    private readonly send: (channel: 'global' | 'group', text: string) => void,
    private readonly onClose: () => void,
  ) {
    this.input.maxLength = CHAT.maxLength;
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) this.send(this.channel, text);
        this.close();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.setChannel(this.channel === 'global' && this.inGroup ? 'group' : 'global');
      }
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.input.addEventListener('blur', () => this.isOpen && this.close());
    this.setChannel('global');
  }

  setInGroup(inGroup: boolean): void {
    this.inGroup = inGroup;
    if (!inGroup && this.channel === 'group') this.setChannel('global');
  }

  private setChannel(c: 'global' | 'group'): void {
    this.channel = c;
    this.chan.textContent = c === 'group' ? 'Group' : 'All';
    this.chan.className = `chat-chan ${c}`;
  }

  /** Open the input (optionally straight into group chat). */
  openInput(channel?: 'global' | 'group'): void {
    if (channel === 'group' && this.inGroup) this.setChannel('group');
    this.isOpen = true;
    this.row.classList.remove('hidden');
    this.log.classList.add('open');
    this.input.value = '';
    this.input.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.row.classList.add('hidden');
    this.log.classList.remove('open');
    this.input.blur();
    this.onClose();
  }

  add(m: ChatMessage): void {
    const line = document.createElement('div');
    line.className = `chat-line ${m.channel}`;
    line.dataset.at = String(performance.now());
    if (m.channel === 'group') {
      const tag = document.createElement('span');
      tag.className = 'chat-tag';
      tag.textContent = '[Group] ';
      line.appendChild(tag);
    }
    if (m.from) {
      const name = document.createElement('span');
      name.className = 'chat-name';
      name.textContent = `${m.from}: `;
      line.appendChild(name);
    }
    line.appendChild(document.createTextNode(m.text));
    this.log.appendChild(line);
    while (this.log.children.length > CHAT.history) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Fade old lines (call a few times a second). */
  update(): void {
    const now = performance.now();
    for (const el of Array.from(this.log.children) as HTMLElement[]) {
      el.classList.toggle('faded', now - Number(el.dataset.at) > CHAT.fadeAfterSec * 1000);
    }
  }
}
