import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = join(import.meta.dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

const files = sources(srcDir).map((path) => ({ name: relative(srcDir, path), text: readFileSync(path, 'utf8') }));

describe('package purity (ARCHITECTURE §3)', () => {
  it('imports only contracts, node:crypto and its own modules', () => {
    for (const { name, text } of files) {
      const bare = [...text.matchAll(/(?:import|export)[^'"]*?from\s+'([^']+)'/g)]
        .map((m) => m[1] as string)
        .filter((s) => !s.startsWith('.'));
      expect(bare.filter((s) => s !== '@queuepilot/contracts' && s !== 'node:crypto'), name).toEqual([]);
    }
  });

  it('never reads the clock or randomness directly', () => {
    const forbidden = /\bDate\.now\(|new Date\(|Math\.random\(|performance\.now\(|process\.|setTimeout\(|randomUUID\(/;
    for (const { name, text } of files) expect(forbidden.test(text), name).toBe(false);
  });
});
