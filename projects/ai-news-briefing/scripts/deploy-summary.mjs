import { appendFile } from 'node:fs/promises';
const base = new URL(process.env.API_BASE_URL);
if (base.protocol !== 'https:') throw new Error('Expected HTTPS API base');
const summary = `## AI news API deployed\n\n- Health: ${new URL('/health', base)}\n- MCP: ${new URL('/mcp', base)}\n- Set repository variable \`API_BASE_URL\` to \`${base.origin}\`.\n- After the initial collection succeeds, set \`AI_NEWS_ENABLED\` to \`true\` to enable daily collection.\n- Keep \`READ_TOKEN\` only in WorkBuddy's local MCP configuration. Never give WorkBuddy the ingestion or Cloudflare administration token.\n- Verify WorkBuddy from your own computer before relying on automation.\n- The following initial collection step can still fail independently; inspect its source status.\n`;
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
else console.log(summary);
