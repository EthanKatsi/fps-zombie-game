/**
 * Server operational config. Gameplay balance lives in shared/src/config.
 * Every value can be overridden with an environment variable.
 */
const env = (key: string, fallback: string): string => process.env[key] ?? fallback;
const envNum = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
};
const envBool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  return v === undefined ? fallback : v === '1' || v.toLowerCase() === 'true';
};

export const SERVER_CONFIG = {
  port: envNum('PORT', 2567),
  /** SQLite file. Swap the repository implementation to move to Postgres. */
  dbPath: env('DB_PATH', 'data/game.db'),
  /** 'city' (default) or 'testmap'. */
  mapId: env('MAP_ID', 'city'),
  mapSeed: envNum('MAP_SEED', 1337),
  maxPlayers: envNum('MAX_PLAYERS', 64),
  /** Built client to serve in production (`npm run build`). */
  clientDist: env('CLIENT_DIST', '../client/dist'),
  /** When true, bases whose owners are all offline cannot be damaged (milestone 10). */
  offlineRaidProtection: envBool('OFFLINE_RAID_PROTECTION', false),
  /** Allowed browser origins for Socket.IO (dev server + same origin). */
  corsOrigins: env('CORS_ORIGINS', 'http://localhost:5173').split(','),
} as const;
