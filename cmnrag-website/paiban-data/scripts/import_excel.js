/**
 * 从采访中心综合表格.xlsx 导入排班数据到本地 D1
 *
 * 用法: node scripts/import_excel.js [--dry-run]
 *   --dry-run  只打印 SQL，不执行
 */
const XLSX = require('xlsx');
const { execSync } = require('child_process');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');
const USER_ID = 1;
const YEAR = 2026;

// ── 1. 读 Excel ──
const wb = XLSX.readFile('采访中心综合表格.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

function serialToDate(serial) {
  const utc_days = Math.floor(serial - 25569);
  const d = new Date(utc_days * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function parseDate(cell) {
  if (typeof cell === 'number') return serialToDate(cell);
  if (typeof cell === 'string') return cell.replace(/\//g, '-');
  return '';
}

const excelMap = new Map();
for (let i = 1; i < rows.length; i++) {
  const cell = rows[i];
  const d = cell[0];
  if (!d) continue;
  const dateStr = parseDate(d);
  if (!dateStr) continue;
  if (dateStr < `${YEAR}-01-01` || dateStr > `${YEAR}-12-31`) continue;
  excelMap.set(dateStr, {
    f1: (cell[2] || '').trim(),
    f2: (cell[3] || '').trim(),
    remark: (cell[4] || '').trim().replace(/\r?\n/g, '; '),
  });
}

console.log(`Excel 中 ${YEAR} 年有数据的日期: ${excelMap.size} 个`);

// ── 2. 获取节假日 ──
let holidays = [];
try {
  const tmpFile = `scripts/_holidays_${Date.now()}.json`;
  const out = execSync(
    `npx wrangler d1 execute paiban --local --command="SELECT date FROM calendar WHERE type='holiday' ORDER BY date" --json`,
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  // wrangler --json outputs non-JSON lines first, then JSON array
  const lines = out.split('\n').filter(l => l.trim());
  // Find the JSON part (starts with [)
  const jsonStart = lines.findIndex(l => l.trim().startsWith('['));
  if (jsonStart >= 0) {
    const jsonStr = lines.slice(jsonStart).join('\n');
    const parsed = JSON.parse(jsonStr);
    if (parsed[0]?.results) {
      holidays = parsed[0].results.map(r => r.date);
    }
  }
} catch (e) {
  console.warn('无法从 D1 获取节假日:', e.message);
}
const holidaySet = new Set(holidays);
console.log(`节假日: ${holidays.length} 个`);

// ── 3. 工具函数 ──
function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

function isPublish(dateStr) {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return false;
  if (holidaySet.has(dateStr)) return false;
  return true;
}

function weekdayName(dateStr) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayOfWeek(dateStr)];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
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

// ── 4. 生成 SQL ──
const inserts = [];

// Track names not in system member list
const systemMembers = new Set([
  '黄彬','刘钊','文科','王亮','赵宁','叶奕宏','吴彤','刘丹','史光浩','张宏伟','王畅','李悦','郭笑羽'
]);
const unknownNames = new Set();

for (const [date, data] of excelMap) {
  // Skip dates with no editors AND no remark (no meaningful data)
  if (!data.f1 && !data.f2 && !data.remark) continue;

  const wd = weekdayName(date);
  const pubDate = nextPublishDate(date);
  const remark = data.remark ? data.remark.replace(/'/g, "''") : '';

  if (data.f1 && !systemMembers.has(data.f1)) unknownNames.add(data.f1);
  if (data.f2 && !systemMembers.has(data.f2)) unknownNames.add(data.f2);

  inserts.push({
    dutyDate: date,
    publishDate: pubDate,
    weekday: wd,
    firstEditor: data.f1,
    secondEditor: data.f2,
    remark,
  });
}

console.log(`将导入 ${inserts.length} 条排班记录`);
if (unknownNames.size > 0) {
  console.log(`⚠ 以下人名不在系统成员列表中: ${[...unknownNames].join(', ')}`);
}

// Generate SQL
const sqlLines = [];
sqlLines.push(`DELETE FROM schedules WHERE user_id = ${USER_ID} AND duty_date >= '${YEAR}-01-01' AND duty_date <= '${YEAR}-12-31';`);

for (const r of inserts) {
  const fe = r.firstEditor ? `'${r.firstEditor.replace(/'/g, "''")}'` : 'NULL';
  const se = r.secondEditor ? `'${r.secondEditor.replace(/'/g, "''")}'` : 'NULL';
  const rem = r.remark ? `'${r.remark}'` : 'NULL';
  sqlLines.push(
    `INSERT INTO schedules (user_id, duty_date, publish_date, weekday, first_editor, second_editor, remark) ` +
    `VALUES (${USER_ID}, '${r.dutyDate}', '${r.publishDate}', '${r.weekday}', ${fe}, ${se}, ${rem});`
  );
}

const fullSql = sqlLines.join('\n');

// ── 5. 执行 ──
if (DRY_RUN) {
  console.log('\n=== SQL 预览 (前 20 行) ===');
  console.log(fullSql.split('\n').slice(0, 20).join('\n'));
  console.log(`... 共 ${sqlLines.length} 行`);
  console.log('\n完整 SQL 已保存至 scripts/_import_preview.sql');
  fs.writeFileSync('scripts/_import_preview.sql', fullSql, 'utf8');
} else {
  const tmpFile = `scripts/_import_${Date.now()}.sql`;
  fs.writeFileSync(tmpFile, fullSql, 'utf8');
  console.log(`\n执行 SQL 文件: ${tmpFile}`);
  try {
    const result = execSync(
      `npx wrangler d1 execute paiban --local --file="${tmpFile}" 2>&1`,
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    console.log(result.split('\n').filter(l => l.includes('Executed') || l.includes('error')).join('\n') || '✓ 执行完成');
  } catch (e) {
    console.error('执行失败:', e.message);
    process.exit(1);
  }
  fs.unlinkSync(tmpFile);
  console.log('✓ 导入完成');
}
