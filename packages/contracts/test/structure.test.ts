import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = join(import.meta.dirname, '..', 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

/** module name (without extension) -> bare imports and relative imports. */
const graph = new Map<string, { relative: string[]; bare: string[] }>();
for (const file of files) {
  const text = readFileSync(join(srcDir, file), 'utf8');
  const specifiers = [...text.matchAll(/(?:import|export)[^'"]*?from\s+'([^']+)'/g)].map((m) => m[1] as string);
  graph.set(file.replace(/\.ts$/, ''), {
    relative: specifiers.filter((s) => s.startsWith('./')).map((s) => s.replace(/^\.\//, '').replace(/\.js$/, '')),
    bare: specifiers.filter((s) => !s.startsWith('.')),
  });
}

describe('package structure', () => {
  it('depends only on zod (ARCHITECTURE §3)', () => {
    for (const [name, { bare }] of graph) {
      expect(bare.filter((s) => s !== 'zod'), name).toEqual([]);
    }
  });

  it('only imports sibling modules that exist', () => {
    for (const [name, { relative }] of graph) {
      for (const dep of relative) expect(graph.has(dep), `${name} -> ${dep}`).toBe(true);
    }
  });

  it('has no circular imports', () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (done.has(node)) return;
      expect(visiting.has(node), `cycle: ${[...path, node].join(' -> ')}`).toBe(false);
      visiting.add(node);
      for (const dep of graph.get(node)?.relative ?? []) visit(dep, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const node of graph.keys()) visit(node, []);
  });

  it('re-exports every module from the index', () => {
    const index = graph.get('index')?.relative ?? [];
    const others = [...graph.keys()].filter((k) => k !== 'index').sort();
    expect([...index].sort()).toEqual(others);
  });
});
