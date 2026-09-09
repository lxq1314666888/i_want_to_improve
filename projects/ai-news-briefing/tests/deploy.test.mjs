import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflareApi, prepareDeployment } from '../scripts/prepare-deploy.mjs';

const id = '12345678-1234-1234-1234-123456789abc';
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'news-deploy-test-'));
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify({ name: 'original', d1_databases: [{}] }));
  try { await run(configPath); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('deployment refuses existing resources unless explicitly permitted', async () => {
  const api = async path => {
    if (path === 'workers/scripts') return [{ id: 'workbuddy-ai-news' }];
    if (path.startsWith('d1/database?')) return [];
    throw new Error('Must not create or update resources');
  };
  await assert.rejects(prepareDeployment({ api, name: 'workbuddy-ai-news', allowReuse: false }), /already exists/);
  await assert.rejects(prepareDeployment({ api, name: '../../bad' }), /Resource name/);
});

test('deployment resolves actual IDs and subdomain, and requests an APAC hint', async () => {
  await fixture(async configPath => {
    const calls = [];
    const api = async (path, options) => {
      calls.push([path, options]);
      if (path === 'workers/scripts' || path.startsWith('d1/database?')) return [];
      if (path === 'workers/subdomain') return { subdomain: 'verified-account' };
      if (path === 'd1/database') return { uuid: id, name: 'workbuddy-ai-news' };
      throw new Error('Unexpected path');
    };
    const base = await prepareDeployment({ api, name: 'workbuddy-ai-news', allowReuse: false, configPath });
    assert.equal(base, 'https://workbuddy-ai-news.verified-account.workers.dev');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.d1_databases[0].database_id, id);
    assert.deepEqual(JSON.parse(calls.at(-1)[1].body), { name: 'workbuddy-ai-news', primary_location_hint: 'apac' });
  });
});

test('explicit updates reuse D1 rather than creating another database', async () => {
  await fixture(async configPath => {
    const api = async path => {
      if (path === 'workers/scripts') return [{ id: 'workbuddy-ai-news' }];
      if (path.startsWith('d1/database?')) return [{ uuid: id, name: 'workbuddy-ai-news' }];
      if (path === 'workers/subdomain') return { subdomain: 'verified-account' };
      throw new Error('Must not create a second database');
    };
    await prepareDeployment({ api, name: 'workbuddy-ai-news', allowReuse: true, configPath });
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).d1_databases[0].database_id, id);
  });
});

test('missing subdomain aborts before creating resources', async () => {
  const api = async path => path === 'workers/subdomain' ? {} : [];
  await assert.rejects(prepareDeployment({ api, name: 'workbuddy-ai-news', allowReuse: false }), /subdomain/);
});

test('Cloudflare token is scoped to fixed API origin and redirects are refused', async () => {
  let options;
  const api = cloudflareApi('a'.repeat(32), 'private-token', async (url, input) => {
    assert.equal(new URL(url).origin, 'https://api.cloudflare.com');
    options = input;
    return Response.json({ success: true, result: [] });
  });
  assert.deepEqual(await api('workers/scripts'), []);
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, 'Bearer private-token');
  assert.throws(() => cloudflareApi('invalid', 'private-token'));
});
