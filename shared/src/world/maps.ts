import { generateCity } from './city/generateCity';
import type { MapData } from './mapData';
import { generateTestMap } from './testMap';

export type MapId = 'city' | 'testmap';

/** Build a map from its id + seed. Client and server both call this and get identical data. */
export const loadMap = (id: string, seed: number): MapData => {
  if (id === 'city') return generateCity(seed);
  if (id === 'testmap') return generateTestMap(seed);
  throw new Error(`Unknown map '${id}'`);
};
