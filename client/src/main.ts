import RAPIER from '@dimforge/rapier3d-compat';
import './ui/style.css';
import { Connection } from './net/Connection';
import { Game } from './game/Game';
import { bindSettingsForm } from './settings';
import { ModelLibrary } from './game/models/ModelLibrary';

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
// Optional realistic character models (public/models/manifest.json); empty if none installed.
const modelsReady = ModelLibrary.load().catch(() => null);

/** Credits: CC-BY models (required attribution) and the CC0 textures. */
const fillCredits = async () => {
  const list = document.getElementById('credits-list');
  if (!list) return;
  const lines: string[] = [];
  const models = await modelsReady;
  for (const c of models?.credits ?? []) lines.push(c);
  try {
    const tex = (await (await fetch('textures/manifest.json')).json()) as Record<string, { asset: string; source: string }>;
    const names = Object.values(tex).map((t) => t.asset).join(', ');
    lines.push(`Surface textures from Poly Haven (CC0): ${names}`);
  } catch {
    /* no photo textures installed */
  }
  lines.push('Built with Three.js, Rapier, Recast/Detour (recast-navigation-js), Socket.IO.');
  list.replaceChildren(...lines.map((l) => Object.assign(document.createElement('li'), { textContent: l })));
};
void fillCredits();
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
    const models = await modelsReady;
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
    }, models);
    conn.socket.on('disconnect', () => showMenu('Disconnected from server.'));
    // Dev-only handle for debugging from the browser console / automation.
    if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
  } catch (err) {
    conn.close();
    showMenu((err as Error).message);
  }
});

bindSettingsForm($('menu-settings'));
bindSettingsForm($('pause-settings'));
$('resume-btn').addEventListener('click', () => game?.resume());
