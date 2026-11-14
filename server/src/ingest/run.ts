import { resetDb, getDb } from '../db/index.js';
import { runIngest } from './pipeline.js';
import { persistIngest } from './persist.js';
import { markSuspectLots } from '../quality/suspect.js';
import { setMeta } from '../trace/service.js';
import fs from 'node:fs';
import path from 'node:path';
import { TRUTH_DIR } from '../db/index.js';

const t0 = Date.now();
resetDb();
const { result, runId } = runIngest();
persistIngest(result, runId);
const suspect = markSuspectLots();
// 客户投诉单（演示用：来自真值文件）
const truthFile = path.join(TRUTH_DIR, 'truth.json');
if (fs.existsSync(truthFile)) {
  const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8')) as { complaints: unknown[] };
  if (truth.complaints?.[0]) setMeta('complaint', JSON.stringify(truth.complaints[0]));
}

console.log(`接入完成 run=${runId} 用时 ${Date.now() - t0}ms`);
console.table(result.counts);
console.log(`数据质量问题 ${result.issues.length} 条，可疑批次 ${suspect.lots.length} 个`);
const db = getDb();
const sev = db.prepare(`SELECT severity, COUNT(*) AS n FROM issues GROUP BY severity`).all();
console.table(sev);
console.log('可疑批次明细（前 8）:');
const suspects = db.prepare(`SELECT lot_no, material_name, suspect_reason FROM lots WHERE suspect=1 ORDER BY lot_no LIMIT 8`).all();
console.table(suspects);
