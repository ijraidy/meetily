#!/usr/bin/env node
// Minimal Chrome DevTools Protocol client for driving the running Meetily
// desktop app during manual QA. Launch the app with
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// then:
//   node scripts/cdp-eval.mjs eval "document.title"
//   node scripts/cdp-eval.mjs eval-file path/to/snippet.js
//   node scripts/cdp-eval.mjs screenshot out.png
// Expressions are evaluated in the page with top-level await support and
// the JSON-serialized result is printed.
import fs from 'node:fs';

const port = process.env.CDP_PORT || '9222';
const [mode, arg] = process.argv.slice(2);
if (!mode) {
  console.error('usage: cdp-eval.mjs eval <expr> | eval-file <file> | screenshot <out.png>');
  process.exit(2);
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  if (mode === 'screenshot') {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log(`wrote ${arg}`);
  } else {
    const expression = mode === 'eval-file' ? fs.readFileSync(arg, 'utf8') : arg;
    const wrapped = `(async () => { ${expression.includes('return ') ? expression : `return (${expression});`} })()`;
    const result = await send('Runtime.evaluate', {
      expression: wrapped,
      awaitPromise: true,
      returnByValue: true,
      timeout: Number(process.env.CDP_TIMEOUT_MS || 120000),
    });
    if (result.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(result.exceptionDetails, null, 2));
      process.exitCode = 1;
    } else {
      const v = result.result.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
    }
  }
} finally {
  ws.close();
}
