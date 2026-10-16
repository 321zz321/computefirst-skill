#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// SKILL.md is the only source of example requests and expected results.
// Parse a small curl subset; never evaluate shell commands from documentation.
const origin = 'https://computefirst.net';
const skillUrl = new URL('../skills/computefirst/SKILL.md', import.meta.url);
const timeoutMs = 20_000;

function parseCurl(source) {
  const command = source.replace(/\\\r?\n\s*/g, ' ').trim();
  const tokens = [];
  let rest = command;
  while (rest.length) {
    const token = /^(?:'([^']*)'|([^\s'"`;$|&<>]+))(?:\s+|$)/.exec(rest);
    assert(token, `Unsupported curl syntax near: ${rest.slice(0, 80)}`);
    tokens.push(token[1] ?? token[2]);
    rest = rest.slice(token[0].length);
  }
  assert.equal(tokens.shift(), 'curl');
  const request = { method: 'GET', headers: {} };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (['-sS', '--fail-with-body'].includes(token)) continue;
    if (token === '-X') {
      request.method = tokens[++i];
    } else if (token === '-H') {
      const header = tokens[++i];
      assert(header?.includes(':'), 'Missing header value');
      const colon = header.indexOf(':');
      const name = header.slice(0, colon).trim();
      assert.equal(name.toLowerCase(), 'content-type', 'Unexpected example header');
      request.headers[name] = header.slice(colon + 1).trim();
    } else if (token === '--data-raw') {
      request.body = tokens[++i];
      assert.equal(typeof request.body, 'string', 'Missing input body');
      JSON.parse(request.body);
    } else if (token.startsWith('https://')) {
      assert(!request.url, 'Multiple URLs in one example');
      request.url = token;
    } else {
      throw new Error(`Unsupported curl token: ${token}`);
    }
  }
  const url = new URL(request.url);
  assert.equal(url.origin, origin, 'Examples must use the live ComputeFirst origin');
  assert(!url.username && !url.password && !url.hash, 'Unexpected URL credentials/fragment');
  assert(['GET', 'POST'].includes(request.method), 'Unexpected example method');
  if (request.method === 'GET') assert.equal(request.body, undefined);
  return request;
}

async function http(path, options = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin);
  const response = await fetch(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await response.text();
  assert(response.ok, `${options.method ?? 'GET'} ${url.pathname}: HTTP ${response.status}: ${raw}`);
  return { response, raw };
}

async function json(path, options) {
  const { raw } = await http(path, options);
  const payload = JSON.parse(raw);
  assert(!payload.error, `API error: ${JSON.stringify(payload.error)}`);
  return payload;
}

function checkContract(contract, id, version) {
  assert.equal(contract.id, id);
  assert.equal(contract.version, version);
  for (const key of ['supported_operations', 'unsupported_operations', 'semantics']) {
    assert(Array.isArray(contract[key]), `Missing contract ${key}: ${id}`);
  }
  for (const key of ['input_schema', 'output_schema', 'limits']) {
    assert(contract[key] && typeof contract[key] === 'object', `Missing contract ${key}: ${id}`);
  }
  assert.equal(contract.execute_url, `/v1/tools/${id}/versions/${version}/execute`);
}

async function rpc(endpoint, message, version) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (version) headers['MCP-Protocol-Version'] = version;
  const { response, raw } = await http(endpoint, {
    method: 'POST', headers, body: JSON.stringify(message)
  });
  if (message.id === undefined) {
    assert.equal(response.status, 202, 'MCP notification was not accepted');
    assert.equal(raw, '', 'Unexpected notification body');
    return;
  }
  let payload;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = raw.replaceAll('\r\n', '\n').split('\n\n')
      .map(event => event.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n'))
      .filter(Boolean).map(data => JSON.parse(data));
    payload = events.find(event => event.id === message.id);
  } else {
    payload = JSON.parse(raw);
  }
  assert(payload, `Missing JSON-RPC response to ${message.method}`);
  assert.equal(payload.jsonrpc, '2.0');
  assert.equal(payload.id, message.id);
  assert(!payload.error, `JSON-RPC error: ${JSON.stringify(payload.error)}`);
  assert(payload.result, 'Missing MCP result');
  assert(!payload.result.isError, `MCP tool error: ${JSON.stringify(payload.result.content)}`);
  return payload.result;
}

function toolPayload(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', 'Missing MCP JSON text');
  return JSON.parse(text);
}

async function checkMcp(endpoint, expectedCount, decimal) {
  const initialized = await rpc(endpoint, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-11-25', capabilities: {},
      clientInfo: { name: 'computefirst-skill-verification', version: '1.0.0' }
    }
  });
  const version = initialized.protocolVersion;
  assert.equal(version, '2025-11-25', 'Negotiated protocol changed; review the raw MCP reference');
  await rpc(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, version);
  const listed = await rpc(endpoint, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, version);
  assert.equal(listed.tools?.length, expectedCount, `${endpoint} tool count drift`);
  assert.equal(listed.nextCursor, undefined, 'Unexpected MCP pagination; review documented counts');
  const names = new Set(listed.tools.map(tool => tool.name));
  let nextId = 3;
  const call = async (name, args) => toolPayload(await rpc(endpoint, {
    jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args }
  }, version));
  if (endpoint === '/mcp') {
    for (const name of ['search', 'describe', 'execute']) assert(names.has(name));
    const search = await call('search', { query: decimal.id, limit: 1 });
    assert.equal(search.results[0]?.id, decimal.id);
    checkContract(await call('describe', { id: decimal.id, version: decimal.version }), decimal.id, decimal.version);
    const output = await call('execute', {
      id: decimal.id, version: decimal.version, input: JSON.parse(decimal.request.body)
    });
    assert.equal(JSON.stringify(output.result), decimal.expected, 'MCP execute result differs');
  } else {
    assert(names.has('decimal_add'));
    for (const name of ['search', 'describe', 'execute']) assert(!names.has(name));
    const output = await call('decimal_add', JSON.parse(decimal.request.body));
    assert.equal(JSON.stringify(output.result), decimal.expected, 'Curated MCP result differs');
  }
  console.log(`PASS ${endpoint}: ${expectedCount} tools; initialize, list, and computation`);
}

async function main() {
  const skill = await readFile(skillUrl, 'utf8');
  assert.match(skill, /^---\r?\nname: computefirst\r?\ndescription: .+\r?\n---/);
  const count = Number(/\*\*(\d+) tools\*\*/.exec(skill)?.[1]);
  assert(Number.isInteger(count) && count > 0, 'Missing documented catalog count');
  const blocks = [...skill.matchAll(/^```(\w*)\r?\n([\s\S]*?)^```\s*$/gm)]
    .map(match => ({ lang: match[1], body: match[2].trim() }));
  const examples = [];
  const discovery = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.lang !== 'sh' || !block.body.startsWith('curl ')) continue;
    const request = parseCurl(block.body);
    if (request.method === 'GET') {
      discovery.push(request);
      continue;
    }
    const path = new URL(request.url).pathname;
    const match = /^\/v1\/tools\/([a-z0-9_-]+)\/versions\/([a-zA-Z0-9.+_-]+)\/execute$/.exec(path);
    assert(match, `Unexpected execution path: ${path}`);
    assert.equal(blocks[i + 1]?.lang, 'json', `Missing expected result after ${path}`);
    const expected = blocks[i + 1].body;
    assert.equal(JSON.stringify(JSON.parse(expected)), expected, 'Expected outputs must be verbatim compact JSON');
    examples.push({ id: match[1], version: match[2], request, expected });
  }
  assert.equal(examples.length, 6, 'Expected all six worked examples in SKILL.md');
  assert.equal(new Set(examples.map(example => example.id)).size, 6, 'Duplicate example tool');
  assert.equal(discovery.length, 2, 'Expected both documented discovery requests');

  const llms = (await http('/llms.txt')).raw;
  assert(llms.includes(`${count} tools`), 'llms.txt count drift');
  const metadata = await json('/.well-known/mcp.json');
  assert.equal(metadata.catalog?.toolCount, count, 'Discovery metadata count drift');
  assert.equal(metadata.authentication?.required, false);
  assert.equal(metadata.transport?.endpoint, `${origin}/mcp`);
  assert.equal((await json('/v1/stats')).tools, count, 'Stats count drift');
  const api = await json('/openapi.json');
  for (const path of ['/v1/tools/search', '/v1/tools/{id}/versions/{version}', '/v1/tools/{id}/versions/{version}/execute', '/mcp']) {
    assert(api.paths?.[path], `OpenAPI missing ${path}`);
  }
  for (const request of discovery) {
    const url = new URL(request.url);
    const payload = await json(request.url);
    if (url.pathname === '/v1/tools/search') {
      assert.equal(payload.results?.[0]?.id, 'decimal-add');
      assert.equal(payload.results[0].version, '1.0.0');
    } else {
      checkContract(payload, 'decimal-add', '1.0.0');
    }
  }
  console.log(`PASS discovery: ${count} catalog tools; metadata, OpenAPI, search, contract`);

  for (const example of examples) {
    const { id, version, request, expected } = example;
    const search = await json(`/v1/tools/search?q=${encodeURIComponent(id)}&limit=3`);
    const selected = search.results?.find(tool => tool.id === id && tool.version === version);
    assert(selected, `Example tool not discoverable: ${id}@${version}`);
    assert.equal(selected.execute_url, new URL(request.url).pathname);
    checkContract(await json(selected.detail_url), id, version);
    const payload = await json(request.url, {
      method: request.method, headers: request.headers, body: request.body
    });
    assert(Object.hasOwn(payload, 'result'), `Missing result: ${id}`);
    assert.equal(JSON.stringify(payload.result), expected, `${id}@${version}: result differs from SKILL.md`);
    console.log(`PASS ${id}@${version}: complete result matches`);
  }

  const decimal = examples.find(example => example.id === 'decimal-add');
  assert(decimal, 'Missing decimal example for MCP parity check');
  await checkMcp('/mcp', 15, decimal);
  await checkMcp('/mcp/chatgpt', 40, decimal);
  console.log(`PASS verify-examples: ${examples.length}/${examples.length} worked examples; ${count} catalog tools; both MCP endpoints`);
}

main().catch(error => {
  console.error(`FAIL verify-examples: ${error.message}`);
  process.exitCode = 1;
});
