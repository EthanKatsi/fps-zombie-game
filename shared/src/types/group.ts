import type { GroupId, PlayerId } from './common';

export interface Group {
  id: GroupId;
  name: string;
  leaderId: PlayerId;
  memberIds: PlayerId[];
  /** Pending invites (player ids), cleared on accept/decline. */
  invites: PlayerId[];
  createdAt: number;
}
