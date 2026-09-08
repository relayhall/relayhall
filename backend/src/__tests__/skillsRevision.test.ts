import { buildSkillDocument, parseSkillDocument, SkillDocumentError } from '../utils/skillDocument';

describe('immutable SKILL.md validation', () => {
  it('accepts the native required frontmatter and preserves multiline Markdown', () => {
    const body = 'First paragraph.\n\nSecond paragraph.';
    const text = buildSkillDocument('release-check', 'Verify a release safely', body);
    expect(parseSkillDocument(text, 'release-check')).toEqual({
      name: 'release-check', description: 'Verify a release safely',
    });
    expect(text).toContain(body);
  });

  it.each([
    ['duplicate keys', '---\nname: release-check\nname: other\ndescription: x\n---\n'],
    ['invalid name', '---\nname: Release Check\ndescription: x\n---\n'],
    ['mismatched name', '---\nname: other\ndescription: x\n---\n'],
    ['missing description', '---\nname: release-check\n---\n'],
  ])('fails closed on %s', (_label, text) => {
    expect(() => parseSkillDocument(text, 'release-check')).toThrow(SkillDocumentError);
  });
});
