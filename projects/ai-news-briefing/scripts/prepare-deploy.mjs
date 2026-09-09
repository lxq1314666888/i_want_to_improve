import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function cloudflareApi(account, token, fetchImpl = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(account ?? '') || !token) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  return async (path, options = {}) => {
    const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) throw new Error(`Cloudflare API returned HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error('Cloudflare API reported failure; check token permissions and resource settings');
    return data.result;
  };
}

export async function prepareDeployment({ api, name, allowReuse, configPath }) {
  if (!/^[a-z][a-z0-9-]{2,49}$/.test(name)) throw new Error('Resource name must be 3–50 lowercase letters, digits or hyphens and start with a letter');
  const workers = await api('workers/scripts');
  const databases = await api('d1/database?per_page=100');
  const existingWorker = workers.some(worker => worker.id === name);
  let database = databases.find(value => value.name === name);
  if ((existingWorker || database) && !allowReuse) {
    throw new Error('A resource with this name already exists. Choose another name, or explicitly allow updates only if both resources belong to this project.');
  }
  const subdomain = await api('workers/subdomain');
  if (!subdomain?.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain)) {
    throw new Error('Configure the account workers.dev subdomain in Cloudflare before deploying');
  }
  if (!database) database = await api('d1/database', { method: 'POST', body: JSON.stringify({ name, primary_location_hint: 'apac' }) });
  if (!/^[a-f0-9-]{36}$/i.test(database.uuid ?? '')) throw new Error('Cloudflare did not return a valid D1 database ID');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.name = name;
  config.d1_databases[0].database_name = name;
  config.d1_databases[0].database_id = database.uuid;
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  return `https://${name}.${subdomain.subdomain}.workers.dev`;
}

async function main() {
  const { CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, READ_TOKEN, INGEST_TOKEN } = process.env;
  if (!READ_TOKEN || !INGEST_TOKEN || READ_TOKEN.length < 32 || INGEST_TOKEN.length < 32 || READ_TOKEN === INGEST_TOKEN) {
    throw new Error('Set distinct READ_TOKEN and INGEST_TOKEN secrets, each at least 32 characters');
  }
  const api = cloudflareApi(CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN);
  const base = await prepareDeployment({ api, name: process.env.RESOURCE_NAME ?? 'workbuddy-ai-news',
    allowReuse: process.env.ALLOW_REUSE === 'true', configPath: 'wrangler.json' });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `api_base_url=${base}\n`);
  console.log(`Prepared configuration. API base after successful deployment: ${base}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
