import { Prisma } from '../generated/prisma/client';
import { calculatePriceIntelligence, type PriceObservation } from './price-intelligence';

const price = (value: string) => new Prisma.Decimal(value);
const now = new Date('2026-01-31T12:00:00.000Z');

const observation = (observedAt: string, value: string): PriceObservation => ({
  observedAt: new Date(observedAt),
  price: price(value)
});

describe('calculatePriceIntelligence', () => {
  it('calculates 7, 30 and 90 day windows from observedAt', () => {
    const result = calculatePriceIntelligence([
      observation('2025-11-01T12:00:00.000Z', '12.00'),
      observation('2026-01-01T12:00:00.000Z', '10.00'),
      observation('2026-01-10T12:00:00.000Z', '9.00'),
      observation('2026-01-25T12:00:00.000Z', '8.00'),
      observation('2026-01-30T12:00:00.000Z', '7.00')
    ], now);

    expect(result.min7d).toEqual(price('7.00'));
    expect(result.min30d).toEqual(price('7.00'));
    expect(result.min90d).toEqual(price('7.00'));
    expect(result.allTimeMin).toEqual(price('7.00'));
    expect(result.average30d).toEqual(price('8.50'));
  });

  it('uses observation time instead of array order for the windows', () => {
    const result = calculatePriceIntelligence([
      observation('2026-01-30T12:00:00.000Z', '7.00'),
      observation('2025-12-01T12:00:00.000Z', '3.00'),
      observation('2026-01-01T12:00:00.000Z', '10.00')
    ], now);

    expect(result.min7d).toEqual(price('7.00'));
    expect(result.min30d).toEqual(price('7.00'));
    expect(result.min90d).toEqual(price('3.00'));
    expect(result.allTimeMin).toEqual(price('3.00'));
    expect(result.average30d).toEqual(price('8.50'));
  });

  it('reports a real drop without treating it as a new low when it is not one', () => {
    const result = calculatePriceIntelligence([
      observation('2026-01-10T12:00:00.000Z', '7.00'),
      observation('2026-01-20T12:00:00.000Z', '9.00'),
      observation('2026-01-30T12:00:00.000Z', '8.00')
    ], now);

    expect(result.eventTypes).toEqual(['price_drop']);
  });

  it('reports only the window whose previous observations are beaten by a new minimum', () => {
    const result = calculatePriceIntelligence([
      observation('2025-11-01T12:00:00.000Z', '5.00'),
      observation('2025-12-01T12:00:00.000Z', '6.00'),
      observation('2026-01-10T12:00:00.000Z', '7.00'),
      observation('2026-01-30T12:00:00.000Z', '6.50')
    ], now);

    expect(result.eventTypes).toEqual(['price_drop', 'lowest_30d']);
  });

  it('anchors low-event windows to the latest observation, not a later now', () => {
    const result = calculatePriceIntelligence([
      observation('2026-01-23T18:00:00.000Z', '5.00'),
      observation('2026-01-28T12:00:00.000Z', '7.00'),
      observation('2026-01-30T12:00:00.000Z', '6.00')
    ], now);

    expect(result.eventTypes).toEqual(['price_drop']);
  });
});
