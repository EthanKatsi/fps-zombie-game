import { Buttons, clamp } from '@grey/shared';

const PITCH_LIMIT = Math.PI / 2 - 0.01;
const MAX_EVENT_DELTA = 350;

/** Keyboard + pointer-lock mouse input. Yaw/pitch update immediately for responsive aiming. */
export class Input {
  private keys = new Set<string>();
  /** Keys pressed since last consumed (edge-triggered actions like E). */
  private pressed = new Set<string>();
  yaw = 0;
  pitch = 0;
  /** Radians per pixel of mouse movement. */
  sensitivity = 0.0022;
  locked = false;
  private skipNextMove = false;
  private wheel = 0;
  /** Mouse buttons currently held (0 = left, 2 = right). */
  private mouse = new Set<number>();
  /** Set by the weapon controller each frame: right mouse is aiming down sights right now. */
  aimActive = false;
  onLockChange: (locked: boolean) => void = () => {};
  /** Typing in chat: keys go to the text box, not the game. */
  private suspendedFlag = false;
  /** Double-tap W (then hold) to sprint. */
  private lastWDown = -Infinity;
  private sprintLatched = false;
  private static readonly DOUBLE_TAP_MS = 300;

  get suspended(): boolean {
    return this.suspendedFlag;
  }

  /** While suspended (chat open) the game ignores the keyboard; held keys are released. */
  set suspended(on: boolean) {
    this.suspendedFlag = on;
    if (on) {
      this.keys.clear();
      this.pressed.clear();
      this.sprintLatched = false;
    }
  }

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.locked || this.suspendedFlag) return;
      this.keys.add(e.code);
      if (!e.repeat) this.pressed.add(e.code);
      if (e.code === 'KeyW' && !e.repeat) {
        const now = performance.now();
        if (now - this.lastWDown < Input.DOUBLE_TAP_MS) this.sprintLatched = true;
        this.lastWDown = now;
      }
      // Stop browser shortcuts (space scrolling, F-keys, etc.) while playing.
      if (['Space', 'Tab', 'F8', 'F3'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyW') this.sprintLatched = false; // sprint lasts while W stays held
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.sprintLatched = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // The first event after locking often carries the whole cursor jump to the lock point.
      if (this.skipNextMove) {
        this.skipNextMove = false;
        return;
      }
      const dx = e.movementX;
      const dy = e.movementY;
      // Chrome on Windows occasionally reports a single bogus huge delta under pointer lock,
      // which snaps the view. Real flicks at 1000 Hz polling never get near this size.
      if (Math.abs(dx) > MAX_EVENT_DELTA || Math.abs(dy) > MAX_EVENT_DELTA) return;
      this.yaw -= dx * this.sensitivity;
      this.pitch = clamp(this.pitch - dy * this.sensitivity, -PITCH_LIMIT, PITCH_LIMIT);
    });

    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.pressed.add(`Mouse${e.button}`);
      this.mouse.add(e.button);
    });
    document.addEventListener('mouseup', (e) => this.mouse.delete(e.button));
    // Right-click is aim, never the browser menu.
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });

    document.addEventListener(
      'wheel',
      (e) => {
        if (this.locked && e.deltaY !== 0) this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      this.skipNextMove = this.locked;
      if (!this.locked) {
        this.keys.clear();
        this.pressed.clear();
        this.mouse.clear();
      }
      this.onLockChange(this.locked);
    });
  }

  requestLock(): void {
    // Prefer raw (unaccelerated) mouse input: steadier aim and avoids most delta spikes.
    // Browsers without support reject, so fall back to a plain lock. Chrome also rejects
    // right after the user pressed Esc; that's fine to ignore.
    const plain = () => (this.element.requestPointerLock() as Promise<void> | undefined)?.catch?.(() => {});
    try {
      const p = this.element.requestPointerLock({ unadjustedMovement: true }) as Promise<void> | undefined;
      p?.catch?.((err: DOMException) => {
        if (err?.name === 'NotSupportedError') plain();
      });
    } catch {
      plain();
    }
  }

  isMouseDown(button: number): boolean {
    return this.mouse.has(button);
  }

  /** Accumulated wheel notches since the last call (+ = down). */
  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** True once per physical key press. */
  consumePress(code: string): boolean {
    return this.pressed.delete(code);
  }

  private down(code: string): boolean {
    return this.keys.has(code);
  }

  /** Current movement intent as a (mx, mz, buttons) triple. */
  sample(): { mx: number; mz: number; b: number } {
    const mz = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    const mx = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    let b = 0;
    if (this.down('Space')) b |= Buttons.jump;
    if (this.sprintLatched && this.down('KeyW')) b |= Buttons.sprint;
    if (this.down('ShiftLeft') || this.down('ShiftRight')) b |= Buttons.crouch;
    if (this.aimActive) b |= Buttons.aim;
    return { mx, mz, b };
  }
}
