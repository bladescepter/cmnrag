/**
 * 以 Excel 为准对齐本地 D1 schedules 表。
 *   - 清空 schedules 所有 user_id 的数据 (清除历史脏数据)
 *   - 按 Excel (采访中心综合表格_2026值班.xlsx / sheet 2026值班) 重新导入
 *   - publish_date 由值班日的下一个见报日推算
 *   - 双人值班单元格原样存入字符串 (不拆分)
 *
 * 用法: node scripts/align_to_excel.js [--dry-run]
 *   --dry-run  只生成 SQL 并预览, 不执行
 */
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
const USER_ID = 1;
const EXCEL_FILE = '采访中心综合表格_2026值班.xlsx';
const SHEET = '2026值班';

// ── 1. 读 Excel ──
const wb = XLSX.readFile(EXCEL_FILE);
const ws = wb.Sheets[SHEET];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

function serialToDate(serial) {
  const d = new Date(Math.floor(serial - 25569) * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}
function parseDate(cell) {
  if (typeof cell === 'number') return serialToDate(cell);
  if (typeof cell === 'string') return cell.trim().replace(/\//g, '-');
  return '';
}

// ── 2. 从 D1 获取节假日 ──
let holidays = [];
try {
  const out = execSync(
    `npx wrangler d1 execute paiban --local --command="SELECT date FROM calendar WHERE type='holiday' ORDER BY date" --json`,
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  const lines = out.split('\n').filter(l => l.trim());
  const ji = lines.findIndex(l => l.trim().startsWith('['));
  if (ji >= 0) {
    const parsed = JSON.parse(lines.slice(ji).join('\n'));
    if (parsed[0]?.results) holidays = parsed[0].results.map(r => r.date);
  }
} catch (e) {
  console.warn('无法获取节假日, 按周一至周五见报处理:', e.message);
}
const holidaySet = new Set(holidays);
console.log(`节假日: ${holidays.length} 个`);

function dayOfWeek(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); }
function isPublish(s) {
  const w = dayOfWeek(s);
  if (w === 0 || w === 6) return false;
  if (holidaySet.has(s)) return false;
  return true;
}
function weekdayName(s) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayOfWeek(s)];
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function nextPublishDate(dutyDate) {
  let cur = addDays(dutyDate, 1);
  for (let i = 0; i < 30; i++) {
    if (isPublish(cur)) return cur;
    cur = addDays(cur, 1);
  }
  return cur;
}

// ── 3. 解析 Excel 行 ──
const inserts = [];
const seenDates = new Set();
const dups = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const d = parseDate(r[0]);
  if (!d) continue;
  const f1 = r[2] == null ? '' : String(r[2]).trim();
  const f2 = r[3] == null ? '' : String(r[3]).trim();
  const remark = r[4] == null ? '' : String(r[4]).trim().replace(/\r?\n/g, '; ');
  if (!f1 && !f2 && !remark) continue; // 空行跳过
  if (seenDates.has(d)) { dups.push(d); continue; }
  seenDates.add(d);
  inserts.push({
    dutyDate: d,
    publishDate: nextPublishDate(d),
    weekday: weekdayName(d),
    firstEditor: f1,
    secondEditor: f2,
    remark,
  });
}

console.log(`Excel 有效记录: ${inserts.length} 条`);
if (dups.length) console.log(`⚠ 重复日期(已跳过): ${dups.join(', ')}`);

// ── 4. 生成 SQL ──
function esc(s) { return s ? `'${s.replace(/'/g, "''")}'` : 'NULL'; }
const sqlLines = [];
sqlLines.push(`DELETE FROM schedules;`); // 清空所有 user_id 的脏数据
for (const r of inserts) {
  sqlLines.push(
    `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark) ` +
    `VALUES (${USER_ID}, '${r.dutyDate}', '${r.publishDate}', '${r.weekday}', ${esc(r.firstEditor)}, ${esc(r.secondEditor)}, ${esc(r.remark)});`
  );
}
const fullSql = sqlLines.join('\n');
fs.writeFileSync('scripts/_align.sql', fullSql, 'utf8');
console.log(`SQL 已写入 scripts/_align.sql (${sqlLines.length} 行)`);

// 双人记录提示
const multi = inserts.filter(r => /[，,、/]/.test(r.firstEditor) || /[，,、/]/.test(r.secondEditor));
if (multi.length) {
  console.log(`\n双人值班(原样存入字符串, ${multi.length} 条):`);
  for (const m of multi) console.log(`  ${m.dutyDate} ${m.weekday} 一:${m.firstEditor || '-'} 二:${m.secondEditor || '-'}`);
}

if (DRY_RUN) {
  console.log('\n=== 预览前 12 行 ===');
  console.log(fullSql.split('\n').slice(0, 12).join('\n'));
  console.log('\n=== 末尾 3 行 ===');
  console.log(fullSql.split('\n').slice(-3).join('\n'));
  console.log('\n(dry-run, 未执行。去掉 --dry-run 执行对齐)');
} else {
  console.log('\n执行对齐...');
  try {
    const result = execSync(
      `npx wrangler d1 execute paiban --local --file="scripts/_align.sql" 2>&1`,
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    console.log(result.split('\n').filter(l => l.includes('Executed') || l.includes('error') || l.includes('✓')).join('\n') || '✓ 执行完成');
  } catch (e) {
    console.error('执行失败:', e.message);
    process.exit(1);
  }
  console.log('✓ 对齐完成');
}
