'use strict';

// Owner dashboard: reads the orders every outlet's iPad uploads to Supabase.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => (s / 100).toFixed(2);
const pad = (n, w = 3) => String(n).padStart(w, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
const timeStr = (ts) => { const d = new Date(ts); return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`; };
const lineUnit = (l) => l.base + (l.opts || []).reduce((a, o) => a + o.delta, 0);

const METHODS = { cash: '现金 Cash', qr: 'QR', visa: 'Visa', master: 'Master', debit: 'Debit', bank: 'Bank In' };
const MODES = { dine: '堂食', take: '外带', mixed: '混合' };
const STATUS = { open: '未付 Unpaid', paid: '已付 Paid', void: '作废 Void' };

const sb = supabase.createClient(CLOUD.url, CLOUD.key);
let state = { day: dayKey(), outlet: 'all', orders: [], outlets: [] };
let refreshTimer;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- login ----------
function renderLogin(mode = 'in', note = '') {
  $('#who').innerHTML = '';
  $('#main').innerHTML = `
    <div class="page"><div class="panel login">
      <h3>${mode === 'in' ? '登入 Sign in' : '第一次使用：建立账号 Create account'}</h3>
      ${note ? `<div class="warn">${note}</div>` : ''}
      <label class="field"><span>Email</span><input id="email" type="email" autocomplete="username"></label>
      <label class="field"><span>密码 Password</span><input id="pw" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}"></label>
      <button class="btn primary" id="go">${mode === 'in' ? '登入 Sign in' : '建立账号 Create'}</button>
      <p class="muted" style="margin-top:12px">${mode === 'in'
        ? '第一次用？<a href="#" class="link" id="switch">建立账号</a>'
        : '已经有账号？<a href="#" class="link" id="switch">登入</a>'}</p>
    </div></div>`;
  $('#switch').onclick = (e) => { e.preventDefault(); renderLogin(mode === 'in' ? 'up' : 'in'); };
  $('#go').onclick = async () => {
    const email = $('#email').value.trim(), password = $('#pw').value;
    if (!email || !password) return;
    $('#go').disabled = true;
    if (mode === 'in') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) renderLogin('in', /confirm/i.test(error.message) ? '请先到 email 点确认链接 · Confirm your email first' : '登入失败 · ' + esc(error.message));
    } else {
      const { error } = await sb.auth.signUp({ email, password });
      if (error) renderLogin('up', esc(error.message));
      else renderLogin('in', '已寄出确认 email。点 email 里的链接确认后（打开的页面显示错误也没关系），回到这里登入。<br>Check your email and click the link, then sign in here.');
    }
  };
}

// ---------- data ----------
async function load() {
  let q = sb.from('pos_orders').select('*').eq('day', state.day).order('created_at', { ascending: false });
  if (state.outlet !== 'all') q = q.eq('outlet_id', state.outlet);
  const [{ data: orders, error }, { data: last }] = await Promise.all([
    q,
    sb.from('pos_orders').select('outlet_id, synced_at').order('synced_at', { ascending: false }).limit(200),
  ]);
  if (error) { toast('读取失败 ' + error.message); return; }
  state.orders = orders || [];
  state.lastSync = {};
  for (const r of last || []) state.lastSync[r.outlet_id] ||= r.synced_at;
  render();
}

function summarize(orders) {
  const paid = orders.filter((o) => o.status === 'paid');
  const r = { count: paid.length, sales: 0, subtotal: 0, takeaway: 0, sc: 0, sst: 0, rounding: 0, methods: {}, items: {}, modes: {} };
  for (const o of paid) {
    const t = o.totals;
    r.sales += t.paid ?? t.total; r.subtotal += t.subtotal; r.takeaway += t.takeaway; r.sc += t.sc; r.sst += t.sst; r.rounding += t.rounding || 0;
    const m = (r.methods[o.payment?.method] ||= { n: 0, amt: 0 });
    m.n++; m.amt += t.paid ?? t.total;
    const md = (r.modes[o.mode] ||= { n: 0, amt: 0 });
    md.n++; md.amt += t.paid ?? t.total;
    for (const l of o.lines) {
      const it = (r.items[l.itemId] ||= { code: l.code, zh: l.zh, qty: 0, amt: 0 });
      it.qty += l.qty; it.amt += lineUnit(l) * l.qty;
    }
  }
  return r;
}

// ---------- render ----------
function render() {
  const all = state.orders;
  const r = summarize(all);
  const open = all.filter((o) => o.status === 'open').length;
  const voids = all.filter((o) => o.status === 'void').length;
  const outletName = (id) => OUTLETS.find((o) => o.id === id)?.name || id;
  const perOutlet = OUTLETS.map((o) => ({ ...o, s: summarize(all.filter((x) => x.outlet_id === o.id)) }));
  const items = Object.values(r.items).sort((a, b) => b.qty - a.qty);
  const fresh = (ts) => ts && Date.now() - new Date(ts).getTime() < 10 * 60 * 1000;

  $('#main').innerHTML = `
  <div class="page">
    <div class="page-head">
      <input type="date" id="day" value="${state.day}">
      <div class="seg small" id="outletSeg">
        <button data-o="all" class="${state.outlet === 'all' ? 'active' : ''}">全部 All</button>
        ${OUTLETS.map((o) => `<button data-o="${o.id}" class="${state.outlet === o.id ? 'active' : ''}">${esc(o.name)}</button>`).join('')}
      </div>
      <div class="spacer"></div>
      <button class="btn ghost" id="refresh">刷新 Refresh</button>
    </div>
    ${open ? `<div class="warn">${open} 张挂单还没结账 · unpaid, not counted in sales</div>` : ''}
    <div class="cards">
      <div class="card hl"><div class="k">营业额 Sales</div><div class="v">RM ${fmt(r.sales)}</div></div>
      <div class="card"><div class="k">订单 Orders</div><div class="v">${r.count}</div></div>
      <div class="card"><div class="k">平均 Avg / order</div><div class="v">${r.count ? fmt(Math.round(r.sales / r.count)) : '0.00'}</div></div>
      <div class="card"><div class="k">作废 Voided</div><div class="v">${voids}</div></div>
    </div>
    ${state.outlet === 'all' ? `<div class="panel"><h3>分店 Outlets</h3><table>
      <tr><th>分店</th><th class="r">单数</th><th class="r">营业额 RM</th><th class="r">最后上传 Last upload</th></tr>
      ${perOutlet.map((o) => `<tr><td><span class="outlet-dot ${fresh(state.lastSync[o.id]) ? 'on' : ''}"></span>${esc(o.name)}</td>
        <td class="r">${o.s.count}</td><td class="r">${fmt(o.s.sales)}</td>
        <td class="r">${state.lastSync[o.id] ? new Date(state.lastSync[o.id]).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td></tr>`).join('')}
    </table></div>` : ''}
    <div class="cols">
      <div>
        <div class="panel"><h3>收款方式 By payment</h3><table>
          ${Object.entries(METHODS).map(([id, name]) => { const x = r.methods[id] || { n: 0, amt: 0 }; return `<tr><td>${name}</td><td class="r">${x.n}</td><td class="r">${fmt(x.amt)}</td></tr>`; }).join('')}
          <tr><th>合计</th><th class="r">${r.count}</th><th class="r">${fmt(r.sales)}</th></tr>
        </table></div>
        <div class="panel"><h3>明细 Breakdown</h3><table>
          <tr><td>小计 Subtotal</td><td class="r">${fmt(r.subtotal)}</td></tr>
          <tr><td>外带费 Takeaway</td><td class="r">${fmt(r.takeaway)}</td></tr>
          <tr><td>服务费 Service</td><td class="r">${fmt(r.sc)}</td></tr>
          <tr><td>SST</td><td class="r">${fmt(r.sst)}</td></tr>
          <tr><td>进位 Rounding</td><td class="r">${fmt(r.rounding)}</td></tr>
          ${Object.entries(MODES).map(([id, name]) => { const x = r.modes[id] || { n: 0, amt: 0 }; return `<tr><td class="muted">${name}</td><td class="r muted">${x.n} 单 · ${fmt(x.amt)}</td></tr>`; }).join('')}
        </table></div>
      </div>
      <div class="panel"><h3>销量 Items sold</h3>${items.length ? `<table>
        <tr><th>编号</th><th>品项</th><th class="r">数量</th><th class="r">RM</th></tr>
        ${items.map((i) => `<tr><td>${esc(i.code || '')}</td><td>${esc(i.zh)}</td><td class="r">${i.qty}</td><td class="r">${fmt(i.amt)}</td></tr>`).join('')}
      </table>` : '<div class="empty">还没有销售 No sales yet</div>'}</div>
    </div>
    <div class="panel"><h3>订单 Orders (${all.length})</h3>
      <div class="order-list">${all.length ? all.map((o) => `
        <div class="order-row">
          <span class="no">#${pad(o.no)}</span>
          <span class="hide-sm">${esc(outletName(o.outlet_id))}</span>
          <span class="hide-sm">${o.created_at ? timeStr(o.created_at) : ''}<br><small>${MODES[o.mode] || ''}</small></span>
          <span class="sum">${o.label ? `<b>${esc(o.label)}</b> · ` : ''}${o.lines.map((l) => `${l.qty}×${esc(l.code || l.zh)}`).join(', ')}</span>
          <span class="pill ${o.status}">${STATUS[o.status]}${o.payment ? ' · ' + (METHODS[o.payment.method] || '') : ''}</span>
          <span class="amt">${fmt(o.totals.paid ?? o.totals.total)}</span>
        </div>`).join('') : '<div class="empty">没有订单 No orders</div>'}</div>
    </div>
    <p class="muted">每分钟自动刷新 · Refreshes every minute. 分店 iPad 有网络时才会上传。</p>
  </div>`;

  $('#day').onchange = (e) => { state.day = e.target.value || dayKey(); load(); };
  $('#outletSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.outlet = b.dataset.o; load(); } };
  $('#refresh').onclick = () => { load(); toast('已刷新 Refreshed'); };
}

// ---------- start ----------
async function start(session) {
  clearInterval(refreshTimer);
  if (!session) { renderLogin(); return; }
  const { data: isAdmin } = await sb.rpc('pos_is_admin');
  $('#who').innerHTML = `<small style="color:#f4d9b5">${esc(session.user.email)}</small> <button class="btn ghost" id="logout" style="padding:6px 10px;font-size:13px">登出</button>`;
  $('#logout').onclick = () => sb.auth.signOut();
  if (!isAdmin) {
    $('#main').innerHTML = '<div class="page"><div class="panel login"><h3>没有权限</h3><p>这个 email 不能查看后台。请联系管理员。<br>This email has no access.</p></div></div>';
    return;
  }
  await load();
  refreshTimer = setInterval(load, 60000);
}

sb.auth.onAuthStateChange((_event, session) => { start(session); });
