/** Groups (teams) and chat. */
export const GROUPS = {
  maxMembers: 6,
  nameMin: 3,
  nameMax: 20,
  /** Invites expire after this long. */
  inviteTtlSec: 120,
  /** Teammate positions (minimap, compass, name tags through walls) are sent this often. */
  teammateUpdateMs: 500,
  /** Teammates can't hurt each other (guns, melee, running them over). */
  friendlyFire: false,
} as const;

export const CHAT = {
  maxLength: 200,
  /** Minimum time between two messages from one player (spam protection). */
  minIntervalMs: 700,
  /** Messages stay on screen this long when the chat box is closed. */
  fadeAfterSec: 12,
  /** Lines kept in the chat history. */
  history: 60,
} as const;

/** True if two players are in the same group (group ids, null = no group). */
export const sameGroup = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && a === b;

/** Group names: letters, digits, spaces, _ - ' (trimmed, collapsed spaces). */
export const cleanGroupName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < GROUPS.nameMin || name.length > GROUPS.nameMax) return null;
  return /^[A-Za-z0-9 _'-]+$/.test(name) ? name : null;
};

/** Chat text: trimmed, control characters removed, capped. Empty -> null. */
export const cleanChatText = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT.maxLength);
  return text.length ? text : null;
};
