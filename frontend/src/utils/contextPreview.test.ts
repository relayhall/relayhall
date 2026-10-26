import { expect, test } from 'vitest';
import { contextOperations, estimateContextTokens } from './contextPreview';
test('estimate counts Unicode scalars and exact whitespace', () => {
  expect(estimateContextTokens('')).toBe(0);
  expect(estimateContextTokens('\u{1F680}\u{1F680}\u{1F680}\u{1F680}')).toBe(1);
  expect(estimateContextTokens('    x')).toBe(2);
});
test('only supported operations are offered', () => {
  expect(contextOperations('report')).toEqual(['record']);
  expect(contextOperations('project')).toEqual(['brief', 'resources', 'record']);
  expect(contextOperations('skill')).toEqual(['record', 'skill-content']);
});
