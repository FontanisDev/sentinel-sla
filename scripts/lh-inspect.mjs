/** Inspect lighthouse JSON: which elements fail the given audits per route. */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const ids = process.argv[3]?.split(',') || [];
const report = JSON.parse(readFileSync(file, 'utf8'));
for (const id of ids) {
  const a = report.audits[id];
  if (!a) { console.log(`no audit ${id}`); continue; }
  console.log(`\n== ${id} [${a.scoreDisplayMode}] score=${a.score} weight-in-cat: see below`);
  for (const item of a.details?.items || []) {
    console.log(JSON.stringify(item.node?.selector || item.node?.path || '', null, 0).slice(0, 200));
    console.log('  html:', String(item.node?.html || '').slice(0, 300));
    console.log('  expl:', String(item.node?.explanation || '').slice(0, 300));
  }
}
// category weights of these audits
const cat = report.categories.accessibility;
for (const ref of cat.auditRefs) {
  if (ids.includes(ref.id)) console.log(`weight(${ref.id})=${ref.weight} group=${ref.group}`);
}
