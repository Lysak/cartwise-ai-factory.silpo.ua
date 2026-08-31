import { createHash } from 'node:crypto';
import type { NormalizedProductData } from './product-attributes';

export type ScoreComponent = { key: 'energy' | 'protein' | 'fat' | 'carbohydrates' | 'ingredients' | 'organic' | 'allergens'; label: string; value: string | null };
export type ProductScore = { score: number | null; confidence: 'low' | 'medium' | 'high' | null; factors: string[]; components: ScoreComponent[]; unavailableComponents: ScoreComponent['key'][]; algorithmVersion: 'v1' | 'v2'; sourceHash: string };

const component = (key: ScoreComponent['key'], label: string, value: string | null): ScoreComponent => ({ key, label, value });
const factor = (delta: number, text: string): string => `${delta > 0 ? '+' : ''}${delta}: ${text}`;

export const scoreProduct = (data: NormalizedProductData): ProductScore => {
  const components = [
    component('energy', 'Енергія', data.energyKcal === null ? null : `${data.energyKcal} кКал`),
    component('protein', 'Білки', data.proteinGrams === null ? null : `${data.proteinGrams} г`),
    component('fat', 'Жири', data.fatGrams === null ? null : `${data.fatGrams} г`),
    component('carbohydrates', 'Вуглеводи', data.carbohydrateGrams === null ? null : `${data.carbohydrateGrams} г`),
    component('ingredients', 'Склад / E-добавки', data.ingredients === null ? null : data.additiveCodes.length ? `${data.additiveCodes.length} E-добавок` : 'Склад є, E-добавок не знайдено'),
    component('organic', 'Органічність', data.isOrganic === true ? 'Органічний' : data.isOrganic === false ? 'Не органічний' : null),
    component('allergens', 'Алергени', data.allergenText === null ? null : 'Є дані від Сільпо')
  ];
  const canonical = JSON.stringify({ energyKcal: data.energyKcal, proteinGrams: data.proteinGrams, fatGrams: data.fatGrams, carbohydrateGrams: data.carbohydrateGrams, ingredients: data.ingredients !== null, additiveCodes: data.additiveCodes, isOrganic: data.isOrganic, allergenText: data.allergenText !== null });
  const sourceHash = createHash('sha256').update(canonical).digest('hex');
  const available = components.filter(({ value }) => value !== null).length;
  const unavailableComponents = components.filter(({ value }) => value === null).map(({ key }) => key);
  if (!available) return { score: null, confidence: null, factors: [], components, unavailableComponents, algorithmVersion: 'v2', sourceHash };
  let score = 50;
  const factors: string[] = [];
  const add = (delta: number, text: string) => { score += delta; if (delta) factors.push(factor(delta, text)); };
  if (data.energyKcal !== null) add(data.energyKcal <= 100 ? 6 : data.energyKcal <= 250 ? 3 : data.energyKcal <= 450 ? 0 : -4, `енергетична цінність ${data.energyKcal} кКал`);
  if (data.proteinGrams !== null) add(data.proteinGrams >= 10 ? 5 : data.proteinGrams >= 5 ? 2 : 0, `білки ${data.proteinGrams} г`);
  if (data.fatGrams !== null) add(data.fatGrams <= 3 ? 2 : data.fatGrams <= 20 ? 0 : -3, `жири ${data.fatGrams} г`);
  if (data.carbohydrateGrams !== null) add(data.carbohydrateGrams <= 10 ? 2 : data.carbohydrateGrams <= 40 ? 0 : -2, `вуглеводи ${data.carbohydrateGrams} г`);
  if (data.ingredients !== null && data.additiveCodes.length) add(-Math.min(10, data.additiveCodes.length * 2), `${data.additiveCodes.length} E-добавок у складі`);
  if (data.isOrganic === true) add(5, 'підтверджено органічний товар');
  return { score: Math.round(Math.min(100, Math.max(0, score))), confidence: available <= 2 ? 'low' : available <= 4 ? 'medium' : 'high', factors, components, unavailableComponents, algorithmVersion: 'v2', sourceHash };
};
