import { normalizeProductAttributes } from './product-attributes';

describe('normalizeProductAttributes', () => {
  it('normalizes only known Ukrainian labels and ingredient E-codes', () => {
    expect(normalizeProductAttributes({
      'Енергетична цінність (кКал/кДЖ)': '612/2568',
      'Білки (г)': '6,8', 'Жири (г)': '41.9', 'Вуглеводи (г)': '51,8',
      'Склад': 'цукор, e330, E202, E330', 'Органіка/Еко': 'Органічний', unknown: '99'
    })).toEqual({
      energyKcal: 612, proteinGrams: 6.8, fatGrams: 41.9, carbohydrateGrams: 51.8,
      ingredients: 'цукор, e330, E202, E330', additiveCodes: ['E330', 'E202'], allergenText: null, isOrganic: true
    });
  });

  it('keeps malformed and absent signals unavailable', () => {
    expect(normalizeProductAttributes({ 'Енергетична цінність': '27/', unrelated: '4' })).toEqual({
      energyKcal: null, proteinGrams: null, fatGrams: null, carbohydrateGrams: null,
      ingredients: null, additiveCodes: [], allergenText: null, isOrganic: null
    });
  });

  it('does not mark explicitly non-organic wording as organic', () => {
    expect(normalizeProductAttributes({ 'Органіка/Еко': 'Не органічний продукт' }).isOrganic).toBe(false);
    expect(normalizeProductAttributes({ 'Органіка/Еко': 'неорганічний' }).isOrganic).toBe(false);
  });

  it('preserves observed allergen text and keeps it null when absent', () => {
    expect(normalizeProductAttributes({ 'Містить алергени': 'Молоко' }).allergenText).toBe('Молоко');
    expect(normalizeProductAttributes({}).allergenText).toBeNull();
  });
});
