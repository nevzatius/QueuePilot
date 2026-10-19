import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const layer = (filename) => {
  const relative = path.relative(root, filename).replaceAll('\\', '/');
  return /^(apps|packages)\/(web|api|worker|core|domain|contracts)(?:\/|$)/.exec(relative)?.[2];
};
const allowed = {
  web: ['contracts'],
  api: ['core', 'domain', 'contracts'],
  worker: ['core', 'domain', 'contracts'],
  core: ['domain', 'contracts'],
  domain: ['contracts'],
  contracts: [],
};

export default {
  rules: {
    dependencies: {
      meta: {
        type: 'problem',
        schema: [],
        messages: { forbidden: '{{from}} must not import {{target}} (ARCHITECTURE section 3).' },
      },
      create(context) {
        const filename = context.filename;
        const from = layer(filename);
        if (!from) return {};
        const sourceFile = /[\\/]src[\\/]/.test(filename);
        const check = (node, source) => {
          if (typeof source !== 'string') return;
          const target = source.startsWith('.')
            ? layer(path.resolve(path.dirname(filename), source))
            : /^@queuepilot\/([^/]+)/.exec(source)?.[1];
          const crossLayer = target && target !== from && !allowed[from].includes(target);
          // Pure production modules have no external IO dependencies. Crypto is
          // a computation primitive for domain fingerprinting, not an IO adapter.
          const external = !source.startsWith('.') && !target;
          const pureViolation = sourceFile && external && (
            (from === 'contracts' && !/^zod(?:\/|$)/.test(source)) ||
            (from === 'domain' && !['node:crypto', 'crypto'].includes(source))
          );
          if (crossLayer || pureViolation) {
            context.report({ node, messageId: 'forbidden', data: { from, target: target ?? source } });
          }
        };
        return {
          ImportDeclaration: (node) => check(node, node.source.value),
          ExportNamedDeclaration: (node) => { if (node.source) check(node, node.source.value); },
          ExportAllDeclaration: (node) => check(node, node.source.value),
          ImportExpression: (node) => check(node, node.source.value),
          CallExpression: (node) => {
            if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
              check(node, node.arguments[0]?.value);
            }
          },
        };
      },
    },
  },
};
