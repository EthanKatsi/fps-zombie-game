export interface Recipe {
  id: string;
  name: string;
  inputs: { item: string; qty: number }[];
  output: { item: string; qty: number };
}

/** Simple hand-crafting (no workbench). The server checks ingredients, space and weight. */
export const RECIPES: Recipe[] = [
  {
    id: 'bandage',
    name: 'Bandage',
    inputs: [{ item: 'cloth', qty: 2 }],
    output: { item: 'bandage', qty: 1 },
  },
  {
    id: 'barricade',
    name: 'Barricade Kit',
    inputs: [
      { item: 'wood_plank', qty: 3 },
      { item: 'nails', qty: 10 },
    ],
    output: { item: 'barricade', qty: 1 },
  },
];

export const getRecipe = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
