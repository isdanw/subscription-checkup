/* 纯逻辑校验：node tests/verify.js
 * 单文件版：从 index.html 的内联 <script> 里取出纯函数，在 Node 的 vm 沙箱里跑，不依赖浏览器。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

/** 取出所有“没有 src 属性”的内联 <script> 内容。 */
function inlineScriptsOf(source) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

const INLINE = inlineScriptsOf(html);
if (INLINE.length !== 1) {
  console.error('index.html 里应恰好有 1 段内联脚本，实际 ' + INLINE.length + ' 段');
  process.exit(1);
}
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(INLINE[0], sandbox, { filename: 'index.html#inline-script' });
const app = sandbox.SubCheckup;
if (!app) {
  console.error('内联脚本没有导出 SubCheckup');
  process.exit(1);
}

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name + (extra ? '  → ' + extra : ''));
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected) || Math.abs(Number(actual) - Number(expected)) < 1e-9,
    '实际=' + actual + ' 期望=' + expected);
}

function section(t) {
  console.log('\n' + t);
}

const T = '2026-10-29'; // 固定“今天”，避免测试随日期漂移

/* ---------- 1. 折算口径 ---------- */
section('1) 金额折算口径');
eq('月付 30 元 → 每月 30', app.monthlyOf({ amount: 30, cycle: 'month' }), 30);
eq('年付 360 元 → 每月 30', app.monthlyOf({ amount: 360, cycle: 'year' }), 30);
eq('自定义 90 天 / 90 元 → 每月 30.44', app.monthlyOf({ amount: 90, cycle: 'custom', customDays: 90 }), 90 / (90 / 30.44));
eq('自定义 90 天 / 90 元 精确值', +app.monthlyOf({ amount: 90, cycle: 'custom', customDays: 90 }).toFixed(4), 30.44);
eq('自定义 7 天 / 7 元 → 每月 30.44', +app.monthlyOf({ amount: 7, cycle: 'custom', customDays: 7 }).toFixed(2), 30.44);
eq('年付 360 元 → 每年 360', app.yearlyOf({ amount: 360, cycle: 'year' }), 360);
eq('月付 30 元 → 每年 360', app.yearlyOf({ amount: 30, cycle: 'month' }), 360);
eq('自定义 90 天 / 90 元 → 每年 365.28', +app.yearlyOf({ amount: 90, cycle: 'custom', customDays: 90 }).toFixed(2), 365.28);
eq('自定义天数为 0 时安全归零', app.monthlyOf({ amount: 90, cycle: 'custom', customDays: 0 }), 0);
eq('金额非法字符串不产生 NaN', app.monthlyOf({ amount: 'abc', cycle: 'month' }), 0);

/* ---------- 2. 总览与排序 ---------- */
section('2) 体检总览 + 金额从高到低排序');
const subs = [
  { id: 'a', name: '云音乐会员', amount: 15, cycle: 'month', nextDate: '2026-11-01', category: '影音娱乐', channel: '微信支付', autoRenew: true, unused: false },
  { id: 'b', name: '网盘超级会员', amount: 298, cycle: 'year', nextDate: '2027-02-26', category: '云存储', channel: '支付宝', autoRenew: true, unused: true },
  { id: 'c', name: '健身房月卡', amount: 199, cycle: 'month', nextDate: '2026-11-16', category: '健康运动', channel: '银行卡', autoRenew: false, unused: true },
  { id: 'd', name: '季度会员', amount: 90, cycle: 'custom', customDays: 90, nextDate: '2026-11-05', category: '工具效率', channel: 'Apple ID', autoRenew: true, unused: false }
].map(s => app.normalize({ createdAt: 1700000000000, ...s })); // 固定 createdAt，让往返对比稳定
const sum = app.summarize(subs);
eq('订阅总数', sum.count, 4);
eq('每月折算合计 = 15 + 298/12 + 199 + 30.44', +sum.monthly.toFixed(4), +(15 + 298 / 12 + 199 + 90 / (90 / 30.44)).toFixed(4));
eq('每年总支出 = 月合计 × 12', +sum.yearly.toFixed(4), +(sum.monthly * 12).toFixed(4));
ok('每月金额展示带 ¥ 与两位小数', sum.monthlyText === '¥269.27', sum.monthlyText);
const sorted = app.sortByMonthly(subs).map(s => s.name);
ok('排序结果 = 健身房199 > 季度30.44 > 网盘24.83 > 云音乐15', JSON.stringify(sorted) ===
  JSON.stringify(['健身房月卡', '季度会员', '网盘超级会员', '云音乐会员']), sorted.join(' > '));
eq('空数据总览为 0', app.summarize([]).monthly, 0);

/* ---------- 3. 7 天风险 ---------- */
section('3) 7 天内即将扣费（含今天，边界 0 和 7）');
const risk = [
  { id: 'r0', name: '今天扣', amount: 10, cycle: 'month', nextDate: '2026-10-29' },
  { id: 'r7', name: '第7天扣', amount: 20, cycle: 'month', nextDate: '2026-11-05' },
  { id: 'r8', name: '第8天扣', amount: 30, cycle: 'month', nextDate: '2026-11-06' },
  { id: 'rp', name: '昨天已扣', amount: 40, cycle: 'month', nextDate: '2026-10-28' }
];
eq('天数计算：今天=0', app.daysUntil('2026-10-29', T), 0);
eq('天数计算：明天=1', app.daysUntil('2026-10-30', T), 1);
eq('天数计算：跨月=7', app.daysUntil('2026-11-05', T), 7);
eq('天数计算：已过期=-1', app.daysUntil('2026-10-28', T), -1);
const up = app.upcoming(risk, T);
ok('命中 2 条（第 0 天与第 7 天）', up.length === 2, up.map(x => x.sub.name + ':' + x.days).join(', '));
ok('按天数升序', up[0].days === 0 && up[1].days === 7);
ok('第 8 天不提醒', !up.some(x => x.sub.id === 'r8'));
ok('已过期不进入提醒', !up.some(x => x.sub.id === 'rp'));
ok('台账里 7 天内扣费的置顶', app.ledgerOrder(risk, T)[0].id === 'r0' &&
  app.ledgerOrder(risk, T)[1].id === 'r7' && app.ledgerOrder(risk, T)[2].id === 'rp');

/* ---------- 4. 僵尸订阅 ---------- */
section('4) 僵尸订阅与一年浪费金额');
const zom = app.zombies(subs);
eq('僵尸数量', zom.count, 2);
eq('浪费 = 298 + 199×12', +zom.yearlyWaste.toFixed(2), 298 + 199 * 12);
ok('僵尸列表按每月折算降序', zom.list[0].name === '健身房月卡', zom.list.map(s => s.name).join(', '));
eq('浪费金额展示', zom.yearlyWasteText, '¥2,686.00');
eq('没有僵尸时为 0', app.zombies([subs[0]]).yearlyWaste, 0);

/* ---------- 5. 备份往返 ---------- */
section('5) JSON 备份导出 → 导入 往返一致');
const backupText = app.buildBackup(subs, new Date('2026-10-29T12:00:00Z'));
const parsed = app.parseBackup(backupText);
ok('导入成功', parsed.ok === true);
eq('条数一致', parsed.count, subs.length);
ok('往返后每条记录深相等（含自定义天数、备注、标记）',
  JSON.stringify(parsed.subs) === JSON.stringify(subs.map(app.normalize)));
ok('备份含版本号与导出时间',
  JSON.parse(backupText).app === 'subscription-checkup' &&
  JSON.parse(backupText).version === 1 &&
  !!JSON.parse(backupText).exportedAt);
ok('脏数据不会破坏导入（缺字段补默认值）', (() => {
  const r = app.parseBackup(JSON.stringify({ subscriptions: [{ name: '裸数据' }] }));
  const s = r.subs[0];
  return r.ok && s.cycle === 'month' && s.amount === 0 && s.category === '其他' && s.nextDate === '';
})());
ok('非法 JSON 报错而不是崩溃', app.parseBackup('{oops').ok === false);
ok('空备份被拒绝', app.parseBackup(JSON.stringify({ subscriptions: [] })).ok === false);

/* ---------- 6. CSV ---------- */
section('6) CSV 导出与转义');
const csv = app.toCSV([{ name: 'A,B "套装"', amount: 12.5, cycle: 'year', nextDate: '2026-11-01', category: '工具效率', channel: '支付宝', autoRenew: true, unused: false, note: '第一行\n第二行' }]);
const lines = csv.split('\r\n');
ok('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csv.charCodeAt(0) === 0xFEFF);
ok('表头字段齐全', lines[0].replace('\ufeff', '') === '名称,金额,周期,自定义天数,下次扣费日期,月均支出,年均支出,类别,支付渠道,自动续费,很久没用,备注');
ok('含逗号/引号的字段被正确加引号转义', lines[1].startsWith('"A,B ""套装"""'), lines[1].slice(0, 20));
ok('换行备注被包进引号（不会串行）', csv.includes('"第一行\n第二行"'));
ok('年付 12.5 元 → 月均 1.04', lines[1].includes(',1.04,'), lines[1]);

/* ---------- 7. 话术 ---------- */
section('7) 话术生成（3 个模板 + 字段带入 + 结构）');
eq('模板数量 ≥ 3', app.TEMPLATES.length >= 3, true);
ok('三个模板 id 齐全', ['refund', 'wrong', 'retention'].every(id => !!app.templateById(id)));
const target = subs[1];
['refund', 'wrong', 'retention'].forEach(id => {
  const text = app.buildScript(target, id);
  const tpl = app.templateById(id);
  ok('[' + id + '] 带入订阅名「' + target.name + '」', text.includes(target.name));
  ok('[' + id + '] 带入金额 ¥298.00', text.includes('¥298.00'));
  ok('[' + id + '] 带入扣费日期 ' + target.nextDate, text.includes(target.nextDate));
  ok('[' + id + '] 结构：争议点 → 诉求 → 提交前核对',
    text.indexOf('【争议点】') === 0 &&
    text.indexOf('【我的诉求】') > text.indexOf('【争议点】') &&
    text.indexOf('【提交前请核对】') > text.indexOf('【我的诉求】'));
  ok('[' + id + '] 模板标题非空', tpl.title.length > 0);
  ok('[' + id + '] 无首尾空白（保证复制与显示一致）', text === text.trim());
});
const retention = app.buildScript(target, 'retention');
ok('挽留话术包含下次扣费日期与降价诉求', retention.includes('更优惠的续费方案') && retention.includes(target.nextDate));
ok('未选订阅时返回空串', app.buildScript(null, 'refund') === '');

/* ---------- 8. 金额格式化 ---------- */
section('8) 金额格式化');
eq('千分位', app.fmtMoney(2686), '¥2,686.00');
eq('两位小数补零', app.fmtMoney(15), '¥15.00');
eq('四舍五入', app.fmtMoney(30.445), '¥30.45');

/* ---------- 9. 单文件自包含 / 离线 ---------- */
section('9) 单文件自包含 / 离线约束');
const leftover = ['app.js', 'styles.css'].filter(f => fs.existsSync(path.join(ROOT, f)));
ok('app.js 与 styles.css 已从项目里删除', leftover.length === 0, leftover.join(', ') || '两者都不存在');
ok('index.html 里没有 <link> 标签（不引外部样式表）', !/<link\b/i.test(html));
ok('index.html 里没有 <script src=...>', !/<script\b[^>]*\bsrc\s*=/i.test(html));
ok('没有 src=/href= 指向本地 .js / .css 文件',
  !/(?:src|href)\s*=\s*["'][^"']*\.(?:js|css)\b/i.test(html),
  (html.match(/(?:src|href)\s*=\s*["'][^"']*\.(?:js|css)\b/gi) || ['无']).join(' | '));
ok('没有任何 http(s) 外链', !/https?:\/\//i.test(html),
  (html.match(/https?:\/\/[^\s"')]+/gi) || ['无']).join(' | '));
ok('没有 //cdn 协议相对外链', !/["'(]\/\/[a-z0-9]/i.test(html));
ok('没有 fetch / XMLHttpRequest 之类网络调用', !/\bfetch\s*\(|XMLHttpRequest/.test(html));
ok('样式与脚本都已内联：<style> 1 段、内联 <script> 1 段',
  (html.match(/<style\b/gi) || []).length === 1 && INLINE.length === 1,
  'style=' + (html.match(/<style\b/gi) || []).length + ' 段, inline script=' + INLINE.length + ' 段');
ok('内联脚本体积正常（> 25KB，说明整段业务逻辑都进来了）', INLINE[0].length > 25000,
  INLINE[0].length + ' 字符');
ok('内联样式体积正常（> 10KB）',
  (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1].length > 10000,
  (html.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i) || ['', ''])[1].length + ' 字符');
ok('localStorage 键名保持不变', app.STORAGE_KEY === 'subscription-checkup.v1', app.STORAGE_KEY);
ok('备份格式标识保持不变', app.buildBackup([]).indexOf('"app": "subscription-checkup"') > 0);

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail > 0) process.exit(1);
console.log('全部校验通过 ✅');
