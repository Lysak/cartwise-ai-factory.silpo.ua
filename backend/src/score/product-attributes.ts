export type NormalizedProductData = {
  energyKcal: number | null;
  proteinGrams: number | null;
  fatGrams: number | null;
  carbohydrateGrams: number | null;
  ingredients: string | null;
  additiveCodes: string[];
  allergenText: string | null;
  isOrganic: boolean | null;
};

const valueFor = (attributes: Record<string, string>, keys: string[]): string | null => {
  for (const key of keys) if (typeof attributes[key] === 'string' && attributes[key].trim()) return attributes[key].trim();
  return null;
};

const numberFrom = (value: string | null, energy = false): number | null => {
  const source = energy ? value?.split('/')[0] ?? null : value;
  if (!source || (energy && !/^\s*\d+(?:[.,]\d+)?\s*(?:\/\s*\d+(?:[.,]\d+)?)?\s*$/.test(value ?? ''))) return null;
  if (!/^\s*\d+(?:[.,]\d+)?\s*$/.test(source)) return null;
  const result = Number(source.replace(',', '.'));
  return Number.isFinite(result) ? result : null;
};

export const normalizeProductAttributes = (attributes: Record<string, string>): NormalizedProductData => {
  const ingredients = valueFor(attributes, ['Склад']);
  const additives = ingredients ? [...new Set((ingredients.match(/\bE\d{3,4}\b/gi) ?? []).map((code) => code.toUpperCase()))] : [];
  const allergenText = valueFor(attributes, ['Містить алергени']);
  const organic = valueFor(attributes, ['Органіка/Еко']);
  return {
    energyKcal: numberFrom(valueFor(attributes, ['Енергетична цінність (кКал/кДЖ)', 'Енергетична цінність']), true),
    proteinGrams: numberFrom(valueFor(attributes, ['Білки (г)'])),
    fatGrams: numberFrom(valueFor(attributes, ['Жири (г)'])),
    carbohydrateGrams: numberFrom(valueFor(attributes, ['Вуглеводи (г)'])),
    ingredients,
    additiveCodes: additives,
    allergenText,
    isOrganic: organic ? !/не\s*органічн|неорганічн/i.test(organic) && /органічн/i.test(organic) : null
  };
};
