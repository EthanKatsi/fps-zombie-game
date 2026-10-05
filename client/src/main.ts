import RAPIER from '@dimforge/rapier3d-compat';
import './ui/style.css';
import { Connection } from './net/Connection';
import { Game } from './game/Game';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const menu = $('menu');
const hud = $('hud');
const pause = $('pause');
const form = $<HTMLFormElement>('login-form');
const usernameInput = $<HTMLInputElement>('username');
const joinBtn = $<HTMLButtonElement>('join-btn');
const menuError = $('menu-error');
const staminaFill = $('stamina-fill');
const debug = $('debug');
const prompt = $('prompt');
const promptText = $('prompt-text');
const toast = $('toast');
let toastTimer = 0;

const rapierReady = RAPIER.init();
usernameInput.value = localStorage.getItem('grey.username') ?? '';

let game: Game | null = null;

/**
 * Crouch is on Ctrl, and Ctrl+W (crouch-walk forward) would close the tab. In fullscreen the
 * Keyboard Lock API lets the game receive those keys (hold Esc to leave fullscreen). Browsers
 * without it get a "leave site?" confirmation instead.
 */
const lockKeyboard = () => {
  const nav = navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } };
  const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyV', 'Tab', 'Space', 'ControlLeft', 'ControlRight'];
  document.documentElement
    .requestFullscreen?.()
    .then(() => nav.keyboard?.lock?.(keys))
    .catch(() => {});
};
window.addEventListener('beforeunload', (e) => {
  if (!game) return;
  e.preventDefault();
  e.returnValue = '';
});

const showMenu = (error = '') => {
  game?.dispose();
  game = null;
  menu.classList.remove('hidden');
  hud.classList.add('hidden');
  pause.classList.add('hidden');
  menuError.textContent = error;
  joinBtn.disabled = false;
};

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = usernameInput.value.trim();
  joinBtn.disabled = true;
  menuError.textContent = '';
  const conn = new Connection();
  try {
    await rapierReady;
    const join = await conn.join(username);
    localStorage.setItem('grey.username', username);
    menu.classList.add('hidden');
    hud.classList.remove('hidden');
    game = new Game(RAPIER, conn, join, $('game'), {
      setPaused: (p) => pause.classList.toggle('hidden', !p),
      setStamina: (f) => (staminaFill.style.width = `${Math.round(f * 100)}%`),
      setDebug: (t) => (debug.textContent = t),
      setPrompt: (t) => {
        prompt.classList.toggle('hidden', t === null);
        if (t !== null && promptText.textContent !== t) promptText.textContent = t;
      },
      toast: (t) => {
        toast.textContent = t;
        toast.classList.add('show');
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove('show'), 1800);
      },
    });
    conn.socket.on('disconnect', () => showMenu('Disconnected from server.'));
    lockKeyboard();
    // Dev-only handle for debugging from the browser console / automation.
    if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
  } catch (err) {
    conn.close();
    showMenu((err as Error).message);
  }
});

pause.addEventListener('click', () => game?.resume());
