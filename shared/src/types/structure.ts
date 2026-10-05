import type { GroupId, PlayerId, Vec3 } from './common';

export type StructureKind =
  | 'wall'
  | 'floor'
  | 'doorway'
  | 'door'
  | 'barricade'
  | 'storage_chest'
  | 'campfire'
  | 'bed';

/** A player-built (or claimed) piece. Persisted in the `structures` table. */
export interface Structure {
  id: string;
  kind: StructureKind;
  position: Vec3;
  /** Rotation around Y in radians (placement snaps to 90-degree steps). */
  rotY: number;
  health: number;
  maxHealth: number;
  ownerId: PlayerId;
  /** Group members share access to doors and chests. */
  groupId: GroupId | null;
  /** Doors only. */
  locked?: boolean;
  open?: boolean;
  /** Storage chests only: references a Container id. */
  containerId?: string;
  createdAt: number;
}

/** A claimed pre-existing city building. */
export interface BuildingClaim {
  buildingId: string;
  ownerId: PlayerId;
  groupId: GroupId | null;
  claimedAt: number;
}
