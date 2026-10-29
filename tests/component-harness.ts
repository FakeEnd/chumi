import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { ACTION_STATUSES, isActionResultUrl } from '../shared/project-work.ts';

export type Element = { type: any; props: Record<string, any>; children: any[] };
const h = (type: any, props: any, ...children: any[]): Element => ({ type, props: props ?? {}, children: children.flat(Infinity) });
export const words = (node: any): string => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : (node.children ?? []).map(words).join('');
export const all = (node: any): Element[] => !node || typeof node !== 'object' ? [] : [node, ...[...(node.children ?? []), node.props?.footer].flatMap(all)];
export const defer = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
export const tick = () => new Promise((r) => setImmediate(r));

// Run the actual component event handlers with small deterministic hook/JSX adapters.
// This exercises draft ownership and request ordering without a browser or live services.
export async function componentHarness(file: string, name: string, props: Record<string, any>, adapters: Record<string, any> = {}) {
  const cells: any[] = [];
  let cursor = 0, dirty = false, tree: Element, effects: Array<() => void> = [];
  const useState = (initial: any) => {
    const index = cursor++;
    if (!cells[index]) cells[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [cells[index].value, (value: any) => { cells[index].value = typeof value === 'function' ? value(cells[index].value) : value; dirty = true; }];
  };
  const useRef = (value: any) => { const index = cursor++; return cells[index] ??= { current: value }; };
  const useEffect = (fn: () => void, deps: any[]) => {
    const index = cursor++, previous = cells[index];
    if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) { cells[index] = deps; effects.push(fn); }
  };
  const source = readFileSync(new URL(`../web/src/components/${file}`, import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const transformed = await transformWithOxc(source, file, { jsx: { runtime: 'classic', pragma: '_testJsx', pragmaFrag: 'Fragment' } });
  const deps = { useState, useRef, useEffect, _testJsx: h, Fragment: 'fragment', t: (s: string) => s, msg: (s: string) => s, fmtDate: String, ACTION_STATUSES, isActionResultUrl, ...adapters };
  const renderComponent = new Function(...Object.keys(deps), `${transformed.code}\nreturn ${name};`)(...Object.values(deps));
  const render = (next = props) => {
    props = next;
    for (let tries = 0; tries < 20; tries++) {
      cursor = 0; dirty = false; effects = []; tree = renderComponent(props);
      for (const effect of effects) effect();
      if (!dirty) return tree;
    }
    throw new Error('Component did not settle');
  };
  const find = (predicate: (element: Element) => boolean) => { const result = all(tree).find(predicate); assert.ok(result, 'Element not found'); return result; };
  render();
  return { render, find, button: (label: string) => find((e) => e.type === 'button' && words(e) === label),
    input: (label: string) => {
      const field = find((e) => e.type === 'label' && words(e).startsWith(label));
      const input = all(field).find((e) => ['input', 'textarea', 'select'].includes(e.type)); assert.ok(input); return input;
    }, text: () => words(tree), elements: () => all(tree) };
}

