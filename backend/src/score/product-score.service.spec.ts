import { scoreProduct } from './product-score.service';
import type { NormalizedProductData } from './product-attributes';

const emptyData: NormalizedProductData = {
  energyKcal: null, proteinGrams: null, fatGrams: null, carbohydrateGrams: null,
  ingredients: null, additiveCodes: [], allergenText: null, isOrganic: null
};

const withAllergenData = (allergenText: string): NormalizedProductData => ({ ...emptyData, energyKcal: 180, proteinGrams: 6.8, allergenText });

describe('scoreProduct', () => {
  it('returns no score when every signal is unavailable', () => {
    const result = scoreProduct(emptyData);
    expect(result.score).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.algorithmVersion).toBe('v2');
    expect(result.components.map(({ key }) => key)).toEqual(['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens']);
    expect(result.components.every((component) => component.value === null)).toBe(true);
    expect(result.unavailableComponents).toEqual(['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens']);
  });

  it('applies only available factors and counts their coverage', () => {
    const result = scoreProduct({ ...emptyData, energyKcal: 180 });
    expect(result.score).toBe(53);
    expect(result.confidence).toBe('low');
    expect(result.factors).toEqual(['+3: енергетична цінність 180 кКал']);
    expect(result.unavailableComponents).toEqual(['protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens']);
  });

  it('keeps explicit non-organic status as a factual zero-delta signal', () => {
    const result = scoreProduct({ ...emptyData, energyKcal: 180, proteinGrams: 6.8, isOrganic: false });

    expect(result.score).toBe(55);
    expect(result.confidence).toBe('medium');
    expect(result.components.find(({ key }) => key === 'organic')).toMatchObject({ value: 'Не органічний' });
    expect(result.factors).toEqual(['+3: енергетична цінність 180 кКал', '+2: білки 6.8 г']);
  });

  it('caps additive penalties and hashes normalized data deterministically', () => {
    const data = { ...emptyData, energyKcal: 612, proteinGrams: 6.8, fatGrams: 41.9, carbohydrateGrams: 51.8, ingredients: 'склад', additiveCodes: ['E100', 'E101', 'E102', 'E103', 'E104', 'E105'], isOrganic: true as const };
    const result = scoreProduct(data);
    expect(result.score).toBe(38);
    expect(result.confidence).toBe('high');
    expect(result.factors).toContain('-10: 6 E-добавок у складі');
    expect(result.sourceHash).toBe(scoreProduct({ ...data, additiveCodes: [...data.additiveCodes] }).sourceHash);
  });

  it('exposes allergen presence without persisting its text or changing the score', () => {
    const withoutAllergen = scoreProduct({ ...emptyData, energyKcal: 180, proteinGrams: 6.8 });
    const withAllergen = scoreProduct({ ...emptyData, energyKcal: 180, proteinGrams: 6.8, allergenText: 'Молоко' });

    expect(withAllergen.score).toBe(withoutAllergen.score);
    expect(withAllergen.confidence).toBe('medium');
    expect(withAllergen.components.at(-1)).toEqual({ key: 'allergens', label: 'Алергени', value: 'Є дані від Сільпо' });
    expect(JSON.stringify(withAllergen)).not.toContain('Молоко');
    expect(withAllergen.sourceHash).not.toBe(withoutAllergen.sourceHash);
    expect(scoreProduct({ ...withAllergenData('Молоко'), allergenText: 'Яйце' }).sourceHash).toBe(withAllergen.sourceHash);
  });
});
