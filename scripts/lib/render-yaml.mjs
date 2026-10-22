// A deliberately small YAML reader for render.yaml, so the preflight and its tests need no dependency.
// It understands exactly the subset that file uses: comments, block mappings, block sequences (of mappings or
// scalars) and plain, single- or double-quoted scalars. Anything else (tabs, flow collections, anchors, tags,
// block scalars, multiple documents, duplicate keys, odd indentation) is an error, never a guess, so a file this
// reader accepts means the same thing to any YAML parser. An unquoted integer becomes a number on purpose:
// Render wants string env values, and the preflight reports numbers.

export class BlueprintSyntaxError extends Error {}

const fail = (line, reason) => { throw new BlueprintSyntaxError(`render.yaml line ${line}: ${reason}`); };

function scalar(text, line) {
  if (text === '') return null;
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.lastIndexOf(quote);
    if (end === 0 || text.slice(end + 1).replace(/\s+#.*$/, '').trim() !== '') fail(line, 'unterminated or trailing text after a quoted value');
    const inner = text.slice(1, end);
    if (quote === '"' && /\\(?!["\\])/.test(inner)) fail(line, 'escape sequences are not supported');
    return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replaceAll("''", "'");
  }
  const plain = text.replace(/\s+#.*$/, '').trimEnd();
  if (/^[[{&*!|>%@`]/.test(plain)) fail(line, 'flow collections, anchors, tags and block scalars are not supported');
  if (plain === 'true') return true;
  if (plain === 'false') return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(plain)) return Number(plain);
  return plain;
}

/** Parses the text into plain objects, arrays and scalars. Throws BlueprintSyntaxError. */
export function parseBlueprint(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.includes('\t')) fail(index + 1, 'tabs are not allowed');
    if (raw.trim() === '' || raw.trim().startsWith('#')) return;
    if (/^(---|\.\.\.)/.test(raw)) fail(index + 1, 'document markers are not supported');
    lines.push({ no: index + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() });
  });
  let position = 0;

  function parseBlock(indent) {
    const first = lines[position];
    if (!first || first.indent !== indent) fail(first?.no ?? 0, 'unexpected indentation');
    return first.text.startsWith('- ') || first.text === '-' ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent, seed = undefined) {
    const result = seed ?? {};
    while (position < lines.length && lines[position].indent === indent && !lines[position].text.startsWith('- ')) {
      const { no, text } = lines[position];
      const match = /^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/.exec(text);
      if (!match) fail(no, 'expected "key: value"');
      const [, key, rest = ''] = match;
      if (Object.hasOwn(result, key)) fail(no, `duplicate key ${key}`);
      position += 1;
      if (rest === '') {
        const next = lines[position];
        // A key with nothing after it is a nested block when the next line is indented more, or a sequence at the same indent.
        result[key] = next && (next.indent > indent || (next.indent === indent && next.text.startsWith('- '))) ? parseBlock(next.indent) : null;
      } else result[key] = scalar(rest, no);
    }
    if (position < lines.length && lines[position].indent > indent) fail(lines[position].no, 'unexpected indentation');
    return result;
  }

  function parseSequence(indent) {
    const result = [];
    while (position < lines.length && lines[position].indent === indent && (lines[position].text.startsWith('- ') || lines[position].text === '-')) {
      const { no, text } = lines[position];
      const body = text === '-' ? '' : text.slice(2).trimStart();
      if (body === '') fail(no, 'empty sequence entries are not supported');
      if (/^[A-Za-z_][\w.-]*:(\s|$)/.test(body)) {
        // "- key: value": the entry is a mapping whose keys line up with the first one.
        const keyIndent = indent + (text.length - body.length);
        lines[position] = { no, indent: keyIndent, text: body };
        result.push(parseMapping(keyIndent));
      } else {
        result.push(scalar(body, no));
        position += 1;
      }
    }
    if (position < lines.length && lines[position].indent > indent) fail(lines[position].no, 'unexpected indentation');
    return result;
  }

  if (lines.length === 0) return {};
  const value = parseBlock(lines[0].indent);
  if (position < lines.length) fail(lines[position].no, 'unexpected content');
  return value;
}
