import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { normalizeProductAttributes } from './product-attributes';
import { scoreProduct, type ProductScore, type ScoreComponent } from './product-score.service';

const componentKeys: ScoreComponent['key'][] = ['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'];
const componentLabels: Record<ScoreComponent['key'], string> = {
  energy: 'Енергія', protein: 'Білки', fat: 'Жири', carbohydrates: 'Вуглеводи',
  ingredients: 'Склад / E-добавки', organic: 'Органічність', allergens: 'Алергени'
};
const componentValuePatterns: Record<Exclude<ScoreComponent['key'], 'allergens'>, RegExp> = {
  energy: /^\d+(?:\.\d+)? кКал$/,
  protein: /^\d+(?:\.\d+)? г$/,
  fat: /^\d+(?:\.\d+)? г$/,
  carbohydrates: /^\d+(?:\.\d+)? г$/,
  ingredients: /^(?:Склад є, E-добавок не знайдено|\d+ E-добавок)$/,
  organic: /^(?:Органічний|Не органічний)$/
};
type PersistedComponents = { components: ScoreComponent[]; unavailableComponents: ScoreComponent['key'][] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const safeComponent = (value: unknown, index: number): ScoreComponent | null => {
  const key = componentKeys[index];
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'key,label,value' || value.key !== key || value.label !== componentLabels[key]) return null;
  if (value.value !== null && typeof value.value !== 'string') return null;
  if (value.key === 'allergens' ? value.value !== null && value.value !== 'Є дані від Сільпо' : value.value !== null && !componentValuePatterns[value.key as Exclude<ScoreComponent['key'], 'allergens'>].test(value.value)) return null;
  return { key, label: componentLabels[key], value: value.value as string | null };
};

const isSafeFactor = (factor: unknown): factor is string => typeof factor === 'string' && /^[+-]\d+: (?:енергетична цінність \d+(?:\.\d+)? кКал|білки \d+(?:\.\d+)? г|жири \d+(?:\.\d+)? г|вуглеводи \d+(?:\.\d+)? г|\d+ E-добавок у складі|підтверджено органічний товар)$/.test(factor);

const readCachedComponents = (value: unknown): PersistedComponents | null => {
  if (!isRecord(value) || Object.keys(value).sort().join() !== 'components,unavailableComponents') return null;
  if (!Array.isArray(value.components) || value.components.length !== componentKeys.length) return null;
  const components = value.components.map(safeComponent);
  if (components.some((component): component is null => component === null)) return null;
  const safeComponents = components as ScoreComponent[];
  if (!Array.isArray(value.unavailableComponents) || value.unavailableComponents.some((key) => typeof key !== 'string')) return null;
  const unavailable = safeComponents.filter(({ value: componentValue }) => componentValue === null).map(({ key }) => key);
  return JSON.stringify(value.unavailableComponents) === JSON.stringify(unavailable) ? { components: safeComponents, unavailableComponents: unavailable } : null;
};

const readCachedScore = (row: Record<string, unknown>, analysis: ProductScore): ProductScore | null => {
  const components = readCachedComponents(row.components);
  const factors = row.factors;
  const confidence = row.confidence;
  if (!components) return null;
  const available = components.components.length - components.unavailableComponents.length;
  const expectedConfidence = available === 0 ? null : available <= 2 ? 'low' : available <= 4 ? 'medium' : 'high';
  if (row.algorithmVersion !== 'v2' || !Array.isArray(factors) || !factors.every(isSafeFactor) || confidence !== expectedConfidence) return null;
  if (row.score !== null && (!Number.isInteger(row.score) || typeof row.score !== 'number')) return null;
  if (row.score !== null && (row.score < 0 || row.score > 100) || available === 0 && row.score !== null) return null;
  return { ...analysis, score: row.score as number | null, confidence: confidence as ProductScore['confidence'], factors: factors as string[], ...components };
};

@Injectable()
export class ProductAnalysisService {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });

  async getOrCreate(slug: string, attributes: Record<string, string>): Promise<ProductScore> {
    const analysis = scoreProduct(normalizeProductAttributes(attributes));
    const found = await this.pool.query('SELECT "algorithmVersion", "score", "confidence", "factors", "components" FROM "ProductAnalysis" WHERE "slug" = $1 AND "sourceHash" = $2 AND "algorithmVersion" = $3', [slug, analysis.sourceHash, analysis.algorithmVersion]);
    if (found.rowCount) {
      const cached = readCachedScore(found.rows[0] as Record<string, unknown>, analysis);
      if (cached) return cached;
    }
    const persistedComponents = JSON.stringify({ components: analysis.components, unavailableComponents: analysis.unavailableComponents });
    const inserted = await this.pool.query('INSERT INTO "ProductAnalysis" ("slug", "sourceHash", "algorithmVersion", "score", "confidence", "factors", "components", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) ON CONFLICT ("slug", "sourceHash", "algorithmVersion") DO NOTHING', [slug, analysis.sourceHash, analysis.algorithmVersion, analysis.score, analysis.confidence, JSON.stringify(analysis.factors), persistedComponents]);
    if (inserted.rowCount === 0) {
      const persisted = await this.pool.query('SELECT "algorithmVersion", "score", "confidence", "factors", "components" FROM "ProductAnalysis" WHERE "slug" = $1 AND "sourceHash" = $2 AND "algorithmVersion" = $3', [slug, analysis.sourceHash, analysis.algorithmVersion]);
      if (persisted.rowCount) {
        const cached = readCachedScore(persisted.rows[0] as Record<string, unknown>, analysis);
        if (cached) return cached;
      }
    }
    return analysis;
  }
}
