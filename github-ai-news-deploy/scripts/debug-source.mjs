// 调试：单独抓取指定来源，打印原始响应片段与解析结果，判断是网络问题还是解析问题
// 用法：node scripts/debug-source.mjs "Hacker News"  或  node scripts/debug-source.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const collect = await import(path.join(__dirname, "collect.js"));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sources.json"), "utf8"));

const target = process.argv[2];
const sources = target ? cfg.sources.filter((s) => s.name.includes(target)) : cfg.sources;
if (sources.length === 0) {
  console.error(`未找到来源: ${target}`);
  process.exit(1);
}

for (const src of sources) {
  console.log(`\n===== ${src.name} (${src.type}) =====`);
  if (src.type === "github") {
    console.log("repos:", src.repos.join(", "));
    const r = await collect.fetchSource(src);
    console.log("ok:", r.ok, "items:", r.items.length, r.error ? "err: " + r.error : "");
    continue;
  }
  for (const u of src.urls || []) {
    console.log(`-- ${u}`);
    try {
      const { status, type, body } = await collect.httpGet(u);
      console.log(`HTTP ${status} type=${type} len=${body.length}`);
      const text = body.slice(0, 500).replace(/\s+/g, " ").slice(0, 500);
      console.log("head:", text);
      const r = await collect.fetchSource(src);
      console.log("ok:", r.ok, "items:", r.items.length, r.error ? "err: " + r.error : "");
      if (r.items.length > 0) {
        console.log("first:", JSON.stringify(r.items[0]).slice(0, 300));
      }
    } catch (e) {
      console.log("ERR:", e && e.message ? e.message : e);
    }
  }
}
