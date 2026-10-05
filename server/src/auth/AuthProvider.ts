import type { JoinRequest } from '@grey/shared';

export type AuthResult = { ok: true; username: string } | { ok: false; reason: string };

/**
 * Pluggable authentication. The guest provider just validates the username; a real
 * provider (JWT, OAuth, password) can verify `req.token` without touching the game server.
 */
export interface AuthProvider {
  authenticate(req: JoinRequest): Promise<AuthResult>;
}

const USERNAME_RE = /^[A-Za-z0-9_\-]{3,16}$/;

export class GuestAuthProvider implements AuthProvider {
  async authenticate(req: JoinRequest): Promise<AuthResult> {
    const username = typeof req?.username === 'string' ? req.username.trim() : '';
    if (!USERNAME_RE.test(username)) {
      return { ok: false, reason: 'Username must be 3-16 letters, numbers, _ or -' };
    }
    return { ok: true, username };
  }
}
