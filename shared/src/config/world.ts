import type { BuildingType } from '../world/mapData';

/**
 * City generation. The city is deterministic for a given seed, so changing anything here
 * changes the map for everyone - restart the server and refresh clients after editing.
 */
export const CITY = {
  /** Blocks per side (city is blocksPerSide x blocksPerSide). */
  blocksPerSide: 6,
  /** Size of one city block (m), sidewalk included. */
  blockSize: 56,
  streetWidth: 14,
  sidewalkWidth: 3,
  /** Height of sidewalks / block surface above the road. */
  curbHeight: 0.15,
  /** Height of the quarantine wall around the city. */
  perimeterWallHeight: 7,

  floorHeight: 3.2,
  wallThickness: 0.25,
  doorWidth: 1.2,
  doorHeight: 2.2,
  stairWidth: 1.4,

  /** Share of generic blocks by kind (the required shops and police station are placed first). */
  blockWeights: {
    residential: 45,
    commercial: 30,
    park: 13,
    parking: 12,
  },
  /** Each of these buildings is guaranteed to exist this many times. */
  requiredBuildings: [
    ['grocery', 2],
    ['pharmacy', 2],
    ['hardware', 2],
    ['gunshop', 1],
  ] as [BuildingType, number][],

  /** Abandoned cars per 100 m of street. */
  carsPer100m: 2.2,
  /** Chance a car's trunk is a lootable container. */
  carTrunkChance: 0.5,
  debrisPer100m: 3,
  /** Chance that an interior door starts open. */
  doorOpenChance: 0.3,
  /** Number of spawn points around the outer ring road. */
  edgeSpawnPoints: 32,
} as const;

/**
 * The full world (map id 'world'): the walled downtown in the north-east, the suburbs in the
 * south-east, a large forest covering the west, joined by highways and dirt roads.
 * Positions are world metres; +x east, +z south.
 */
export const WORLD = {
  halfSize: 640,
  /** Downtown: the walled city grid (CITY settings), gates on its west and south sides. */
  city: { center: [300, -300] as [number, number], wreckage: 0.8 },
  /** Suburbs: a grid of residential blocks. */
  suburbs: {
    center: [300, 300] as [number, number],
    blocksPerSide: 6,
    blockSize: 56,
    streetWidth: 12,
    blockWeights: { residential: 82, park: 12, parking: 6 },
    requiredBuildings: [['grocery', 1], ['pharmacy', 1], ['hardware', 1]] as [BuildingType, number][],
    carsPer100m: 0.9,
    wreckage: 0.25,
  },
  /** Highway width (asphalt) and dirt road width. */
  roadWidth: 12,
  dirtRoadWidth: 7,
  /** Forest: jittered-grid tree placement. Cell size (m) and fill chance; sparser outside the forest. */
  forest: { maxX: 30, cell: 10, fill: 0.82, fieldCell: 22, fieldFill: 0.3, pineShare: 0.7 },
  /** Cabins in forest clearings. */
  cabins: 10,
  /** Drivable vehicles placed at server start. */
  vehicles: { suburbs: 14, city: 8, roads: 8, forest: 6, motorcycleShare: 0.25, pickupShare: 0.3 },
  /** Player spawn points spread along the roads outside the city. */
  spawnPoints: 48,
} as const;

/** Client rendering / LOD. */
export const RENDER = {
  chunkSize: 64,
  /** Interior walls, furniture and small props are hidden beyond this distance (m). */
  detailDistance: 95,
  fogNear: 25,
  fogFar: 190,
  cameraFar: 260,
  /** Half-size (m) of the shadow area that follows the player. */
  shadowExtent: 60,
} as const;
