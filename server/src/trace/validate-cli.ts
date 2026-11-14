import { validateAgainstTruth } from './validate.js';

const v = validateAgainstTruth();

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

console.log('══ 追溯结果对账（真值 vs 系统） ══');
console.log(`谱系边准确率      ${pct(v.lineage.accuracy)}  （真值 ${v.lineage.total_edges} 条，缺失 ${v.lineage.missing_edges.length}，虚构 ${v.lineage.spurious_edges.length}）`);

console.log('\n── 数量守恒（逐工序） ──');
for (const q of v.quantity) {
  console.log(
    `  ${q.stage.padEnd(6)} 投入 ${String(q.input_qty).padStart(9)}  产出 ${String(q.output_qty).padStart(9)}  ` +
    `报废 ${String(q.scrap_qty).padStart(7)}  偏差 ${q.variance.toFixed(3)}%  ${q.ok ? '✓' : '✗'}`
  );
}

const badBatches = v.batch_level.filter((b) => !b.ok);
console.log(`\n── 批次级产出比对 ──\n  ${v.batch_level.length - badBatches.length}/${v.batch_level.length} 一致`);
for (const b of badBatches.slice(0, 10)) console.log(`  ✗ ${b.lot_no} 真值 ${b.truth_qty} 追溯 ${b.traced_qty} 差 ${b.diff}`);

const ov = (v as unknown as { op_violations: string[] }).op_violations;
console.log(`\n── 工序级守恒违规 ──\n  ${ov.length} 条`);
for (const x of ov.slice(0, 8)) console.log(`  ✗ ${x}`);

console.log('\n── 端到端：原料 → 成品序列号 ──');
for (const e of v.end_to_end) {
  console.log(`  ${e.raw_lot.padEnd(14)} 真值 ${String(e.truth_serials).padStart(4)}  追溯 ${String(e.traced_serials).padStart(4)}  P ${(e.precision * 100).toFixed(1)}%  R ${(e.recall * 100).toFixed(1)}%`);
}

const badAttr = v.attribution.filter((a) => !a.ok);
console.log(`\n── 投诉炉号逐批归因（${v.attribution.length} 个成品批） ──\n  超阈 ${badAttr.length} 个（阈值 2%）`);
for (const a of v.attribution) {
  console.log(`  ${a.lot_no}  真值 ${(a.truth_fraction * 100).toFixed(1)}%  追溯 ${(a.traced_fraction * 100).toFixed(1)}%  ${a.ok ? '✓' : '✗'}`);
}

console.log('\n── 数据质量 ──');
console.log(`  注入问题 ${v.data_quality.injected_issues} 处 · 识别 ${v.data_quality.detected_issues} 条 · 自动纠正 ${v.data_quality.corrections_applied} 条`);

console.log(`\n结论：${v.ok ? '✓ 全部通过' : '✗ 存在偏差，详见上方'}`);
process.exit(v.ok ? 0 : 1);
