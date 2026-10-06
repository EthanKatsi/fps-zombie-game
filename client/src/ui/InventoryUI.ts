import {
  INVENTORY,
  ITEM_CATEGORY_COLORS,
  RECIPES,
  canCraft,
  getItemDef,
  totalWeight,
  type ContainerView,
  type Inventory,
  type ItemStack,
  type SlotRef,
} from '@grey/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Placeholder icon text: initials for multi-word names, else first 3 letters. */
const iconText = (name: string): string => {
  const words = name.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean);
  return (words.length > 1 ? words.slice(0, 3).map((w) => w[0]) : [words[0]?.slice(0, 3) ?? '?']).join('').toUpperCase();
};

export const renderItem = (el: HTMLElement, s: ItemStack | null): void => {
  el.querySelectorAll('.icon, .qty, .dura').forEach((n) => n.remove());
  if (!s) return;
  const def = getItemDef(s.defId);
  const icon = document.createElement('div');
  icon.className = 'icon';
  icon.style.background = def ? ITEM_CATEGORY_COLORS[def.category] : '#f0f';
  icon.textContent = iconText(def?.name ?? s.defId);
  el.appendChild(icon);
  if (s.qty > 1) {
    const q = document.createElement('div');
    q.className = 'qty';
    q.textContent = String(s.qty);
    el.appendChild(q);
  }
  if (def?.maxDurability && s.durability !== undefined) {
    const d = document.createElement('div');
    d.className = 'dura';
    const fill = document.createElement('div');
    const f = Math.max(0, Math.min(1, s.durability / def.maxDurability));
    fill.style.width = `${f * 100}%`;
    fill.style.background = f > 0.5 ? '#8fbf5a' : f > 0.2 ? '#c9a43a' : '#c0392b';
    d.appendChild(fill);
    el.appendChild(d);
  }
};

export interface InventoryUIActions {
  use(slot: number): void;
  move(from: SlotRef, to: SlotRef, qty?: number): void;
  drop(from: SlotRef, qty?: number): void;
  craft(recipeId: string): void;
  unequip(slot: 'head' | 'body'): void;
}

interface Drag {
  from: SlotRef;
  stack: ItemStack;
  split: boolean;
  ghost: HTMLElement;
}

/**
 * Inventory screen + HUD hotbar. Pure view: it renders whatever state the server last
 * sent and turns drags/clicks into requests; it never changes items locally.
 */
export class InventoryUI {
  private readonly screen = $('inventory');
  private readonly hotbarHud = $('hotbar');
  private readonly heldName = $('held-name');
  private readonly tooltip = $('tooltip');
  private readonly containerPanel = $('inv-container');
  private inv: Inventory | null = null;
  private container: ContainerView | null = null;
  private active = 0;
  private drag: Drag | null = null;
  private heldTimer = 0;
  private readonly hudSlots: HTMLElement[] = [];

  constructor(private readonly actions: InventoryUIActions) {
    for (let i = 0; i < INVENTORY.hotbarSize; i++) {
      const el = this.makeSlot(null, i);
      this.hudSlots.push(el);
      this.hotbarHud.appendChild(el);
    }
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.screen.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen(): boolean {
    return !this.screen.classList.contains('hidden');
  }

  get openContainerKey(): string | null {
    return this.container?.key ?? null;
  }

  get inventory(): Inventory | null {
    return this.inv;
  }

  get activeHotbar(): number {
    return this.active;
  }

  open(): void {
    this.screen.classList.remove('hidden');
    this.render();
  }

  close(): void {
    this.screen.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    this.cancelDrag();
    this.setContainer(null);
  }

  setInventory(inv: Inventory): void {
    this.inv = inv;
    this.render();
  }

  setContainer(c: ContainerView | null): void {
    this.container = c;
    this.containerPanel.classList.toggle('hidden', !c);
    this.render();
  }

  updateContainer(key: string, slots: (ItemStack | null)[]): void {
    if (this.container?.key !== key) return;
    this.container = { ...this.container, slots };
    this.render();
  }

  setActive(i: number): void {
    this.active = i;
    this.renderHud();
    const s = this.inv?.slots[i];
    this.heldName.textContent = s ? getItemDef(s.defId)?.name ?? s.defId : 'Empty hands';
    this.heldName.classList.add('show');
    window.clearTimeout(this.heldTimer);
    this.heldTimer = window.setTimeout(() => this.heldName.classList.remove('show'), 1200);
  }

  // ---------------------------------------------------------------- rendering

  private makeSlot(ref: SlotRef | null, hotkey?: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'slot';
    if (hotkey !== undefined) {
      const k = document.createElement('span');
      k.className = 'key';
      k.textContent = String(hotkey + 1);
      el.appendChild(k);
    }
    if (ref) {
      el.dataset.owner = ref.owner;
      el.dataset.index = String(ref.index);
      el.addEventListener('pointerdown', (e) => this.onSlotDown(e, ref));
      if (ref.owner === 'self') {
        el.addEventListener('dblclick', () => {
          const s = this.stackAt(ref);
          const d = s && getItemDef(s.defId);
          if (d && (d.consume || d.armor)) this.actions.use(ref.index);
        });
      }
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.quickMove(ref);
      });
      el.addEventListener('pointerenter', () => this.showTooltip(el, ref));
      el.addEventListener('pointerleave', () => this.tooltip.classList.add('hidden'));
    }
    return el;
  }

  private stackAt(ref: SlotRef): ItemStack | null {
    if (ref.owner === 'self') return this.inv?.slots[ref.index] ?? null;
    if (this.container && ref.owner === this.container.key) return this.container.slots[ref.index] ?? null;
    return null;
  }

  private render(): void {
    this.renderHud();
    if (!this.isOpen || !this.inv) return;
    const slots = this.inv.slots;
    const hb = $('inv-hotbar');
    const bp = $('inv-backpack');
    hb.replaceChildren();
    bp.replaceChildren();
    slots.forEach((s, i) => {
      const el = this.makeSlot({ owner: 'self', index: i }, i < INVENTORY.hotbarSize ? i : undefined);
      if (i === this.active) el.classList.add('active');
      renderItem(el, s);
      (i < INVENTORY.hotbarSize ? hb : bp).appendChild(el);
    });

    // Worn armour: double-click or right-click to take it off.
    const worn = $('inv-equip');
    worn.replaceChildren();
    for (const slot of ['head', 'body'] as const) {
      const el = this.makeSlot(null);
      el.classList.add('equip-slot');
      el.dataset.label = slot === 'head' ? 'Helmet' : 'Vest';
      const piece = this.inv.equipment?.[slot] ?? null;
      renderItem(el, piece);
      if (piece) {
        el.title = getItemDef(piece.defId)?.name ?? '';
        el.addEventListener('dblclick', () => this.actions.unequip(slot));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.actions.unequip(slot);
        });
      }
      worn.appendChild(el);
    }

    const w = totalWeight(slots);
    const max = INVENTORY.maxCarryWeight;
    const wEl = $('inv-weight');
    wEl.textContent = `${w.toFixed(1)} / ${max} kg`;
    wEl.classList.toggle('heavy', w > max * 0.9);
    $('inv-weight-fill').style.width = `${Math.min(100, (w / max) * 100)}%`;

    if (this.container) {
      $('inv-container-title').textContent = this.container.title;
      const grid = $('inv-container-grid');
      grid.replaceChildren();
      this.container.slots.forEach((s, i) => {
        const el = this.makeSlot({ owner: this.container!.key, index: i });
        renderItem(el, s);
        grid.appendChild(el);
      });
    }

    const list = $('craft-list');
    list.replaceChildren();
    for (const r of RECIPES) {
      const row = document.createElement('div');
      row.className = 'recipe';
      const label = document.createElement('div');
      label.textContent = r.name;
      const small = document.createElement('small');
      small.textContent = r.inputs.map((i) => `${i.qty}× ${getItemDef(i.item)?.name ?? i.item}`).join(', ');
      label.appendChild(small);
      const btn = document.createElement('button');
      btn.textContent = 'Craft';
      btn.disabled = !canCraft(slots, r);
      btn.addEventListener('click', () => this.actions.craft(r.id));
      row.append(label, btn);
      list.appendChild(row);
    }
  }

  private renderHud(): void {
    this.hudSlots.forEach((el, i) => {
      renderItem(el, this.inv?.slots[i] ?? null);
      el.classList.toggle('active', i === this.active);
    });
  }

  private showTooltip(el: HTMLElement, ref: SlotRef): void {
    const s = this.stackAt(ref);
    const def = s && getItemDef(s.defId);
    if (!s || !def || this.drag) return;
    const lines = [`<b>${def.name}${s.qty > 1 ? ` ×${s.qty}` : ''}</b>`];
    if (def.description) lines.push(`<div>${def.description}</div>`);
    const c = def.consume;
    if (c) {
      const fx = [
        c.health && `+${c.health} health`,
        c.hunger && `${c.hunger > 0 ? '+' : ''}${c.hunger} food`,
        c.thirst && `${c.thirst > 0 ? '+' : ''}${c.thirst} water`,
        c.stopsBleeding && 'stops bleeding',
      ].filter(Boolean);
      if (fx.length) lines.push(`<div>${fx.join(' · ')}</div>`);
    }
    if (def.consume && ref.owner === 'self') lines.push(`<div class="muted">Double-click (or left-click in hand) to use</div>`);
    if (s.loadedAmmo !== undefined) lines.push(`<div class="muted">Loaded: ${s.loadedAmmo}</div>`);
    if (def.maxDurability && s.durability !== undefined) {
      lines.push(`<div class="muted">Condition ${Math.round((s.durability / def.maxDurability) * 100)}%</div>`);
    }
    lines.push(`<div class="muted">${(def.weight * s.qty).toFixed(2)} kg · ${def.category}</div>`);
    this.tooltip.innerHTML = lines.join('');
    const r = el.getBoundingClientRect();
    this.tooltip.style.left = `${Math.min(window.innerWidth - 250, r.right + 8)}px`;
    this.tooltip.style.top = `${r.top}px`;
    this.tooltip.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- interaction

  /** Right-click: container <-> inventory, or hotbar <-> backpack when nothing is open. */
  private quickMove(ref: SlotRef): void {
    if (!this.stackAt(ref)) return;
    if (this.container) {
      const to: SlotRef = ref.owner === 'self' ? { owner: this.container.key, index: -1 } : { owner: 'self', index: -1 };
      this.actions.move(ref, to);
      return;
    }
    if (!this.inv) return;
    const inHotbar = ref.index < INVENTORY.hotbarSize;
    const range = inHotbar
      ? [INVENTORY.hotbarSize, INVENTORY.slots]
      : [0, INVENTORY.hotbarSize];
    for (let i = range[0]; i < range[1]; i++) {
      if (!this.inv.slots[i]) {
        this.actions.move(ref, { owner: 'self', index: i });
        return;
      }
    }
  }

  private onSlotDown(e: PointerEvent, ref: SlotRef): void {
    if (e.button !== 0) return;
    const stack = this.stackAt(ref);
    if (!stack) return;
    e.preventDefault();
    if (e.shiftKey) {
      this.quickMove(ref);
      return;
    }
    const ghost = document.createElement('div');
    ghost.className = 'slot drag-ghost';
    renderItem(ghost, e.ctrlKey && stack.qty > 1 ? { ...stack, qty: Math.ceil(stack.qty / 2) } : stack);
    document.body.appendChild(ghost);
    this.drag = { from: ref, stack, split: e.ctrlKey && stack.qty > 1, ghost };
    this.tooltip.classList.add('hidden');
    this.moveGhost(e);
  }

  private moveGhost(e: PointerEvent): void {
    if (!this.drag) return;
    this.drag.ghost.style.left = `${e.clientX - 22}px`;
    this.drag.ghost.style.top = `${e.clientY - 22}px`;
  }

  private onPointerMove = (e: PointerEvent) => this.moveGhost(e);

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    this.cancelDrag();
    const qty = d.split ? Math.ceil(d.stack.qty / 2) : undefined;
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const slotEl = under?.closest('.slot') as HTMLElement | null;
    if (slotEl?.dataset.owner !== undefined && slotEl.dataset.index !== undefined) {
      const to: SlotRef = { owner: slotEl.dataset.owner, index: Number(slotEl.dataset.index) };
      if (to.owner !== d.from.owner || to.index !== d.from.index) this.actions.move(d.from, to, qty);
      return;
    }
    // Released outside every panel: drop it on the ground (own items only).
    if (!under?.closest('.panel') && d.from.owner === 'self') this.actions.drop(d.from, qty);
  };

  private cancelDrag(): void {
    this.drag?.ghost.remove();
    this.drag = null;
  }
}
