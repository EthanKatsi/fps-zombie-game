import { Buttons, clamp } from '@grey/shared';

const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Keyboard + pointer-lock mouse input. Yaw/pitch update immediately for responsive aiming. */
export class Input {
  private keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  /** Radians per pixel of mouse movement. */
  sensitivity = 0.0022;
  locked = false;
  onLockChange: (locked: boolean) => void = () => {};

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.locked) return;
      this.keys.add(e.code);
      // Stop browser shortcuts (space scrolling, etc.) while playing.
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch = clamp(this.pitch - e.movementY * this.sensitivity, -PITCH_LIMIT, PITCH_LIMIT);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.keys.clear();
      this.onLockChange(this.locked);
    });
  }

  requestLock(): void {
    // Chrome returns a promise and rejects if the user just pressed Esc; ignore that.
    const p = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
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
    if (this.down('ShiftLeft') || this.down('ShiftRight')) b |= Buttons.sprint;
    // Not Ctrl: Ctrl+W would close the browser tab mid-sprint.
    if (this.down('KeyC')) b |= Buttons.crouch;
    return { mx, mz, b };
  }
}
