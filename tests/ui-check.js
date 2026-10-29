/* 界面 / 真浏览器校验：node tests/ui-check.js
 * 单文件版：用本机已安装的 Playwright Chromium 打开 file://.../index.html，验证：
 * 自包含（无外部 css/js、无外链）、离线（只有 1 个请求）、375/414 无横向溢出、
 * 复制内容与显示一致、增删改、JSON 导出导入往返、旧版 localStorage 数据可直接读取。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const URL_FILE = 'file://' + path.join(ROOT, 'index.html');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  → ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 780 }, acceptDownloads: true });
  const page = await ctx.newPage();

  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('request', r => requests.push(r.url()));
  page.on('dialog', d => d.accept());

  await page.addInitScript(() => {
    window.__copied = null;
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: t => { window.__copied = t; return Promise.resolve(); } }
      });
    } catch (e) { /* 忽略 */ }
  });

  await page.goto(URL_FILE, { waitUntil: 'load' });
  await page.waitForTimeout(150);

  /* ---------- 1. 首屏 ---------- */
  section('1) 首屏与内置示例');
  const count0 = await page.textContent('#statCount');
  ok('首屏自动载入 3 条示例', count0.trim() === '3个', count0.trim());
  ok('台账渲染 3 张卡片', (await page.$$('.sub-item')).length === 3);
  ok('每月折算 = 15 + 298/12 + 199 = ¥238.83', (await page.textContent('#statMonthly')).trim() === '¥238.83',
    (await page.textContent('#statMonthly')).trim());
  ok('每年总支出 = ¥2,866.00', (await page.textContent('#statYearly')).trim() === '¥2,866.00',
    (await page.textContent('#statYearly')).trim());
  ok('僵尸订阅汇总 2 个 / 一年 ¥2,686.00',
    (await page.textContent('#zombieCount')).trim() === '2' &&
    (await page.textContent('#zombieWaste')).trim() === '¥2,686.00',
    (await page.textContent('#zombieCount')).trim() + ' 个 / ' + (await page.textContent('#zombieWaste')).trim());
  ok('7 天内扣费提醒可见（示例里有 3 天后扣费的）', await page.isVisible('#riskBlock'));
  const riskText = await page.textContent('#riskList');
  ok('云音乐会员（3 天后扣费）出现在 7 天提醒里', riskText.includes('云音乐会员'), riskText.replace(/\s+/g, ' ').trim());
  ok('网盘超级会员（120 天后扣费）不在 7 天提醒里', !riskText.includes('网盘超级会员'));
  ok('健身房月卡（18 天后扣费）不在 7 天提醒里', !riskText.includes('健身房月卡'));

  /* ---------- 2. 单文件自包含 + 离线 ---------- */
  section('2) 单文件自包含 / 离线');
  const domInfo = await page.evaluate(() => ({
    scripts: Array.from(document.scripts).map(s => s.getAttribute('src') || '(inline)'),
    links: Array.from(document.querySelectorAll('link')).map(l => l.getAttribute('href')),
    styleTags: document.querySelectorAll('style').length,
    sheets: document.styleSheets.length,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    cardRadius: getComputedStyle(document.querySelector('.card')).borderRadius
  }));
  ok('页面里没有任何 <link>（不引外部样式表）', domInfo.links.length === 0, domInfo.links.join(', ') || '0 个');
  ok('唯一的 <script> 是内联的（无 src）',
    domInfo.scripts.length === 1 && domInfo.scripts[0] === '(inline)',
    JSON.stringify(domInfo.scripts));
  ok('内联 <style> 已生效（body 背景 rgb(244, 246, 247)、卡片圆角 14px）',
    domInfo.bodyBg === 'rgb(244, 246, 247)' && domInfo.cardRadius === '14px' && domInfo.styleTags === 1,
    domInfo.bodyBg + ' / ' + domInfo.cardRadius + ' / style=' + domInfo.styleTags);
  const external = requests.filter(u => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
  ok('没有任何联网请求', external.length === 0, external.join(', ') || '0 个外网请求');
  ok('整个页面只有 1 个请求（index.html 自己）', requests.length === 1,
    requests.length + ' 个：' + requests.map(u => u.split('/').pop()).join(', '));
  ok('无 JS 报错', errors.length === 0, errors.join(' | ') || '无');

  /* ---------- 3. 横向溢出 ---------- */
  section('3) 375 / 414 手机屏横向溢出');
  for (const w of [375, 414]) {
    await page.setViewportSize({ width: w, height: 780 });
    await page.waitForTimeout(80);
    const r = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      win: window.innerWidth
    }));
    ok(w + 'px：scrollWidth(' + r.doc + ') ≤ innerWidth(' + r.win + ')', r.doc <= r.win && r.body <= r.win,
      'doc=' + r.doc + ' body=' + r.body + ' inner=' + r.win);
  }
  // 弹窗打开时也不许溢出
  await page.click('#btnAdd');
  await page.waitForTimeout(120);
  const modalOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth
  }));
  ok('新增弹窗打开时仍无横向溢出', modalOverflow.doc <= modalOverflow.win,
    'doc=' + modalOverflow.doc + ' inner=' + modalOverflow.win);
  ok('周期为月付时「自定义天数」字段隐藏', await page.isHidden('#daysWrap'));
  await page.selectOption('#f-cycle', 'custom');
  await page.waitForTimeout(60);
  ok('切到自定义天数后该字段出现', await page.isVisible('#daysWrap'));
  await page.selectOption('#f-cycle', 'month');
  await page.waitForTimeout(60);
  ok('切回月付后再次隐藏', await page.isHidden('#daysWrap'));

  /* ---------- 4. 新增订阅 ---------- */
  section('4) 新增订阅（年付 59 元）');
  await page.fill('#f-name', '设计工具会员');
  await page.fill('#f-amount', '59');
  await page.selectOption('#f-cycle', 'year');
  await page.fill('#f-date', '2026-12-01');
  await page.selectOption('#f-category', '工具效率');
  await page.selectOption('#f-channel', 'Apple ID');
  await page.fill('#f-note', '年付折扣价');
  await page.click('#subForm button[type="submit"]');
  await page.waitForTimeout(150);
  ok('总数变 4', (await page.textContent('#statCount')).trim() === '4个', (await page.textContent('#statCount')).trim());
  ok('月合计 = 238.83 + 59/12 = ¥243.75', (await page.textContent('#statMonthly')).trim() === '¥243.75',
    (await page.textContent('#statMonthly')).trim());
  ok('新卡片出现', (await page.$$('.sub-item')).length === 4);
  ok('弹窗已关闭', await page.isHidden('#modal'));

  // 表单校验：空名称不写入
  await page.click('#btnAdd');
  await page.fill('#f-amount', '10');
  await page.click('#subForm button[type="submit"]');
  await page.waitForTimeout(80);
  ok('名称为空时报错且不关闭弹窗',
    (await page.isVisible('#formError')) && (await page.isVisible('#modal')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  ok('Esc 可关闭弹窗', await page.isHidden('#modal'));

  /* ---------- 5. 标记僵尸 ---------- */
  section('5) 标记「很久没用」');
  const before = (await page.textContent('#zombieCount')).trim();
  const firstToggle = await page.$('.sub-item [data-act="unused"]');
  await firstToggle.click();
  await page.waitForTimeout(120);
  const after = (await page.textContent('#zombieCount')).trim();
  ok('僵尸数量变化 ' + before + ' → ' + after, before !== after);

  /* ---------- 6. 话术与复制一致性 ---------- */
  section('6) 话术生成 + 复制内容与页面显示完全一致');
  await page.selectOption('#scriptSelect', { index: 0 });
  await page.waitForTimeout(100);
  for (const title of ['自动续费未提醒 · 要求退款', '误扣申诉', '降价挽留协商']) {
    await page.click(`.chip:has-text("${title}")`);
    await page.waitForTimeout(100);
    const shown = await page.textContent('#scriptText');
    await page.click('#btnCopy');
    await page.waitForTimeout(120);
    const copied = await page.evaluate(() => window.__copied);
    ok('「' + title + '」复制内容 === 页面显示（' + shown.length + ' 字符）', copied === shown,
      copied === shown ? '完全一致' : '不一致');
    ok('「' + title + '」含争议点/诉求/核对三段',
      shown.includes('【争议点】') && shown.includes('【我的诉求】') && shown.includes('【提交前请核对】'));
  }
  const shownText = await page.textContent('#scriptText');
  ok('话术自动带入金额与日期', /¥[\d,]+\.\d{2}/.test(shownText) && /\d{4}-\d{2}-\d{2}/.test(shownText),
    shownText.split('\n').slice(0, 1).join(''));

  /* ---------- 7. JSON 导出 → 清空 → 导入 ---------- */
  section('7) JSON 备份导出 / 清空 / 导入 往返一致');
  const statBefore = {
    count: (await page.textContent('#statCount')).trim(),
    monthly: (await page.textContent('#statMonthly')).trim(),
    yearly: (await page.textContent('#statYearly')).trim()
  };
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btnExportJson')
  ]);
  const tmp = path.join(os.tmpdir(), 'subcheckup-backup-' + Date.now() + '.json');
  await download.saveAs(tmp);
  const raw = fs.readFileSync(tmp, 'utf8');
  const parsed = JSON.parse(raw);
  ok('下载的备份是合法 JSON 且含 4 条记录',
    parsed.app === 'subscription-checkup' && parsed.version === 1 && parsed.subscriptions.length === 4,
    path.basename(download.suggestedFilename()) + ' / ' + parsed.subscriptions.length + ' 条');

  await page.click('#btnClear');
  await page.waitForTimeout(150);
  ok('清空后为 0', (await page.textContent('#statCount')).trim() === '0个');
  ok('清空后显示空状态', await page.isVisible('#emptyState'));

  await page.setInputFiles('#fileInput', tmp);
  await page.waitForTimeout(250);
  const statAfter = {
    count: (await page.textContent('#statCount')).trim(),
    monthly: (await page.textContent('#statMonthly')).trim(),
    yearly: (await page.textContent('#statYearly')).trim()
  };
  ok('导入后统计与导出前完全一致',
    JSON.stringify(statBefore) === JSON.stringify(statAfter),
    JSON.stringify(statAfter));

  /* ---------- 8. 刷新持久化 ---------- */
  section('8) 刷新后数据仍在（localStorage）');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(150);
  ok('刷新后仍是 4 条', (await page.textContent('#statCount')).trim() === '4个',
    (await page.textContent('#statCount')).trim());
  ok('刷新后月合计仍是 ¥243.75', (await page.textContent('#statMonthly')).trim() === '¥243.75');

  /* ---------- 9. CSV ---------- */
  section('9) CSV 导出');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExportCsv')]);
  const csvPath = path.join(os.tmpdir(), 'subcheckup-' + Date.now() + '.csv');
  await csvDl.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  ok('CSV 行数 = 表头 + 4 条', csv.replace('\ufeff', '').split('\r\n').length === 5,
    path.basename(csvDl.suggestedFilename()));
  ok('CSV 表头正确', csv.replace('\ufeff', '').startsWith('名称,金额,周期,自定义天数,下次扣费日期,月均支出,年均支出'));

  /* ---------- 10. 旧版三件套的数据兼容 ---------- */
  section('10) 旧版（三件套）写入的 localStorage 数据直接可读');
  const ctx2 = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', e => errors2.push('pageerror: ' + e.message));
  await p2.addInitScript(() => {
    // 完全照上一版 app.js 的存储结构写入
    localStorage.setItem('subscription-checkup.v1', JSON.stringify({
      version: 1,
      seeded: true,
      subs: [
        { id: 'old1', name: '旧版-视频会员', amount: 25, cycle: 'month', customDays: null, nextDate: '2026-11-02', category: '影音娱乐', channel: '微信支付', autoRenew: true, unused: false, note: '上一版写入', createdAt: 1700000000000 },
        { id: 'old2', name: '旧版-季度卡', amount: 120, cycle: 'custom', customDays: 60, nextDate: '2026-12-20', category: '工具效率', channel: '支付宝', autoRenew: true, unused: true, note: '', createdAt: 1700000000001 }
      ]
    }));
  });
  await p2.goto(URL_FILE, { waitUntil: 'load' });
  await p2.waitForTimeout(200);
  ok('旧数据被直接读出（2 条，不是 3 条示例）', (await p2.textContent('#statCount')).trim() === '2个',
    (await p2.textContent('#statCount')).trim());
  ok('旧数据金额算对：25 + 120/(60/30.44) = ¥85.88', (await p2.textContent('#statMonthly')).trim() === '¥85.88',
    (await p2.textContent('#statMonthly')).trim());
  ok('旧数据的备注与标记保留',
    (await p2.textContent('.sub-list')).includes('上一版写入') &&
    (await p2.textContent('#zombieCount')).trim() === '1',
    '僵尸 ' + (await p2.textContent('#zombieCount')).trim() + ' 个');
  ok('旧数据页面无 JS 报错', errors2.length === 0, errors2.join(' | ') || '无');
  await ctx2.close();

  /* ---------- 11. 3 条示例的导出→清空→导入→刷新 ---------- */
  section('11) 3 条示例：导出 JSON → 清空 → 导入 → 刷新');
  const ctx3 = await browser.newContext({ viewport: { width: 375, height: 780 }, acceptDownloads: true });
  const p3 = await ctx3.newPage();
  p3.on('dialog', d => d.accept());
  await p3.goto(URL_FILE, { waitUntil: 'load' });
  await p3.waitForTimeout(200);
  const base3 = {
    count: (await p3.textContent('#statCount')).trim(),
    monthly: (await p3.textContent('#statMonthly')).trim(),
    yearly: (await p3.textContent('#statYearly')).trim()
  };
  ok('起始：3 个 / ¥238.83 / ¥2,866.00',
    base3.count === '3个' && base3.monthly === '¥238.83' && base3.yearly === '¥2,866.00',
    JSON.stringify(base3));

  const [dl3] = await Promise.all([p3.waitForEvent('download'), p3.click('#btnExportJson')]);
  const f3 = path.join(os.tmpdir(), 'subcheckup-3-' + Date.now() + '.json');
  await dl3.saveAs(f3);
  ok('导出文件含 3 条记录',
    JSON.parse(fs.readFileSync(f3, 'utf8')).subscriptions.length === 3,
    path.basename(dl3.suggestedFilename()));

  await p3.click('#btnClear');
  await p3.waitForTimeout(200);
  ok('清空后 0 条', (await p3.textContent('#statCount')).trim() === '0个');

  await p3.setInputFiles('#fileInput', f3);
  await p3.waitForTimeout(300);
  const after3 = {
    count: (await p3.textContent('#statCount')).trim(),
    monthly: (await p3.textContent('#statMonthly')).trim(),
    yearly: (await p3.textContent('#statYearly')).trim()
  };
  ok('导入后完全恢复 3 个 / ¥238.83 / ¥2,866.00', JSON.stringify(after3) === JSON.stringify(base3),
    JSON.stringify(after3));

  await p3.reload({ waitUntil: 'load' });
  await p3.waitForTimeout(200);
  ok('刷新后仍是 3 个 / ¥238.83',
    (await p3.textContent('#statCount')).trim() === '3个' &&
    (await p3.textContent('#statMonthly')).trim() === '¥238.83',
    (await p3.textContent('#statCount')).trim() + ' / ' + (await p3.textContent('#statMonthly')).trim());
  await ctx3.close();

  ok('全流程无 JS 报错', errors.length === 0, errors.join(' | ') || '无');

  await browser.close();

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail > 0) process.exit(1);
  console.log('浏览器端校验全部通过 ✅');
})().catch(e => { console.error('运行失败：', e); process.exit(1); });
