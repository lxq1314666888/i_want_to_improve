import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.env.API_BASE_URL);
if (base.protocol !== 'https:') throw new Error('Deployed API must use HTTPS');
const token = process.env.READ_TOKEN;
if (!token || token.length < 32) throw new Error('Missing READ_TOKEN');
let available = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const health = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (health.ok && (await health.json()).service === 'workbuddy-ai-news') { available = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 5000));
}
assert.ok(available, 'Deployed /health did not become available');
assert.equal((await fetch(new URL('/api/news', base), { redirect: 'error', signal: AbortSignal.timeout(10000) })).status, 401);
const client = new Client({ name: 'deployment-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) },
  }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_collection_status', 'get_news']);
  const status = await client.callTool({ name: 'get_collection_status', arguments: {} });
  assert.ok(!status.isError, 'Database/status tool failed');
  const news = await client.callTool({ name: 'get_news', arguments: { hours: 24, limit: 5 } });
  assert.ok(!news.isError, 'News tool failed');
  console.log('Cloud smoke passed: public health, private data, MCP discovery and both read-only tools. WorkBuddy/local network acceptance is still required.');
} finally { await client.close(); }
