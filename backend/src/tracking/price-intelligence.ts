import { Prisma } from '../generated/prisma/client';

export type PriceObservation = {
  price: Prisma.Decimal;
  observedAt: Date;
};

export type PriceEventType =
  | 'price_drop'
  | 'lowest_7d'
  | 'lowest_30d'
  | 'lowest_90d'
  | 'all_time_low';

export type PriceIntelligence = {
  min7d: Prisma.Decimal | null;
  min30d: Prisma.Decimal | null;
  min90d: Prisma.Decimal | null;
  allTimeMin: Prisma.Decimal | null;
  average30d: Prisma.Decimal | null;
  eventTypes: PriceEventType[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const calculatePriceIntelligence = (
  observations: readonly PriceObservation[],
  now: Date
): PriceIntelligence => {
  const ordered = observations
    .filter(({ observedAt }) => observedAt.getTime() <= now.getTime())
    .toSorted((left, right) => left.observedAt.getTime() - right.observedAt.getTime());

  if (ordered.length === 0) {
    return {
      min7d: null,
      min30d: null,
      min90d: null,
      allTimeMin: null,
      average30d: null,
      eventTypes: []
    };
  }

  const latest = ordered.at(-1)!;
  const min7d = minimum(ordered, now, 7);
  const min30d = minimum(ordered, now, 30);
  const min90d = minimum(ordered, now, 90);
  const allTimeMin = minimum(ordered);
  const last30d = inWindow(ordered, now, 30);
  const average30d = last30d.length === 0
    ? null
    : last30d.reduce((sum, item) => sum.plus(item.price), new Prisma.Decimal('0')).div(last30d.length);
  const previous = ordered.at(-2);
  const eventTypes: PriceEventType[] = [];

  if (previous && latest.price.lt(previous.price)) eventTypes.push('price_drop');
  if (isNewMinimum(ordered, latest, latest.observedAt, 7)) eventTypes.push('lowest_7d');
  if (isNewMinimum(ordered, latest, latest.observedAt, 30)) eventTypes.push('lowest_30d');
  if (isNewMinimum(ordered, latest, latest.observedAt, 90)) eventTypes.push('lowest_90d');
  if (isNewMinimum(ordered, latest)) eventTypes.push('all_time_low');

  return { min7d, min30d, min90d, allTimeMin, average30d, eventTypes };
};

const inWindow = (observations: readonly PriceObservation[], now: Date, days?: number): PriceObservation[] => {
  const cutoff = days === undefined ? -Infinity : now.getTime() - days * DAY_MS;
  return observations.filter(({ observedAt }) => observedAt.getTime() >= cutoff && observedAt.getTime() <= now.getTime());
};

const minimum = (observations: readonly PriceObservation[], now?: Date, days?: number): Prisma.Decimal | null => {
  const values = now === undefined ? observations : inWindow(observations, now, days);
  return values.reduce<Prisma.Decimal | null>(
    (minimumPrice, item) => minimumPrice === null || item.price.lt(minimumPrice) ? item.price : minimumPrice,
    null
  );
};

const isNewMinimum = (
  observations: readonly PriceObservation[],
  latest: PriceObservation,
  now?: Date,
  days?: number
): boolean => {
  const previous = (days === undefined ? observations : inWindow(observations, now!, days))
    .filter(({ observedAt }) => observedAt.getTime() < latest.observedAt.getTime());
  return previous.length > 0 && previous.every(({ price }) => latest.price.lt(price));
};
