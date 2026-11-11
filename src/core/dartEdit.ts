import { Candidate } from './hardcoded';
import { Accessor } from './project';

export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Expression that reads [key], called with the placeholders' expressions. */
export function callExpression(accessor: Accessor, key: string, candidate: Candidate): string {
  const getter = accessor.template.replace('{key}', key);
  if (!candidate.placeholders.length) return getter;
  return `${getter}(${candidate.placeholders.map((p) => p.expr).join(', ')})`;
}

/**
 * Edits that swap the literal for [expression]: the literal itself, the `const`
 * that would no longer compile, and any import the expression needs. Offsets
 * are into the original [src]; apply them from the end.
 */
export function extractionEdits(
  src: string,
  candidate: Candidate,
  expression: string,
  imports: string[],
): TextEdit[] {
  const edits: TextEdit[] = [{ start: candidate.start, end: candidate.end, text: expression }];
  for (const at of candidate.constStarts) {
    const after = src.slice(at + 'const'.length).match(/^\s*/)?.[0].length ?? 0;
    edits.push({ start: at, end: at + 'const'.length + after, text: '' });
  }
  const missing = imports.filter((uri) => !importsUri(src, uri));
  if (missing.length) {
    const at = importInsertOffset(src);
    const lines = missing.map((uri) => `import '${uri}';\n`).join('');
    const needsBlank = at > 0 && !/\n\s*$/.test(src.slice(0, at));
    edits.push({ start: at, end: at, text: needsBlank ? `\n${lines}` : lines });
  }
  return edits.sort((a, b) => b.start - a.start);
}

export function applyEdits(src: string, edits: TextEdit[]): string {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

function importsUri(src: string, uri: string): boolean {
  const esc = uri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*import\\s+['"]${esc}['"]`, 'm').test(src);
}

/** After the last import, export or library directive, else at the top. */
function importInsertOffset(src: string): number {
  // Directives come before any declaration, so a line scan is enough.
  const directive = /^(?:import|export|library)\b[^;]*;[^\n]*(?:\n|$)/gm;
  let at = 0;
  for (let m = directive.exec(src); m; m = directive.exec(src)) at = m.index + m[0].length;
  return at;
}
