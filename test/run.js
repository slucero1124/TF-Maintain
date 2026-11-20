/* TF-Maintain headless regression run.
   Usage:  node test/run.js        (uses the pre-installed Playwright + Chromium)
   Serves the repo on a local port, swaps Trello's power-up.min.js for a mock,
   and drives every mode: scheduling math, standalone editor, card face,
   connector (badges, deterministic URL, comment queue flush), dashboard. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'tf-maintain.html';
let pass = 0, fail = 0;
function ok(cond, name, extra){ if(cond){ pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } }

/* ---- syntax check every inline <script> block ---- */
const html = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tfm-'));
blocks.forEach((b, i) => { const f = path.join(tmp, 'b' + i + '.js'); fs.writeFileSync(f, b); try{ execSync('node --check ' + f); ok(true, 'syntax: script block ' + i); }catch(e){ ok(false, 'syntax: script block ' + i, String(e.stderr)); } });
const ver = (html.match(/var VERSION = '([^']+)'/) || [])[1];
ok(!!ver, 'VERSION present: ' + ver);

/* ---- mock Trello client library ---- */
const STUB = `
(function(){
  var top = window.top;
  top.__store = top.__store || {card:{}, board:{}};
  top.__sets = top.__sets || [];
  top.__modals = top.__modals || [];
  function merge(scope, obj){ var s = top.__store[scope]; Object.keys(obj).forEach(function(k){ s[k] = JSON.parse(JSON.stringify(obj[k])); }); }
  var t = {
    get: function(scope, vis, key){ var s = top.__store[scope] || {}; return Promise.resolve(key ? (s[key] === undefined ? undefined : JSON.parse(JSON.stringify(s[key]))) : JSON.parse(JSON.stringify(s))); },
    set: function(scope, vis, k, v){ var o = typeof k === 'string' ? (function(){ var x = {}; x[k] = v; return x; })() : k; merge(scope, o); top.__sets.push({scope:scope, from:location.search, data:JSON.parse(JSON.stringify(o))}); return Promise.resolve(); },
    member: function(){ return Promise.resolve({fullName:'Steven Lucero', username:'steven'}); },
    board: function(){ return Promise.resolve({members:[{fullName:'Valerie Bravo'},{fullName:'Tristan Adams'}]}); },
    modal: function(o){ top.__modals.push(o); return Promise.resolve(); },
    sizeTo: function(){ return Promise.resolve(); },
    render: function(){},
    showCard: function(id){ top.__shown = id; },
    getContext: function(){ return {theme:'dark', card:'card1', board:'board1'}; },
    getRestApi: function(){ return { isAuthorized: function(){ return Promise.resolve(!!top.__authorized); }, getToken: function(){ return Promise.resolve(top.__authorized ? 'tok' : null); }, authorize: function(){ top.__authorized = true; return Promise.resolve('tok'); } }; }
  };
  window.TrelloPowerUp = { iframe: function(){ return t; }, initialize: function(caps, opts){ top.__caps = caps; top.__capT = t; top.__initOpts = opts; } };
})();`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if(u.pathname === '/harness.html'){ res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><html><body><script>window.__relays=[];var bc=new BroadcastChannel("tf-maint");bc.onmessage=function(e){window.__relays.push(e.data)};</script></body></html>'); return; }
  const f = path.join(ROOT, u.pathname);
  if(!f.startsWith(ROOT) || !fs.existsSync(f)){ res.writeHead(404); res.end(); return; }
  res.writeHead(200, {'content-type':'text/html; charset=utf-8'}); res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport:{width:900, height:1000} });
  await ctx.addInitScript(() => { window.__TODAY = '2026-11-20'; }); // pinned Friday for every page and frame
  await ctx.route('https://p.trellocdn.com/**', r => r.fulfill({ contentType:'application/javascript', body: STUB }));
  let posted = [];
  await ctx.route('https://api.trello.com/**', r => { posted.push({method:r.request().method(), url:r.request().url()}); r.fulfill({contentType:'application/json', body:'{}'}); });
  const errors = [];
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));

  /* ===== 1. scheduling math (standalone) ===== */
  console.log('\nScheduling');
  await page.goto(BASE + '/' + FILE);
  const R = await page.evaluate(() => {
    window.__TODAY = '2026-11-20'; // Friday
    var T = today(), st = function(k){ var s = slotStatus(k, k.ld, T); return s.st + ' ' + ymd(s.open) + ' ' + ymd(s.due); };
    var out = {};
    out.over   = st({ev:'2w', w:3, ld:'2026-11-02'});
    out.due    = st({ev:'2w', w:3, ld:'2026-11-06'});
    out.up     = st({ev:'2w', w:3, ld:'2026-11-09'});
    out.wkend  = st({ev:'2w', w:3, ld:'2026-11-07'});
    out.never  = st({ev:'1m', w:5, c:'2026-11-20'});
    out.fixOver= st({ev:'1m', w:3, md:'f', an:'2026-11-01'});
    out.fixDone= st({ev:'1m', w:3, md:'f', an:'2026-11-01', ld:'2026-11-03'});
    out.fixFut = st({ev:'1w', w:2, md:'f', an:'2026-11-23'});
    out.monthEnd = ymd(addM(new Date(2026,0,31), 1));
    out.ancW = resolveAnchor('f:w1'); out.ancM = resolveAnchor('f:m1');
    var unitK = {ev:'1w', w:2, ap:'u', lu:{A:'2026-11-19'}, c:'2026-11-20'};
    var su = statusOf(unitK, ['A','B'], T); out.unit = su.st + ' ' + su.doneN + '/' + su.total;
    out.counts = cardCounts({k:[{i:'a',n:'a',ev:'2w',w:3,ld:'2026-11-02'},{i:'b',n:'b',ev:'2w',w:3,ld:'2026-11-06'},{i:'c',n:'c',ev:'2w',w:3,ld:'2026-11-09'}], u:[]}, T);
    out.badges = badgesFor({k:[{i:'a',n:'a',ev:'2w',w:3,ld:'2026-11-02'},{i:'b',n:'b',ev:'2w',w:3,ld:'2026-11-06'}]}, T).map(function(b){ return b.text + '/' + b.color; });
    out.noBadge = badgesFor({k:[{i:'c',n:'c',ev:'2w',w:3,ld:'2026-11-09'}]}, T).length + badgesFor(null, T).length;
    out.evText = ['1w','2w','1m','3m','12m','10d'].map(evText).join('|');
    return out;
  });
  ok(R.over === 'over 2026-11-16 2026-11-18', 'from-last: 2w after Mon Nov 2 is overdue by Fri Nov 20', R.over);
  ok(R.due === 'due 2026-11-20 2026-11-24', 'from-last: window of 3 workdays skips the weekend', R.due);
  ok(R.up === 'up 2026-11-23 2026-11-25', 'from-last: not open yet -> upcoming', R.up);
  ok(R.wkend.indexOf('up 2026-11-23') === 0, 'opening on a Saturday moves to Monday', R.wkend);
  ok(R.never === 'due 2026-11-20 2026-11-26', 'never done: opens on creation day', R.never);
  ok(R.fixOver === 'over 2026-11-02 2026-11-04', 'fixed monthly: Sunday anchor opens Monday; missed -> overdue', R.fixOver);
  ok(R.fixDone.indexOf('up 2026-12-01') === 0, 'fixed monthly: done this cycle -> next is Dec 1', R.fixDone);
  ok(R.fixFut.indexOf('up 2026-11-23') === 0, 'fixed: future anchor is upcoming', R.fixFut);
  ok(R.monthEnd === '2026-02-28', 'month math clamps Jan 31 + 1m to Feb 28', R.monthEnd);
  ok(R.ancW === '2026-11-23' && R.ancM === '2026-12-01', 'template anchors start at the next occurrence', [R.ancW, R.ancM]);
  ok(R.unit === 'due 1/2', 'per-unit: one done, one due -> due 1/2', R.unit);
  ok(R.counts.over === 1 && R.counts.due === 1 && R.counts.up === 1, 'card counts', R.counts);
  ok(JSON.stringify(R.badges) === '["1 overdue/yellow","1 due/blue"]', 'badges: amber overdue + blue due', R.badges);
  ok(R.noBadge === 0, 'no badge when nothing is due, or no routine');
  ok(R.evText === 'Weekly|Every 2 weeks|Monthly|Quarterly|Yearly|Every 10 days', 'interval labels', R.evText);

  /* ===== 2. state rules ===== */
  console.log('\nState rules');
  const St = await page.evaluate(() => {
    window.__TODAY = '2026-11-20'; _member = 'Steven L.';
    S = blank(); S.k.push({i:'t1', n:'Sweep shop floor', ev:'2w', w:3, ld:'2026-11-02'});
    var out = {};
    mutate(function(){ logDone(S.k[0], null, {nt:'all good'}); });
    out.ld = S.k[0].ld; out.h = S.h.length; out.by = S.h[0].by;
    mutate(function(){ undoToday(S.k[0]); });
    out.undoLd = S.k[0].ld; out.undoH = S.h.length;
    for(var i=0;i<45;i++) S.h.push({k:'t1', d:1700000000+i*86400, by:'Valerie B.'});
    mutate(function(){});
    out.hAfter = S.h.length; out.q = S.q.length; out.qText = S.q[0] && S.q[0].x.split('\n')[0];
    out.qLines = S.q[0] && S.q[0].x.split('\n').length;
    var snap = JSON.stringify(S);
    out.refused = mutate(function(){ for(var j=0;j<200;j++) S.u.push('Unit number ' + j); });
    out.unchanged = JSON.stringify(S) === snap;
    mutate(function(){ addFlag(S.k[0], ['X1C'], 'nozzle clog'); });
    out.fl = S.fl.length; out.flagComment = S.q[S.q.length-1].x;
    _qh = S.q[S.q.length-1].i; mutate(function(){});
    out.pruned = S.q.length;
    return out;
  });
  ok(St.ld === '2026-11-20' && St.h === 1 && St.by === 'Steven L.', 'logging sets last done and records who', St);
  ok(St.undoLd === '2026-11-02' && St.undoH === 0, 'tap again undoes and restores the previous date', St);
  ok(St.hAfter <= 40 && St.q === 1 && /history archive/.test(St.qText), 'history over the limit is archived into a queued comment', St);
  ok(St.qLines >= 16, 'archive comment lists the moved entries', St.qLines);
  ok(St.refused === false && St.unchanged, 'over the 4 KB cap: change refused and rolled back');
  ok(St.fl === 1 && /issue flagged/.test(St.flagComment) && /X1C/.test(St.flagComment) && /nozzle clog/.test(St.flagComment), 'flag creates an open issue and queues a comment', St.flagComment);
  ok(St.pruned === 0, 'comments already posted by the connector are pruned on the next write');

  /* ===== 3. standalone editor ===== */
  console.log('\nEditor (standalone)');
  await page.evaluate(() => { try{ localStorage.clear(); }catch(e){} });
  await page.goto(BASE + '/' + FILE);
  ok(await page.isVisible('#app') && !(await page.isVisible('#summaryView')), 'standalone shows the editor only');
  ok((await page.textContent('#verInline')) === 'v' + ver, 'version in header');
  ok(await page.isVisible('text=Add a maintenance routine'), 'empty card opens at the routine picker');
  const nTpl = await page.$$eval('.tpl', b => b.length);
  ok(nTpl >= 20, 'built-in templates listed: ' + nTpl);
  await page.click('.tpl[data-t="sla"]');
  ok(await page.isVisible('text=Form Wash IPA concentration'), 'template preview shows its tasks');
  await page.click('[data-a="apply"]');
  ok((await page.$$eval('.trow', r => r.length)) === 6, 'Add to card: 6 SLA tasks on the card');
  ok((await page.$$eval('.uchip', r => r.length)) === 4, 'SLA units added');
  await page.click('.trow:first-child [data-a="log"]');
  ok(await page.isVisible('#lgUnits'), 'per-unit task log form shows unit picks');
  await page.click('#lgUnits .pick[data-u="Form 3BL"]');
  await page.fill('#lgNote', 'tank swapped');
  await page.check('#lgFlag');
  await page.click('[data-a="dolog"]');
  await page.waitForTimeout(400);
  const ed1 = await page.evaluate(() => ({h:S.h, fl:S.fl.length, q:S.q.length, stored: !!localStorage.getItem('tf-maintain-card')}));
  ok(ed1.h.length === 1 && ed1.h[0].u.length === 3 && ed1.h[0].u.indexOf('Form 3BL') < 0 && ed1.h[0].nt === 'tank swapped', 'log with unit subset + note', ed1.h);
  ok(ed1.fl === 1 && ed1.q === 1, 'problem found -> flag + queued comment');
  ok(ed1.stored, 'saved to browser storage in standalone');
  ok(await page.isVisible('text=Open issues'), 'open issue listed in the editor');
  await page.click('.trow:nth-child(2) [data-a="edit"]');
  await page.fill('#f_n', 'Wipe build platforms with IPA');
  await page.fill('#f_evn', '3'); await page.selectOption('#f_evu', 'd');
  await page.selectOption('#f_ow', 'Technician');
  await page.click('#f_md button[data-v="f"]');
  const ed2 = await page.evaluate(() => S.k[1]);
  ok(ed2.n === 'Wipe build platforms with IPA' && ed2.ev === '3d' && ed2.ow === 'Technician' && ed2.md === 'f' && ed2.an, 'edit task: name, interval, owner, fixed schedule', ed2);
  ok(await page.isVisible('#f_an'), 'fixed schedule reveals its start date');
  await page.click('[data-a="close"]');
  await page.click('[data-a="addunit"]'); // empty: no-op
  await page.fill('#newUnit', 'Form 4L'); await page.press('#newUnit', 'Enter');
  ok((await page.evaluate(() => S.u)).indexOf('Form 4L') >= 0, 'add unit with Enter');
  await page.click('[data-a="savetpl"]');
  await page.fill('#tplName', 'Our SLA routine'); await page.click('[data-a="dosavetpl"]');
  const bt = await page.evaluate(() => BOARD_T);
  const btIds = Object.keys(bt);
  ok(btIds.length === 1 && bt[btIds[0]].k.length === 6, 'save routine as a board template');
  await page.click('[data-a="picker"]');
  ok(await page.isVisible('text=Board templates') && await page.isVisible('.tpl >> text=Our SLA routine'), 'board template appears in the picker');
  await page.click('[data-a="closepicker"]');
  await page.click('[data-a="savetpl"]');
  await page.fill('#tplName', 'FDM printer fleet'); await page.click('[data-a="dosavetpl"]');
  const bt2 = await page.evaluate(() => ({fdm: BOARD_T.fdm && BOARD_T.fdm.n, edited: tplById('fdm').edited}));
  ok(bt2.fdm === 'FDM printer fleet' && bt2.edited, 'saving under a built-in name edits that built-in for the board');
  await page.click('[data-a="rmroutine"]'); await page.click('[data-a="rmroutine2"]');
  ok(await page.isVisible('text=Add a maintenance routine'), 'remove routine (two taps) returns to the picker');

  /* ===== 4. card face (summary) ===== */
  console.log('\nCard face');
  const todayStr = '2026-11-20';
  const MNT = { v:1, s:'davis', u:['X1C #1','X1C #2','Prusa XL'], k:[
    {i:'a', n:'Sweep shop floor', ev:'2w', w:3, ld:'2026-10-01'},
    {i:'b', n:'Clean build plates', ev:'1w', w:3, ap:'u', lu:{'X1C #1':'2026-11-19'}, c:'2026-11-20', ow:'Technician'},
    {i:'c', n:'Probe calibration', ev:'3m', w:5, ld:'2026-11-19'}
  ], h:[], fl:[], q:[] };
  const faceUrl = m => BASE + '/' + FILE + '?view=summary&d=' + encodeURIComponent(JSON.stringify({m:m, q:0, n:'Steven L.'}));
  const hp = await ctx.newPage(); hp.on('pageerror', e => errors.push('harness: ' + e.message));
  await hp.goto(BASE + '/harness.html');
  const mount = async (src) => {
    await hp.evaluate(src => { document.body.querySelectorAll('iframe').forEach(f => f.remove()); window.__relays = []; window.__sets = []; window.__modals = []; var f = document.createElement('iframe'); f.style.cssText = 'width:440px;height:700px;border:0'; f.src = src; document.body.appendChild(f); }, src);
    await hp.waitForTimeout(500);
    return hp.frames()[1];
  };
  let fr = await mount(faceUrl(MNT));
  ok(!(await fr.isVisible('#app')), 'face never shows editor markup');
  const g = await fr.$$eval('.sv-g', x => x.map(e => e.textContent));
  ok(JSON.stringify(g) === '["Overdue","Due now"]', 'groups: Overdue then Due now', g);
  ok(await fr.isVisible('text=1 upcoming'), 'upcoming summarized in one line');
  ok((await fr.$$eval('.sv-uc', x => x.length)) === 3 && (await fr.$$eval('.sv-uc.on', x => x.length)) === 1, 'unit chips: one done, two open');
  ok(await fr.isVisible('text=Technician'), 'owner shown on the task');
  ok(!(await fr.$('input,textarea,select')), 'card face has no input fields (one-tap only)');
  await fr.click('.sv-t.over .sv-chk');
  await hp.waitForTimeout(900);
  let rel = await hp.evaluate(() => window.__relays.filter(r => r.type === 'save').pop());
  ok(rel && rel.data.mnt.k[0].ld === todayStr && rel.data.mnt.h[0].by === 'Steven L.', 'tap: relayed save to the connector with date + member', rel && rel.data.mnt.h);
  ok(await hp.evaluate(() => window.__sets.some(s => s.data.mnt)), 'tap: direct t.set also attempted');
  ok(await fr.isVisible('.sv-g >> text=Done today'), 'done task moves to Done today');
  await fr.click('.sv-t.done .sv-chk'); await hp.waitForTimeout(900);
  rel = await hp.evaluate(() => window.__relays.filter(r => r.type === 'save').pop());
  ok(rel.data.mnt.k[0].ld === MNT.k[0].ld && rel.data.mnt.h.length === 0, 'tap again: undo restores the old date');
  await fr.click('.sv-uc[data-u="Prusa XL"]'); await hp.waitForTimeout(900);
  rel = await hp.evaluate(() => window.__relays.filter(r => r.type === 'save').pop());
  ok(rel.data.mnt.k[1].lu['Prusa XL'] === todayStr && rel.data.mnt.h[0].u[0] === 'Prusa XL', 'unit chip logs that unit only');
  await fr.click('.sv-t.due .sv-chk'); await hp.waitForTimeout(900);
  rel = await hp.evaluate(() => window.__relays.filter(r => r.type === 'save').pop());
  ok(rel.data.mnt.k[1].lu['X1C #2'] === todayStr, 'checkbox on a per-unit task logs the remaining units');
  await fr.click('[data-a="flag"][data-k="a"]'); await hp.waitForTimeout(900);
  rel = await hp.evaluate(() => window.__relays.filter(r => r.type === 'save').pop());
  ok(rel.data.mnt.fl.length === 1 && rel.data.mnt.q.length === 1, 'flag icon: open issue + queued comment');
  ok(await fr.isVisible('text=Open issues'), 'open issue shown at the top of the face');
  await fr.click('[data-a="note"][data-k="a"]'); await hp.waitForTimeout(200);
  const mo = await hp.evaluate(() => window.__modals.pop());
  ok(mo && /view=editor/.test(mo.url) && /task=a/.test(mo.url) && /do=log/.test(mo.url), 'note icon hands off to the expanded view at that task', mo);
  fr = await mount(faceUrl(null));
  ok(await fr.isVisible('text=No maintenance routine'), 'empty card: plain "No maintenance routine"');
  await fr.click('[data-a="add"]'); await hp.waitForTimeout(200);
  ok(/view=editor/.test((await hp.evaluate(() => window.__modals.pop()) || {}).url || ''), 'Add routine opens the expanded view');
  await hp.evaluate(() => document.documentElement.setAttribute('data-color-mode','light'));

  /* ===== 5. connector ===== */
  console.log('\nConnector');
  await hp.evaluate(m => { window.__store = {card:{mnt:m}, board:{}}; }, MNT);
  fr = await mount(BASE + '/' + FILE);
  const caps = await hp.evaluate(() => Object.keys(window.__caps || {}));
  ok(['card-badges','card-back-section','board-buttons'].every(c => caps.indexOf(c) >= 0), 'capabilities registered', caps);
  const cb = await hp.evaluate(async () => { var t = window.__capT; var a = await window.__caps['card-back-section'](t); var b = await window.__caps['card-back-section'](t); var bd = await window.__caps['card-badges'](t); var bb = window.__caps['board-buttons'](t); return {a:a.url||a.content.url, b:b.content.url, title:a.title, h:a.content.height, badges:bd.map(function(x){ return x.text; }), bb:bb[0].text}; });
  ok(cb.a === cb.b && !/cb=/.test(cb.a), 'identical data -> identical face URL (no cache-buster)');
  ok(cb.title === 'TF-Maintain v' + ver, 'section title carries the version', cb.title);
  ok(cb.h > 150 && cb.h <= 720, 'face height estimate: ' + cb.h);
  ok(JSON.stringify(cb.badges) === '["1 overdue","1 due"]', 'connector badges', cb.badges);
  ok(cb.bb === 'TF-Maintain', 'board button');
  await hp.evaluate(() => { window.__store.card = {}; });
  const empty = await hp.evaluate(async () => { var t = window.__capT; var a = await window.__caps['card-back-section'](t); var bd = await window.__caps['card-badges'](t); return {h:a.content.height, n:bd.length}; });
  ok(empty.n === 0 && empty.h <= 50, 'card without a routine: no badge, compact face');
  // relay save -> connector writes
  await hp.evaluate(() => { window.__sets = []; new BroadcastChannel('tf-maint').postMessage({type:'save', data:{mnt:{v:1,k:[],u:[],h:[],fl:[],q:[]}}}); });
  await hp.waitForTimeout(200);
  ok(await hp.evaluate(() => window.__sets.some(s => s.data.mnt)), 'connector performs relayed saves');
  // comment queue flush
  const fl = await fr.evaluate(async () => {
    CONFIG.APP_KEY = 'testkey'; window.top.__authorized = true;
    var m = {v:1, k:[], u:[], h:[], fl:[], q:[{i:100, x:'first'}, {i:200, x:'second'}]};
    var h = await flushQueue(window.top.__capT, m, 100);
    return {h:h, mntq: window.top.__store.card.mntq};
  });
  ok(fl.h === 200 && fl.mntq && fl.mntq.h === 200, 'flush posts only unposted comments and records the high-water mark', fl);
  ok(posted.length === 1 && posted[0].method === 'POST' && /cards\/card1\/actions\/comments/.test(posted[0].url) && /text=second/.test(posted[0].url), 'comment POSTed to the card', posted);

  /* ===== 6. dashboard (standalone demo data) ===== */
  console.log('\nDashboard');
  const dp = await ctx.newPage(); dp.on('pageerror', e => errors.push('dash: ' + e.message));
  await dp.goto(BASE + '/' + FILE);
  await dp.evaluate(m => localStorage.setItem('tf-maintain-card', JSON.stringify(m)), MNT);
  await dp.goto(BASE + '/' + FILE + '?view=dash');
  ok(await dp.isVisible('#dashView') && !(await dp.isVisible('#app')), 'dashboard view');
  ok(/1 overdue · 1 due/.test(await dp.textContent('.dsum')), 'dashboard counts', await dp.textContent('.dsum'));
  await dp.selectOption('#dOwner', 'Technician');
  ok((await dp.$$eval('tbody tr', r => r.length)) === 1, 'owner filter');
  await dp.click('#dSite button[data-v="as"]');
  ok(/Nothing open/.test(await dp.textContent('tbody')), 'site filter (Davis card hidden under Aggie Square)');

  /* screenshots for a human glance */
  const shots = path.join(ROOT, 'test', 'shots'); fs.mkdirSync(shots, {recursive:true});
  fr = await mount(faceUrl(MNT)); await hp.evaluate(() => { document.body.style.background = '#1d2125'; });
  await hp.screenshot({path: path.join(shots, 'face.png'), clip:{x:0, y:0, width:460, height:420}});
  await page.goto(BASE + '/' + FILE); await page.evaluate(m => { localStorage.setItem('tf-maintain-card', JSON.stringify(m)); }, MNT);
  await page.goto(BASE + '/' + FILE); await page.screenshot({path: path.join(shots, 'editor.png'), fullPage:true});
  await dp.click('#dSite button[data-v="all"]'); await dp.selectOption('#dOwner', 'all'); await dp.screenshot({path: path.join(shots, 'dash.png')});

  ok(errors.length === 0, 'no page errors', errors);
  await browser.close(); server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
