import { describe, expect, it } from 'vitest';
import { formatSessionCost } from './sessionCost';

describe('formatSessionCost', () => {
  it('formats numeric costs', () => {
    expect(formatSessionCost(0.012345)).toBe('$0.0123');
  });

  it('formats PostgreSQL NUMERIC string values', () => {
    expect(formatSessionCost('0.012345')).toBe('$0.0123');
  });

  it('preserves numeric and PostgreSQL string zero costs', () => {
    expect(formatSessionCost(0)).toBe('$0.0000');
    expect(formatSessionCost('0')).toBe('$0.0000');
    expect(formatSessionCost('0.000000')).toBe('$0.0000');
  });

  it('omits absent and invalid costs instead of throwing', () => {
    expect(formatSessionCost(null)).toBeNull();
    expect(formatSessionCost('')).toBeNull();
    expect(formatSessionCost('   ')).toBeNull();
    expect(formatSessionCost('\t')).toBeNull();
    expect(formatSessionCost('not-a-number')).toBeNull();
  });
});
