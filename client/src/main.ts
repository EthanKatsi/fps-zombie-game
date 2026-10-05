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

const rapierReady = RAPIER.init();
usernameInput.value = localStorage.getItem('grey.username') ?? '';

let game: Game | null = null;

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
    });
    conn.socket.on('disconnect', () => showMenu('Disconnected from server.'));
  } catch (err) {
    conn.close();
    showMenu((err as Error).message);
  }
});

pause.addEventListener('click', () => game?.resume());
