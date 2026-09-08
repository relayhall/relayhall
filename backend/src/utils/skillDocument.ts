import { parseDocument } from 'yaml';

export const MAX_SKILL_MD_BYTES = 524288;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ParsedSkillDocument {
  name: string;
  description: string;
}

export class SkillDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillDocumentError';
  }
}

/** Validate the required Agent Skills SKILL.md contract and extract metadata. */
export function parseSkillDocument(skillMd: unknown, expectedName?: string): ParsedSkillDocument {
  if (typeof skillMd !== 'string' || !skillMd.length) {
    throw new SkillDocumentError('skill_md must be a non-empty SKILL.md document');
  }
  if (Buffer.byteLength(skillMd, 'utf8') > MAX_SKILL_MD_BYTES) {
    throw new SkillDocumentError(`skill_md must be at most ${MAX_SKILL_MD_BYTES} UTF-8 bytes`);
  }

  const normalized = skillMd.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new SkillDocumentError('SKILL.md must begin with YAML frontmatter delimited by ---');
  }
  const close = normalized.indexOf('\n---\n', 4);
  if (close < 0) {
    throw new SkillDocumentError('SKILL.md YAML frontmatter must have a closing --- delimiter');
  }

  const yamlText = normalized.slice(4, close);
  const document = parseDocument(yamlText, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length > 0) {
    throw new SkillDocumentError(`Invalid SKILL.md YAML frontmatter: ${document.errors[0].message}`);
  }
  const metadata = document.toJS() as unknown;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new SkillDocumentError('SKILL.md frontmatter must be a YAML mapping');
  }
  const value = metadata as Record<string, unknown>;
  if (typeof value.name !== 'string' || !SKILL_NAME_RE.test(value.name)
      || value.name.length < 1 || value.name.length > 64) {
    throw new SkillDocumentError(
      'SKILL.md name must be 1..64 lowercase letters, numbers, or single hyphen-separated segments',
    );
  }
  if (expectedName !== undefined && value.name !== expectedName) {
    throw new SkillDocumentError(`SKILL.md name '${value.name}' must match catalog name '${expectedName}'`);
  }
  if (typeof value.description !== 'string' || !value.description.trim()
      || value.description.length > 1024) {
    throw new SkillDocumentError('SKILL.md description must be a non-blank string of at most 1024 characters');
  }
  return { name: value.name, description: value.description };
}

/** Compatibility helper for the existing form/CLI while SKILL.md stays canonical. */
export function buildSkillDocument(name: string, description: string, markdownBody = ''): string {
  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    markdownBody,
  ].join('\n');
}
