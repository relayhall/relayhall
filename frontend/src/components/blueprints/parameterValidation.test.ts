import { describe, expect, test } from 'vitest';
import { matchesBlueprintPattern, parameterError } from './parameterValidation';
import type { BlueprintParameter } from '../../types/blueprint';
const parameter = (type: BlueprintParameter['type'], constraints = {}): BlueprintParameter => ({ key: 'answer', label: 'Answer', promptText: 'Answer', type, required: true, constraints });
describe('bounded Blueprint parameter validation', () => {
  test('anchored classes and bounded repeats accept literal valid values and refuse alternatives', () => {
    expect(matchesBlueprintPattern('^INC-[0-9]{1,6}$', 'INC-12')).toBe(true);
    for (const value of ['INC-', 'INC-1234567', 'INC-12suffix', 'prefixINC-12']) expect(matchesBlueprintPattern('^INC-[0-9]{1,6}$', value)).toBe(false);
    expect(() => matchesBlueprintPattern('^(a+)+$', 'a'.repeat(1000))).toThrow();
  });
  test('integer, boolean, enum, date, length and required controls name refusals', () => {
    expect(parameterError(parameter('integer', { min: 2, max: 4 }), 1)).toBeTruthy();
    expect(parameterError(parameter('integer', { min: 2, max: 4 }), 5)).toBeTruthy();
    expect(parameterError(parameter('integer'), 2.5)).toBeTruthy();
    expect(parameterError(parameter('boolean'), false)).toBeNull();
    expect(parameterError(parameter('boolean'), 'false')).toBeTruthy();
    expect(parameterError(parameter('enum', { enum: ['hold'] }), 'go')).toBeTruthy();
    expect(parameterError(parameter('date'), '2026-09-06')).toBeNull();
    expect(parameterError(parameter('date'), 'tomorrow')).toBeTruthy();
    expect(parameterError(parameter('string', { minLength: 2, maxLength: 3 }), 'a')).toBeTruthy();
    expect(parameterError(parameter('string', { minLength: 2, maxLength: 3 }), 'abcd')).toBeTruthy();
    expect(parameterError(parameter('text'), undefined)).toBeTruthy();
  });
});
