/**
 * Ordered schema migrations. SQL is kept to the subset shared by SQLite and Postgres
 * (TEXT / INTEGER / REAL, JSON stored as TEXT) so a Postgres repository can reuse it.
 * Never edit a released migration; append a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'players',
    sql: `
      CREATE TABLE players (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL,
        username_key  TEXT NOT NULL UNIQUE,
        pos_x         REAL NOT NULL,
        pos_y         REAL NOT NULL,
        pos_z         REAL NOT NULL,
        yaw           REAL NOT NULL DEFAULT 0,
        stats         TEXT NOT NULL,
        inventory     TEXT NOT NULL,
        group_id      TEXT,
        spawn_bed_id  TEXT,
        kills         INTEGER NOT NULL DEFAULT 0,
        deaths        INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'groups',
    sql: `
      CREATE TABLE groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        name_key    TEXT NOT NULL UNIQUE,
        leader_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX players_group ON players (group_id);
    `,
  },
];
