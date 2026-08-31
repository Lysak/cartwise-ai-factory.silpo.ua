jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('@nestjs/common', () => ({ Injectable: () => (target: unknown) => target }));

import { Pool } from 'pg';
import { ProductAnalysisService } from './product-analysis.service';

const v2Components = [
  { key: 'energy', label: 'Енергія', value: '180 кКал' },
  { key: 'protein', label: 'Білки', value: null },
  { key: 'fat', label: 'Жири', value: null },
  { key: 'carbohydrates', label: 'Вуглеводи', value: null },
  { key: 'ingredients', label: 'Склад / E-добавки', value: null },
  { key: 'organic', label: 'Органічність', value: null },
  { key: 'allergens', label: 'Алергени', value: null }
];
const v2Unavailable = ['protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'];
const persistedV2 = { components: v2Components, unavailableComponents: v2Unavailable };

const poolQuery = jest.fn();
const poolConstructor = Pool as unknown as jest.Mock;

describe('ProductAnalysisService', () => {
  beforeEach(() => {
    poolQuery.mockReset();
    poolConstructor.mockImplementation(() => ({ query: poolQuery }));
  });

  it('reuses a cached analysis for the same normalized source and version', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          algorithmVersion: 'v2',
          score: 53,
          confidence: 'low',
          factors: ['+3: енергетична цінність 180 кКал'],
          components: persistedV2
        }]
      });

    const service = new ProductAnalysisService();
    const created = await service.getOrCreate('milk', {
      'Енергетична цінність': '180'
    });
    const result = await service.getOrCreate('milk', {
      'Енергетична цінність (кКал/кДЖ)': '180/753'
    });

    expect(result).toMatchObject({ score: 53, confidence: 'low', algorithmVersion: 'v2', unavailableComponents: v2Unavailable });
    expect(result.sourceHash).toBe(created.sourceHash);
    expect(poolQuery).toHaveBeenCalledTimes(3);
    expect(poolQuery.mock.calls[0][0]).toContain('SELECT');
    expect(poolQuery.mock.calls[2][0]).toContain('SELECT');
    expect(poolQuery.mock.calls[2][1]).toEqual(poolQuery.mock.calls[0][1]);
    expect(poolQuery.mock.calls.filter(([query]) => query.includes('INSERT'))).toHaveLength(1);
  });

  it('creates a distinct cached row when normalized source data changes', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const service = new ProductAnalysisService();
    const first = await service.getOrCreate('milk', {
      'Енергетична цінність': '180'
    });
    const second = await service.getOrCreate('milk', {
      'Енергетична цінність': '181'
    });

    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(first.algorithmVersion).toBe(second.algorithmVersion);
    expect(poolQuery).toHaveBeenCalledTimes(4);
    expect(poolQuery.mock.calls[1][0]).toContain('INSERT');
    expect(poolQuery.mock.calls[3][0]).toContain('INSERT');
    expect(poolQuery.mock.calls[1][1]).toEqual([
      'milk',
      first.sourceHash,
      'v2',
      53,
      'low',
      JSON.stringify(first.factors),
      JSON.stringify({ components: first.components, unavailableComponents: first.unavailableComponents })
    ]);
    expect(poolQuery.mock.calls[3][1][0]).toBe('milk');
    expect(poolQuery.mock.calls[3][1][1]).toBe(second.sourceHash);
    expect(poolQuery.mock.calls[3][1][1]).not.toBe(poolQuery.mock.calls[1][1][1]);
  });

  it('returns the persisted winner when its insert loses a unique-key race', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          algorithmVersion: 'v2',
          score: 47,
          confidence: 'low',
          factors: ['+3: енергетична цінність 180 кКал'],
          components: persistedV2
        }]
      });

    const result = await new ProductAnalysisService().getOrCreate('milk', {
      'Енергетична цінність': '180'
    });

    expect(result).toMatchObject({
      score: 47,
      confidence: 'low',
      factors: ['+3: енергетична цінність 180 кКал'],
      components: v2Components,
      unavailableComponents: v2Unavailable
    });
    expect(poolQuery).toHaveBeenCalledTimes(3);
    expect(poolQuery.mock.calls[2][0]).toContain('SELECT');
    expect(poolQuery.mock.calls[2][1]).toEqual(poolQuery.mock.calls[0][1]);
  });

  it('serializes only safe computed output and never raw detail context', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await new ProductAnalysisService().getOrCreate('milk', {
      Склад: 'secret-ingredient-text E100',
      token: 'secret-token',
      providerEnvelope: 'secret-provider-envelope',
      branchId: 'secret-branch',
      userId: 'secret-user'
    });

    const serializedCachePayload = JSON.stringify(poolQuery.mock.calls[1][1]);
    expect(serializedCachePayload).not.toMatch(/secret-ingredient-text|secret-token|secret-provider-envelope|secret-branch|secret-user/);
  });

  it('stores and returns six gaps for a no-signal analysis without a score', async () => {
    poolQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new ProductAnalysisService().getOrCreate('unknown', {});

    expect(result).toMatchObject({ score: null, confidence: null, factors: [], algorithmVersion: 'v2' });
    expect(result.components).toHaveLength(7);
    expect(result.components.every(({ value }) => value === null)).toBe(true);
    expect(result.unavailableComponents).toEqual(['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens']);
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(poolQuery.mock.calls[1][1]).toEqual([
      'unknown',
      result.sourceHash,
      'v2',
      null,
      null,
      '[]',
      JSON.stringify({ components: result.components, unavailableComponents: result.unavailableComponents })
    ]);
  });

  it('ignores an old or malformed cached shape and creates a v2 result', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ algorithmVersion: 'v1', score: 99, confidence: 'high', factors: [], components: [] }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new ProductAnalysisService().getOrCreate('milk', { 'Енергетична цінність': '180' });

    expect(result.algorithmVersion).toBe('v2');
    expect(result.score).toBe(53);
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(poolQuery.mock.calls[1][0]).toContain('INSERT');
    expect(poolQuery.mock.calls[1][1][2]).toBe('v2');
  });

  it('rejects cached raw allergen text and recalculates the safe v2 shape', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ algorithmVersion: 'v2', score: 53, confidence: 'low', factors: [], components: { ...persistedV2, components: [...v2Components.slice(0, 6), { key: 'allergens', label: 'Алергени', value: 'Молоко' }] } }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new ProductAnalysisService().getOrCreate('milk', { 'Енергетична цінність': '180', 'Містить алергени': 'Молоко' });

    expect(result.components.at(-1)).toEqual({ key: 'allergens', label: 'Алергени', value: 'Є дані від Сільпо' });
    expect(JSON.stringify(poolQuery.mock.calls[1][1])).not.toContain('Молоко');
  });

  it('rejects cached components with additional fields and writes a safe copy', async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ algorithmVersion: 'v2', score: 53, confidence: 'low', factors: ['+3: енергетична цінність 180 кКал'], components: { ...persistedV2, components: [{ ...v2Components[0], raw: 'secret' }, ...v2Components.slice(1)] } }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new ProductAnalysisService().getOrCreate('milk', { 'Енергетична цінність': '180' });

    expect(result.components[0]).toEqual({ key: 'energy', label: 'Енергія', value: '180 кКал' });
    expect(poolQuery.mock.calls[1][0]).toContain('INSERT');
    expect(JSON.stringify(poolQuery.mock.calls[1][1])).not.toContain('raw');
  });
});
