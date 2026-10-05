/** Player-vs-player rules. */
export const PVP = {
  /** Players can hurt each other at all (groups/friendly fire come with milestone 8). */
  enabled: true,
  /** Seconds of invulnerability to players after (re)spawning; ends early when you attack. */
  spawnProtectionSec: 10,
  /**
   * Lag compensation: hits are tested against where targets were on the shooter's screen,
   * but never further back than this (limits how much a laggy shooter can "shoot the past").
   */
  maxRewindMs: 350,
  /** How long position history is kept for rewinding (must exceed maxRewindMs). */
  historyMs: 1000,
  /** Attacks waiting for the shooter's inputs to catch up are dropped after this long. */
  pendingAttackTimeoutMs: 1000,
  /** Kill feed entries stay on screen this long (client). */
  killFeedSec: 7,
} as const;
