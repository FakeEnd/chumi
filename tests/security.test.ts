import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMd } from '../web/src/util.ts';

// Everything renderMd may emit. Any other tag, or any other attribute, means model or transcript text became markup.
const ALLOWED: Record<string, string[]> = {
  p: [], br: [], hr: [], strong: [], em: [], del: [], code: ['class'], pre: [], blockquote: [], ul: [], ol: ['start'], li: [],
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], table: [], thead: [], tbody: [], tr: [], th: ['align'], td: ['align'],
  input: ['checked', 'disabled', 'type'], a: ['href', 'target', 'rel'], button: ['class', 'data-t', 'data-t2', 'title'],
};

function assertOnlyAllowedMarkup(md: string): void {
  const html = renderMd(md);
  for (const [, name, attrs] of html.matchAll(/<\/?([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const tag = name.toLowerCase();
    assert.ok(tag in ALLOWED, `<${tag}> rendered from ${JSON.stringify(md)}: ${html}`);
    for (const [, attr] of attrs.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      assert.ok(ALLOWED[tag].includes(attr.toLowerCase()), `${attr} on <${tag}> rendered from ${JSON.stringify(md)}: ${html}`);
    }
  }
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) assert.match(href, /^https?:\/\//, `href ${href} rendered from ${JSON.stringify(md)}`);
}

test('markdown from the model or the transcript cannot become markup, even after an inline <code>, <kbd> or <pre>', () => {
  const payloads = [
    '<code><img/src=x onerror=alert(1)></code>', // regression: marked passed the text after <code> through raw
    'a <kbd><svg onload=alert(1)></kbd> b',
    '<pre><script>alert(1)</script></pre>',
    '<script>x</script><img src=x onerror=alert(2)>',
    '- item <code><iframe src=javascript:alert(1)></code>\n- [ ] task <kbd><img src=x onerror=1></kbd>',
    '# Heading <code><img src=x onerror=1></code>',
    '| a | b |\n|:--|--:|\n| <code><img src=x onerror=1></code> | c |',
    '> quote <kbd><a href="javascript:alert(1)">x</a></kbd>',
    '**<code>**<img src=x onerror=1>**</code>**',
    '<code>`tick` [link](https://x.org) <img src=x onerror=1></code>',
    '<code>[1:23] <img src=x onerror=1> [2:05–2:40]</code>',
    '[<img src=x onerror=1>](https://example.org) [x](javascript:alert(1)) <https://example.org>',
    '![<img src=x onerror=1>](https://example.org/a.png)',
    '<div onclick="x">\n<img src=x onerror=1>\n</div>',
    '```\n<img src=x onerror=1>\n```',
    '&#60;img src=x onerror=1&#62; &lt;img src=x onerror=1&gt;',
  ];
  for (const md of payloads) assertOnlyAllowedMarkup(md);
});

test('markdown keeps its formatting and shows tags as text', () => {
  const html = renderMd('Use **KV cache** & `x<y` here [1:05]. <code>a < b & c</code>');
  assert.match(html, /<strong>KV cache<\/strong> &amp; <code>x&lt;y<\/code>/);
  assert.match(html, /<button class="ref" data-t="65000"/);
  assert.match(html, /&lt;code&gt;a &lt; b &amp; c&lt;\/code&gt;/);
});
