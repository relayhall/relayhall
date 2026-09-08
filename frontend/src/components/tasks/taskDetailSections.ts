export interface TaskDetailSection {
  title: string;
  markdown: string;
}

export interface ParsedTaskDetailSections {
  overviewMarkdown: string;
  definitionOfDone: string[];
  constraints: string[];
  additionalSections: TaskDetailSection[];
}

const DEFINITION_OF_DONE_HEADINGS = new Set([
  'definition of done',
  'done when',
  'acceptance criteria',
  'success criteria',
]);

const CONSTRAINT_HEADINGS = new Set([
  'constraints',
  'guardrails',
  'constraints & guardrails',
]);

function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[#:]+/g, '')
    .replace(/\s+/g, ' ');
}

function splitMarkdownSections(markdown: string): TaskDetailSection[] {
  const lines = markdown.split(/\r?\n/);
  const sections: TaskDetailSection[] = [];
  let currentTitle = 'Overview';
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) {
      sections.push({ title: currentTitle, markdown: body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[1].trim();
      continue;
    }
    buffer.push(line);
  }

  flush();
  return sections;
}

function extractListItems(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*+] |\d+\. )\s*(?:\[[ xX]\]\s*)?(.*\S)\s*$/)?.[1]?.trim() || null)
    .filter((value): value is string => Boolean(value));
}

export function isBrowserNavigableUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/');
}

export function parseTaskDetailSections(markdown?: string | null): ParsedTaskDetailSections {
  const sections = splitMarkdownSections(markdown || '');
  const overviewParts: string[] = [];
  const definitionOfDone: string[] = [];
  const constraints: string[] = [];
  const additionalSections: TaskDetailSection[] = [];

  for (const section of sections) {
    const normalized = normalizeHeading(section.title);

    if (DEFINITION_OF_DONE_HEADINGS.has(normalized)) {
      const items = extractListItems(section.markdown);
      definitionOfDone.push(...(items.length > 0 ? items : [section.markdown.trim()].filter(Boolean)));
      continue;
    }

    if (CONSTRAINT_HEADINGS.has(normalized)) {
      const items = extractListItems(section.markdown);
      constraints.push(...(items.length > 0 ? items : [section.markdown.trim()].filter(Boolean)));
      continue;
    }

    if (normalized === 'overview' || overviewParts.length === 0) {
      overviewParts.push(section.markdown);
      continue;
    }

    additionalSections.push(section);
  }

  return {
    overviewMarkdown: overviewParts.join('\n\n').trim(),
    definitionOfDone,
    constraints,
    additionalSections,
  };
}
