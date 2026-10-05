export const NETWORK = {
  /** Fixed simulation rate on server AND client prediction. One input command = one tick. */
  tickRate: 30,
  /** How often world snapshots are sent to each client. */
  snapshotRate: 20,
  /** Players / entities within this radius (m) are sent to a client. */
  interestRadius: 150,
  /** Remote entities are rendered this far in the past for smooth interpolation. */
  interpolationDelayMs: 110,
  /** Max inputs buffered per player on the server (anything beyond is dropped). */
  maxInputQueue: 20,
  /**
   * Max inputs the server will process for one player in a single tick. >1 lets a
   * lagging client catch up; the long-run rate is still capped at tickRate (anti speedhack).
   */
  maxInputsPerTick: 3,
  /** Client snaps instead of smoothing when the prediction error exceeds this (m). */
  reconcileSnapDistance: 2.0,
  /** Seconds between automatic DB saves of online players. */
  autosaveIntervalSec: 30,
} as const;

export const TICK_DT = 1 / NETWORK.tickRate;
