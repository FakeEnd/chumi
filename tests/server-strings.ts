import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'rolldown/utils';

const ROOT = join(import.meta.dirname, '..');
const UNKNOWN = '⟦value⟧';
type Node = any;
export interface ServerString { file: string; source: string; samples: string[]; native: boolean }

// These entry points report to mobile clients, MCP clients or the startup terminal, never the web.
const NON_WEB = /^(?:mobile\/|mcp\/|mobile-config\.ts$|shutdown\.ts$|instance-lock\.ts$)/;
const proseFields = new Set(['error', 'message', 'setupHint', 'note', 'summary', 'detail', 'reason', 'billingLabel']);
const field = (n: Node) => n?.name ?? n?.value;
const children = (n: Node): Node[] => Object.values(n).flatMap((v) => Array.isArray(v) ? v : [v]).filter((v: any) => v && typeof v.type === 'string');

/** Follow message expressions, including local fragments, conditional branches and setup hints. No server code executes. */
export function serverStrings(): ServerString[] {
  const result: ServerString[] = [];
  for (const relative of globSync('**/*.ts', { cwd: join(ROOT, 'server') })) {
    if (NON_WEB.test(relative)) continue;
    const file = 'server/' + relative;
    const source = readFileSync(join(ROOT, file), 'utf8');
    const program = parseSync(file, source).program;
    const parents = new Map<Node, Node>();
    const nodes: Node[] = [];
    const visit = (n: Node) => { nodes.push(n); for (const c of children(n)) { parents.set(c, n); visit(c); } };
    visit(program);
    const scopes = (n: Node): Node[] => { const out = []; for (let p = n; p; p = parents.get(p)) if (['Program', 'BlockStatement', 'ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(p.type)) out.push(p); return out; };
    const bindings = nodes.filter((n) => n.type === 'VariableDeclarator' && n.id.type === 'Identifier');
    const hints = nodes.filter((n) => n.type === 'Property' && field(n.key) === 'setupHint').map((n) => n.value);
    const samples = (n: Node, seen = new Set<Node>()): string[] => {
      if (!n || seen.has(n)) return [UNKNOWN];
      seen = new Set([...seen, n]);
      const sub = (v: Node) => samples(v, seen);
      const unique = (v: string[]) => [...new Set(v)];
      if (n.type === 'Literal') return typeof n.value === 'string' ? [n.value] : [UNKNOWN];
      if (n.type === 'TemplateLiteral') {
        let parts = [n.quasis[0].value.cooked];
        for (let i = 0; i < n.expressions.length; i++) parts = parts.flatMap((p: string) => sub(n.expressions[i]).map((v) => p + v + n.quasis[i + 1].value.cooked));
        return unique(parts);
      }
      if (n.type === 'ConditionalExpression') return unique([...sub(n.consequent), ...sub(n.alternate)]);
      if (n.type === 'LogicalExpression') return unique([...sub(n.left), ...sub(n.right)]);
      if (n.type === 'BinaryExpression' && n.operator === '+') return sub(n.left).flatMap((l) => sub(n.right).map((r) => l + r));
      if (n.type === 'Identifier') {
        for (const scope of scopes(n)) {
          const binding = bindings.find((b) => b.id.name === n.name && scopes(b)[0] === scope);
          if (binding) return n.name === 'detail' ? unique([...sub(binding.init), '']) : sub(binding.init);
        }
      }
      if (n.type === 'MemberExpression' && field(n.property) === 'setupHint') return unique(hints.flatMap(sub));
      if (['TSAsExpression', 'TSNonNullExpression', 'ChainExpression'].includes(n.type)) return sub(n.expression);
      if (n.type === 'CallExpression') {
        if (n.callee.name === 'String') return sub(n.arguments[0]);
        const method = field(n.callee.property);
        if (method === 'join') return sub(n.callee.object);
        if (method === 'map' && n.arguments[0]?.type === 'ArrowFunctionExpression') return sub(n.arguments[0].body);
        if (method === 'trim') return sub(n.callee.object).map((s) => s.trim());
        if (method === 'replace' && n.arguments.every((a: Node) => a.type === 'Literal' && typeof a.value === 'string')) return sub(n.callee.object).map((s) => s.replace(n.arguments[0].value, n.arguments[1].value));
      }
      return [UNKNOWN];
    };
    const add = (n: Node, native = false) => {
      if (!n) return;
      const values = samples(n).filter((s) => s.trim() && s.replaceAll(UNKNOWN, '').trim());
      if (values.length) result.push({ file, source: source.slice(n.start, n.end), samples: [...new Set(values)], native });
    };
    for (const n of nodes) {
      if (n.type === 'NewExpression' && /^(Error|HttpError|ProviderError|HandoffError|ProjectWorkError)$/.test(n.callee.name)) add(n.arguments[n.callee.name === 'Error' ? 0 : 1]);
      if (n.type === 'Property' && proseFields.has(field(n.key))) add(n.value);
      // Message locals also cover status/error adapters that forward an argument unchanged.
      if (n.type === 'VariableDeclarator' && /^(message|reason|errMsg|timedOut|billingViolation)$/.test(n.id.name)) add(n.init);
      if (n.type === 'AssignmentExpression' && /^(message|timedOut|billingViolation)$/.test(n.left.name)) add(n.right);
      if (n.type === 'VariableDeclarator' && n.id.name === 'SOURCE_NAMES') for (const property of n.init.properties) add(property.value, true);
      if (n.type === 'VariableDeclarator' && n.id.name === 'minutes' && file === 'server/ai/claude-cli.ts') add(n.init.body);
      if (n.type === 'ReturnStatement' && scopes(n).some((scope) => scope.id?.name === 'windowLabel')) add(n.argument);
      if (n.type !== 'CallExpression') continue;
      const name = n.callee.name ?? field(n.callee.property);
      if (name === 'macNotify') add(n.arguments[0], true);
      if (name === 'localize') add(n.arguments[1], true);
      if (n.callee.object?.type === 'ThisExpression' && ['set', 'setState', 'setRemote'].includes(name)) add(n.arguments[1]);
      if (name === 'emit' && n.arguments[0]?.value === 'notice') add(n.arguments[3]);
      if (name === 'emit' && n.arguments[0]?.value === 'error') add(n.arguments[1]);
      if (name === 'emit' && n.arguments[0]?.value === 'exit') add(n.arguments[2]);
      if (name === 'notice') add(n.arguments[n.arguments.length >= 3 ? 2 : 0]);
      if (name === 'expire' || (file === 'server/ai/codex.ts' && name === 'push' && n.callee.object?.name === 'parts')) add(n.arguments[0]);
      if (name === 'badResponse') add(n.arguments[0]);
    }
  }
  // The macOS helper sends these status strings to HotkeyAgent and then the web.
  const file = 'native/hotkey/ChumiHotkey.swift';
  for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(/"message": "((?:\\.|[^"\\])*)"/g)) {
    const text = match[1].replace(/\\\([^)]*\)/g, UNKNOWN);
    result.push({ file, source: match[0], samples: [JSON.parse('"' + text + '"')], native: false });
  }
  return result;
}
