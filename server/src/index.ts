import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './api/index.js';
import { getDb, ROOT } from './db/index.js';
import { setMeta } from './trace/service.js';
import { TRUTH_DIR } from './db/index.js';

const app = createApp();
const db = getDb();
const lotCount = (db.prepare(`SELECT COUNT(*) AS n FROM lots`).get() as { n: number }).n;
if (lotCount === 0) {
  console.log('[boot] 数据库为空，请先执行 npm run seed && npm run ingest');
}

const truthFile = path.join(TRUTH_DIR, 'truth.json');
if (fs.existsSync(truthFile)) {
  const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8')) as { complaints: unknown[] };
  if (truth.complaints?.[0]) setMeta('complaint', JSON.stringify(truth.complaints[0]));
}

// 生产构建后由同一进程托管前端静态资源
const webDir = path.join(ROOT, 'dist', 'web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}

const port = Number(process.env.PORT ?? 5174);
app.listen(port, () => {
  console.log(`[trace] API 已启动: http://localhost:${port}/api`);
});
