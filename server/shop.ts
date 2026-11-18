// Server copy of the shop's price list (src/items.ts `price`): keep the two in step.

/** What every gladiator starts with, free. */
export const STARTER = ['rudis', 'subligaculum'];

/** Gold price of everything the shop sells. */
export const PRICES: Record<string, number> = {
  cord: 30,
  subligaculum_red: 40,
  tunica: 60,
  tunica_russa: 80,
  balteus: 100,
  manica: 200,
  parma: 280,
  ocreae: 250,
  galea: 300,
  pectorale: 350,
  gladius: 400,
  hasta: 450,
};

/** Every item a gladiator can own. */
export const ALL_ITEMS = [...STARTER, ...Object.keys(PRICES)];
export const isItem = (id: unknown): id is string => typeof id === 'string' && ALL_ITEMS.includes(id);
