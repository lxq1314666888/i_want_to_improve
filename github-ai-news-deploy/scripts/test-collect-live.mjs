// 真实网络采集演练：本地 mock 接收端 + 真实运行 collect.js（验证来源可达性、解析、去重、写入链路）
// 运行：node scripts/test-collect-live.mjs   （需联网；部分海外源可能超时，属预期）
import http from "http";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let received = 0;
let inserted = 0;
let logBody = null;
let batches = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/api/news/batch" && req.method === "POST") {
      const j = JSON.parse(body);
      received += (j.items || []).length;
      inserted += (j.items || []).length;
      batches++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, received: j.items.length, inserted: j.items.length }));
    } else if (req.url === "/api/collection/log" && req.method === "POST") {
      logBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`mock server listening on ${base}`);

  const child = spawn(
    process.execPath,
    [path.join(__dirname, "collect.js")],
    {
      env: {
        ...process.env,
        API_BASE_URL: base,
        INGEST_TOKEN: "test-ingest",
        NEWS_HOURS: "24",
        COLLECT_CONCURRENCY: "5",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout.on("data", (d) => process.stdout.write(d));
  child.stderr.on("data", (d) => process.stderr.write(d));
  child.on("exit", (code) => {
    server.close();
    console.log(`\n[mock] batches=${batches} received=${received} inserted=${inserted}`);
    console.log(`[mock] collection log: ${logBody ? JSON.stringify({ status: logBody.status, sources_total: logBody.sources_total, sources_ok: logBody.sources_ok, sources_failed: logBody.sources_failed, items_added: logBody.items_added, failed: logBody.details && logBody.details.failed_sources && logBody.details.failed_sources.length }) : "NONE"}`);
    process.exit(code === 0 ? 0 : 1);
  });
});
