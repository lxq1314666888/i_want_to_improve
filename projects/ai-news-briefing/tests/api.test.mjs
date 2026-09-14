import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const READ = 'test-read-only-token-never-use-in-production-0001';
const WRITE = 'test-ingest-token-never-use-in-production-0002';
const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let worker, temporary, base, output = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'workbuddy-news-tests-'));
  const migration = spawnSync(executable, ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', temporary], { encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stdout + migration.stderr);
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  worker = spawn(executable, ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', temporary,
    '--var', `READ_TOKEN:${READ}`, '--var', `INGEST_TOKEN:${WRITE}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-30000); });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    if (worker.exitCode !== null) throw new Error(output);
    await delay(500);
  }
  throw new Error(`Worker did not start: ${output}`);
}, { timeout: 120000 });

after(async () => {
  if (worker?.pid) {
    try { process.kill(process.platform === 'win32' ? worker.pid : -worker.pid, 'SIGTERM'); } catch {}
    await delay(500);
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function request(path, { token = READ, body, method = body ? 'POST' : 'GET', headers = {} } = {}) {
  return fetch(`${base}${path}`, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers,
  }, body: body ? JSON.stringify(body) : undefined });
}
function article(url = 'https://example.com/article', overrides = {}) {
  return { id: createHash('sha256').update(url).digest('hex'), url, title: 'Model release', source: 'Fixture',
    published_at: new Date().toISOString(), excerpt: 'A brief excerpt.', ...overrides };
}
function run(sources) {
  return { run_id: randomUUID(), started_at: new Date(Date.now() - 1000).toISOString(), finished_at: new Date().toISOString(), sources };
}

test('health is public but protected endpoints fail closed', async () => {
  assert.equal((await request('/health', { token: null })).status, 200);
  for (const path of ['/api/news', '/api/status', '/mcp']) assert.equal((await request(path, { token: null })).status, 401);
  const status = await (await request('/api/status')).json();
  assert.equal(status.stale, true);
  assert.equal(status.last_success_at, null);
});

test('read and write tokens cannot be used interchangeably', async () => {
  assert.equal((await request('/api/ingest', { body: { items: [article()] } })).status, 401);
  assert.equal((await request('/api/news', { token: WRITE })).status, 401);
});

test('ingestion, deduplication and first-seen timestamps survive retries', async () => {
  const item = article();
  assert.equal((await request('/api/ingest', { token: WRITE, body: { items: [item] } })).status, 200);
  const first = await (await request('/api/news')).json();
  await delay(20);
  assert.equal((await request('/api/ingest', { token: WRITE, body: { items: [{ ...item, title: 'Updated title' }] } })).status, 200);
  const again = await (await request('/api/news')).json();
  assert.equal(again.items.length, 1);
  assert.equal(again.items[0].title, 'Updated title');
  assert.equal(again.items[0].first_seen_at, first.items[0].first_seen_at);
  assert.notEqual(again.items[0].last_seen_at, first.items[0].last_seen_at);
});

test('unknown publication time remains null and does not become collection time', async () => {
  const item = article('https://example.com/undated', { published_at: null });
  assert.equal((await request('/api/ingest', { token: WRITE, body: { items: [item] } })).status, 200);
  const result = await (await request('/api/news?source=Fixture')).json();
  assert.equal(result.items.find(value => value.id === item.id).published_at, null);
});

test('bounded query parameters, item batches and URLs are validated', async () => {
  for (const path of ['/api/news?limit=51', '/api/news?hours=0', '/api/news?limit=oops', '/api/news?extra=1']) {
    assert.equal((await request(path)).status, 400, path);
  }
  for (const items of [[], Array.from({ length: 26 }, () => article()), [article('javascript:alert(1)')], [article('https://user:pass@example.com/path')], [article(undefined, { published_at: '2099-01-01T00:00:00Z' })]]) {
    assert.equal((await request('/api/ingest', { token: WRITE, body: { items } })).status, 400);
  }
  assert.equal((await request('/api/ingest', { token: WRITE, body: { padding: 'x'.repeat(140000) } })).status, 413);
});

test('read queries filter by time and source', async () => {
  const old = article('https://example.com/old', { published_at: new Date(Date.now() - 48 * 3600000).toISOString(), source: 'Old' });
  await request('/api/ingest', { token: WRITE, body: { items: [old] } });
  assert.equal((await (await request('/api/news?source=Old')).json()).items.length, 0);
  assert.equal((await (await request('/api/news?source=Old&hours=72')).json()).items.length, 1);
});

test('partial and all-source failures preserve last successful collection', async () => {
  const partial = run([{ source: 'Fixture', status: 'ok', count: 2 }, { source: 'Unavailable', status: 'error', count: 0, error: 'HTTP 403' }]);
  assert.equal((await request('/api/runs', { token: WRITE, body: partial })).status, 200);
  const success = await (await request('/api/status')).json();
  assert.equal(success.stale, false);
  assert.equal(success.latest_run.failed_sources, 1);
  await delay(20);
  const failure = run([{ source: 'Unavailable', status: 'error', count: 0, error: 'HTTP 403' }]);
  assert.equal((await request('/api/runs', { token: WRITE, body: failure })).status, 200);
  const failed = await (await request('/api/status')).json();
  assert.equal(failed.last_success_at, success.last_success_at);
  assert.equal(failed.latest_run.succeeded_sources, 0);
  assert.equal((await (await request('/api/news')).json()).items.length, 2);
});

test('cross-origin requests and unsupported methods are rejected', async () => {
  assert.equal((await request('/api/news', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await request('/api/news', { method: 'DELETE' })).status, 405);
  assert.equal((await request('/mcp')).status, 405);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/api/news')).headers.get('cache-control'), 'no-store');
});

test('official MCP client initializes, discovers and invokes both read-only tools', async () => {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${READ}` } } });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_collection_status', 'get_news']);
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint));
    const result = await client.callTool({ name: 'get_news', arguments: { hours: 24, limit: 1 } });
    assert.equal(JSON.parse(result.content[0].text).items.length, 1);
    const status = await client.callTool({ name: 'get_collection_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).latest_run.succeeded_sources, 0);
    const filtered = await client.callTool({ name: 'get_news', arguments: { category: 'research', offset: 0, per_source_limit: 2 } });
    assert.ok(!filtered.isError);
    assert.equal(JSON.parse(filtered.content[0].text).category, 'research');
    assert.equal(JSON.parse(filtered.content[0].text).per_source_limit, 2);
    const invalid = await client.callTool({ name: 'get_news', arguments: { limit: 1000 } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); }
});

test('Python collector uploads its actual contract into the Worker and D1', async () => {
  const candidate = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const python = process.env.COLLECTOR_PYTHON ?? (existsSync(candidate) ? candidate : 'python');
  const code = `import sys, os, json, uuid
sys.path.insert(0, 'scripts')
from collect import HTTPClient, upload, iso_date, utc_now
item = json.load(sys.stdin)
now = iso_date(utc_now())
report = {'run_id': str(uuid.uuid4()), 'started_at': now, 'finished_at': now, 'sources': [{'source': 'Python integration', 'status': 'ok', 'count': 1}]}
upload(HTTPClient(interval=0), os.environ['API_BASE_URL'], os.environ['INGEST_TOKEN'], [item], report)
`;
  const child = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 30000,
    input: JSON.stringify(article('https://example.com/python-integration', { source: 'Python integration' })),
    env: { ...process.env, API_BASE_URL: base, INGEST_TOKEN: WRITE } });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = await (await request('/api/news?source=Python%20integration')).json();
  assert.equal(result.items.length, 1);
  assert.equal(result.status.latest_run.succeeded_sources, 1);
});

test('category queries diversify sources and provide bounded pagination', async () => {
  const items = ['OpenAI', 'Google AI', 'TechCrunch'].flatMap(source => Array.from({ length: 8 }, (_, i) =>
    article(`https://example.com/catalog/${source.replaceAll(' ', '-')}/${i}`, { source, published_at: new Date(Date.now() - i * 1000).toISOString() })));
  assert.equal((await request('/api/ingest', { token: WRITE, body: { items } })).status, 200);
  const balanced = await (await request('/api/news?category=official_ai&limit=50')).json();
  assert.equal(balanced.items.length, 6);
  assert.ok(balanced.items.every(item => ['OpenAI', 'Google AI'].includes(item.source)));
  assert.equal(balanced.items.filter(item => item.source === 'OpenAI').length, 3);
  const page1 = await (await request('/api/news?category=official_ai&limit=5&per_source_limit=10')).json();
  assert.equal(page1.has_more, true);
  assert.equal(page1.next_offset, 5);
  const page2 = await (await request(`/api/news?category=official_ai&limit=5&per_source_limit=10&offset=${page1.next_offset}`)).json();
  assert.ok(page2.items.every(item => !page1.items.some(previous => previous.id === item.id)));
  const last = await (await request('/api/news?category=official_ai&limit=5&per_source_limit=10&offset=15')).json();
  assert.equal(last.items.length, 1);
  assert.equal(last.has_more, false);
  assert.equal(last.next_offset, null);
  const single = await (await request('/api/news?source=OpenAI&limit=50')).json();
  assert.equal(single.items.length, 8);
  assert.equal(single.per_source_limit, null);
  for (const path of ['/api/news?category=invalid', '/api/news?offset=-1', '/api/news?offset=1001', '/api/news?per_source_limit=11']) {
    assert.equal((await request(path)).status, 400);
  }
});

test('source discovery includes 29 sources in seven categories with explicit aggregation provenance', async () => {
  const status = await (await request('/api/status')).json();
  assert.equal(status.configured_sources.length, 30);
  assert.equal(new Set(status.configured_sources.map(source => source.category)).size, 7);
  assert.ok(status.configured_sources.some(source => source.name === 'vLLM Releases' && source.type === 'github_releases'));
  const digest = status.configured_sources.find(source => source.type === 'ainews');
  assert.equal(digest.category, 'social');
  assert.equal(digest.provenance.kind, 'aggregated_digest');
  assert.deepEqual(digest.provenance.platforms, ['x', 'reddit']);
});

test('REST and MCP expose social digests without mislabelling original-post dates', async () => {
  const item = article('https://example.com/social-digest', { source: 'AINews via Latent Space', excerpt: 'X via AINews: Model discussion. | Reddit via AINews: Local inference.' });
  assert.equal((await request('/api/ingest', { token: WRITE, body: { items: [item] } })).status, 200);
  const result = await (await request('/api/news?category=social')).json();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, item.url);
  assert.equal(result.items[0].published_at, item.published_at);
  assert.equal(result.items[0].provenance.publication_time, 'digest_publication_not_original_posts');
  assert.match(result.content_notice, /secondhand/);
  const client = new Client({ name: 'social-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${READ}` } } }));
    const toolResult = await client.callTool({ name: 'get_news', arguments: { category: 'social', hours: 24 } });
    assert.ok(!toolResult.isError);
    const digest = JSON.parse(toolResult.content[0].text).items[0];
    assert.deepEqual(digest.provenance, result.items[0].provenance);
    assert.equal(digest.excerpt, item.excerpt);
  } finally { await client.close(); }
});
