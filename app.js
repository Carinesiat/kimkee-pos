'use strict';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// All money is kept in sen (integer) to avoid floating point errors.
const toSen = (rm) => Math.round(Number(rm) * 100);
const fmt = (s) => (s / 100).toFixed(2);
const RM = (s) => 'RM ' + fmt(s);
const pad = (n, w = 3) => String(n).padStart(w, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
const timeStr = (ts) => { const d = new Date(ts); return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`; };
const dateTimeStr = (ts) => { const d = new Date(ts); return `${dayKey(d)} ${timeStr(ts)}`; };

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { return null; }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------- settings ----------
const PAYMENT_METHODS = [
  { id: 'cash', zh: '现金', en: 'Cash' },
  { id: 'qr', zh: 'QR', en: 'DuitNow / TNG' },
  { id: 'visa', zh: 'Visa', en: 'Card' },
  { id: 'master', zh: 'Master', en: 'Card' },
  { id: 'debit', zh: 'Debit', en: 'Card' },
  { id: 'bank', zh: 'Bank In', en: 'Transfer' },
];
const methodName = (id) => { const m = PAYMENT_METHODS.find((x) => x.id === id); return m ? m.zh : id; };

const DEFAULT_SETTINGS = {
  shopName: '金記麵家 Kim Kee Noodle',
  shopAddr: '',
  shopFooter: '欢迎下次光临 Please Come Again',
  sstRate: 6,
  scRate: 10,
  takeawayFee: 0.5,
  sstOnSc: false,
  cashRounding: true,
  overrides: {}, // item id -> { price (RM), off (sold out) }
};
let settings = Object.assign({}, DEFAULT_SETTINGS, store('pos.settings') || {});
const saveSettings = () => store('pos.settings', settings);

// ---------- menu index ----------
const ITEMS = {};
for (const cat of CATEGORIES) {
  for (const it of cat.items) {
    it.id = it.id || it.code;
    it.cat = cat.id;
    it.addon = !!(it.addon || cat.addon);
    it.groups = (it.opts || []).map((g) => (typeof g === 'string' ? { id: g, ...OPTION_GROUPS[g] } : { id: g.en, ...g }));
    ITEMS[it.id] = it;
  }
}
const itemPrice = (it) => toSen(settings.overrides[it.id]?.price ?? it.price);
const itemOff = (it) => !!settings.overrides[it.id]?.off;

// ---------- database (IndexedDB) ----------
const DB = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kimkee-pos', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('orders', { keyPath: 'id' });
        s.createIndex('day', 'day');
        s.createIndex('status', 'status');
      };
      r.onsuccess = () => { this.db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async put(o) {
    const t = this.db.transaction('orders', 'readwrite');
    t.objectStore('orders').put(o);
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  },
  get(id) { return this.req(this.db.transaction('orders').objectStore('orders').get(id)); },
  byDay(day) { return this.req(this.db.transaction('orders').objectStore('orders').index('day').getAll(day)); },
  byStatus(st) { return this.req(this.db.transaction('orders').objectStore('orders').index('status').getAll(st)); },
  all() { return this.req(this.db.transaction('orders').objectStore('orders').getAll()); },
};

async function nextOrderNo(day) {
  const list = await DB.byDay(day);
  return list.reduce((m, o) => Math.max(m, o.no), 0) + 1;
}

// ---------- pricing ----------
const lineUnit = (l) => l.base + l.opts.reduce((a, o) => a + o.delta, 0);

function calcTotals(lines, mode, st = settings) {
  let subtotal = 0, count = 0;
  for (const l of lines) {
    subtotal += lineUnit(l) * l.qty;
    if (!l.addon) count += l.qty;
  }
  const takeaway = mode === 'take' ? count * toSen(st.takeawayFee) : 0;
  const sc = mode === 'dine' ? Math.round(subtotal * st.scRate / 100) : 0;
  const sst = Math.round((subtotal + takeaway + (st.sstOnSc ? sc : 0)) * st.sstRate / 100);
  const total = subtotal + takeaway + sc + sst;
  return { subtotal, takeaway, sc, sst, total };
}

// Malaysian cash rounding to the nearest 5 sen.
const cashRound = (total) => (settings.cashRounding ? Math.round(total / 5) * 5 : total);

const rateSnapshot = () => ({ sstRate: settings.sstRate, scRate: settings.scRate, takeawayFee: settings.takeawayFee, sstOnSc: settings.sstOnSc });

// ---------- cart ----------
let cart = store('pos.cart') || { mode: 'dine', lines: [], orderId: null, label: '' };
const saveCart = () => store('pos.cart', cart);
let lineSeq = Date.now();

function lineKey(l) { return l.itemId + '|' + l.opts.map((o) => o.zh).join(',') + '|' + l.note; }

function addLine(line) {
  const k = lineKey(line);
  const same = cart.lines.find((l) => lineKey(l) === k);
  if (same) same.qty += line.qty;
  else cart.lines.push(line);
  saveCart();
  renderCart();
}

function makeLine(it, opts = [], note = '', qty = 1) {
  return { lid: ++lineSeq, itemId: it.id, code: it.code, zh: it.zh, en: it.en, base: itemPrice(it), addon: it.addon, opts, note, qty };
}

function clearCart() {
  // Every new order starts as dine-in so a takeaway charge is never carried over by mistake.
  cart = { mode: 'dine', lines: [], orderId: null, label: '' };
  saveCart();
  renderCart();
}

// ---------- order view ----------
let currentCat = CATEGORIES[0].id;

function renderCats() {
  $('#catList').innerHTML = CATEGORIES.map((c) =>
    `<button data-cat="${c.id}" class="${c.id === currentCat && !searchQuery() ? 'active' : ''}">${esc(c.zh)}<small>${esc(c.en)}</small></button>`).join('');
}

const searchQuery = () => $('#search').value.trim();

function searchItems(q) {
  const u = q.toUpperCase(), l = q.toLowerCase();
  const all = Object.values(ITEMS);
  const exact = all.filter((it) => it.code && it.code.toUpperCase() === u);
  const prefix = all.filter((it) => it.code && it.code.toUpperCase().startsWith(u) && !exact.includes(it));
  const name = all.filter((it) => !exact.includes(it) && !prefix.includes(it) && (it.zh.includes(q) || it.en.toLowerCase().includes(l)));
  return [...exact, ...prefix, ...name];
}

function renderItems() {
  const q = searchQuery();
  $('#searchClear').classList.toggle('hidden', !q);
  const cat = CATEGORIES.find((c) => c.id === currentCat);
  const items = q ? searchItems(q) : cat.items;
  $('#catNote').textContent = q ? `搜索 "${q}" · ${items.length} 项` : (cat.note || '');
  $('#itemGrid').innerHTML = items.length ? items.map((it) => `
    <button class="item ${itemOff(it) ? 'off' : ''}" data-id="${esc(it.id)}">
      <span class="code ${it.code ? '' : 'none'}">${esc(it.code || '+')}</span>
      ${it.groups.length ? '<span class="more">选项 ›</span>' : ''}
      <span class="zh">${esc(it.zh)}</span>
      <span class="en">${esc(it.en)}</span>
      <span class="foot"><span class="price">${fmt(itemPrice(it))}</span><span class="tag">${esc(it.note || '')}</span></span>
    </button>`).join('') : '<div class="empty">找不到 No match</div>';
}

function onItemTap(id) {
  const it = ITEMS[id];
  if (!it) return;
  if (itemOff(it)) { toast(`${it.zh} 已停售 Sold out`); return; }
  if (it.groups.length) openItemSheet(it);
  else { addLine(makeLine(it)); toast(`+1 ${it.code ? it.code + ' ' : ''}${it.zh}`); }
}

function renderCart() {
  $$('#modeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === cart.mode));
  const count = cart.lines.reduce((a, l) => a + l.qty, 0);
  $('#cartMeta').innerHTML = `<span>${cart.orderId ? `<b>挂单 #${esc(cart.orderId.split('-').pop())}</b>${cart.label ? ' · ' + esc(cart.label) : ''}` : '新订单 New order'}</span><span>${count} 件 items</span>`;

  $('#cartLines').innerHTML = cart.lines.length ? cart.lines.map((l) => `
    <div class="line" data-lid="${l.lid}">
      <div class="info" data-act="edit">
        <div class="name">${l.code ? `<span class="c">${esc(l.code)}</span>` : ''}${esc(l.zh)}</div>
        ${l.opts.length ? `<div class="opts">${l.opts.map((o) => esc(o.zh) + (o.delta ? ` +${fmt(o.delta)}` : '')).join(' · ')}</div>` : ''}
        ${l.note ? `<div class="note">✎ ${esc(l.note)}</div>` : ''}
        <div class="qty"><button data-act="dec">−</button><span>${l.qty}</span><button data-act="inc">+</button></div>
      </div>
      <div class="amt">${fmt(lineUnit(l) * l.qty)}</div>
    </div>`).join('') : '<div class="cart-empty">点左边的菜加入订单<br><small>Tap an item to add</small></div>';

  const t = calcTotals(cart.lines, cart.mode);
  $('#cartTotals').innerHTML = `
    <div class="row muted"><span>小计 Subtotal</span><span>${fmt(t.subtotal)}</span></div>
    ${cart.mode === 'take' ? `<div class="row muted"><span>外带费 Takeaway</span><span>${fmt(t.takeaway)}</span></div>` : ''}
    ${cart.mode === 'dine' ? `<div class="row muted"><span>服务费 Service ${settings.scRate}%</span><span>${fmt(t.sc)}</span></div>` : ''}
    <div class="row muted"><span>SST ${settings.sstRate}%</span><span>${fmt(t.sst)}</span></div>
    <div class="row total"><span>总计 Total</span><span>${RM(t.total)}</span></div>`;
  $('#btnPay').disabled = !cart.lines.length;
}

// ---------- modal ----------
function openModal(html, cls = '') {
  const sheet = $('#sheet');
  sheet.className = 'sheet ' + cls;
  sheet.onclick = null; // the sheet element is reused; drop the previous sheet's handler
  sheet.innerHTML = html;
  $('#modal').classList.remove('hidden');
  return sheet;
}
function closeModal() { $('#modal').classList.add('hidden'); $('#sheet').onclick = null; $('#sheet').innerHTML = ''; }

function confirmSheet(title, sub, okLabel, onOk, danger = false) {
  const s = openModal(`
    <div class="sheet-head"><h3>${esc(title)}</h3>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
    <div class="sheet-foot"><div class="spacer"></div>
      <button class="btn ghost" data-x>取消 Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`);
  $('[data-x]', s).onclick = closeModal;
  $('[data-ok]', s).onclick = () => { closeModal(); onOk(); };
}

// Item sheet: choose options, qty and note. Used for adding and for editing a cart line.
function openItemSheet(it, line) {
  const sel = it.groups.map((g) => {
    if (!line) return -1;
    const o = line.opts.find((x) => x.g === g.id);
    return o ? g.choices.findIndex((c) => c.zh === o.zh) : -1;
  });
  let qty = line ? line.qty : 1;
  let note = line ? line.note : '';

  const s = openModal(`
    <div class="sheet-head"><h3>${it.code ? esc(it.code) + ' · ' : ''}${esc(it.zh)}</h3><div class="sub">${esc(it.en)} · ${RM(line ? line.base : itemPrice(it))}</div></div>
    <div class="sheet-body">
      ${it.groups.map((g, gi) => `
        <div class="group"><div class="group-title">${esc(g.zh)} <small>${esc(g.en)}</small><span class="req">必选 Required</span></div>
          <div class="chips">${g.choices.map((c, ci) => `<button class="chip" data-g="${gi}" data-c="${ci}">${esc(c.zh)}${c.price ? `<span class="delta">+${fmt(toSen(c.price))}</span>` : ''}<small>${esc(c.en)}</small></button>`).join('')}</div>
        </div>`).join('')}
      <div class="group"><div class="group-title">备注 <small>Note</small></div>
        <div class="chips" style="margin-bottom:8px">${QUICK_NOTES.map((n) => `<button class="chip small" data-qn="${esc(n.split(' ')[0])}">${esc(n)}</button>`).join('')}</div>
        <label class="field"><input id="noteInput" value="${esc(note)}" placeholder="例如：不要葱 / 少辣"></label>
      </div>
    </div>
    <div class="sheet-foot">
      <div class="stepper"><button data-q="-1">−</button><span id="qtyVal">${qty}</span><button data-q="1">+</button></div>
      <div class="spacer"></div>
      ${line ? '<button class="btn danger" data-del>删除 Remove</button>' : ''}
      <button class="btn ghost" data-x>取消</button>
      <button class="btn primary" data-ok></button>
    </div>`);

  const ok = $('[data-ok]', s);
  const sync = () => {
    $$('.chip[data-g]', s).forEach((b) => b.classList.toggle('on', sel[+b.dataset.g] === +b.dataset.c));
    const base = line ? line.base : itemPrice(it);
    const delta = sel.reduce((a, ci, gi) => a + (ci >= 0 ? toSen(it.groups[gi].choices[ci].price || 0) : 0), 0);
    const ready = sel.every((ci) => ci >= 0);
    ok.disabled = !ready;
    ok.innerHTML = `${line ? '保存 Save' : '加入 Add'}<small>${RM((base + delta) * qty)}</small>`;
    $('#qtyVal', s).textContent = qty;
    const noteVal = $('#noteInput', s).value;
    $$('[data-qn]', s).forEach((b) => b.classList.toggle('on', noteVal.split(/[,，]\s*/).includes(b.dataset.qn)));
  };
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.g !== undefined) { sel[+b.dataset.g] = +b.dataset.c; sync(); }
    else if (b.dataset.q) { qty = Math.max(1, qty + +b.dataset.q); sync(); }
    else if (b.dataset.qn) {
      const inp = $('#noteInput', s);
      const parts = inp.value.split(/[,，]\s*/).filter(Boolean);
      const i = parts.indexOf(b.dataset.qn);
      if (i >= 0) parts.splice(i, 1); else parts.push(b.dataset.qn);
      inp.value = parts.join(', ');
      sync();
    } else if (b.hasAttribute('data-x')) closeModal();
    else if (b.hasAttribute('data-del')) {
      cart.lines = cart.lines.filter((l) => l !== line);
      saveCart(); renderCart(); closeModal();
    } else if (b === ok && !ok.disabled) {
      const opts = sel.map((ci, gi) => {
        const g = it.groups[gi], c = g.choices[ci];
        return { g: g.id, zh: c.zh, en: c.en, delta: toSen(c.price || 0) };
      });
      note = $('#noteInput', s).value.trim();
      if (line) {
        Object.assign(line, { opts, note, qty });
        saveCart(); renderCart();
      } else {
        addLine(makeLine(it, opts, note, qty));
        toast(`+${qty} ${it.code ? it.code + ' ' : ''}${it.zh}`);
      }
      closeModal();
    }
  };
  $('#noteInput', s).oninput = sync;
  sync();
}

// ---------- hold & pay ----------
function buildOrder(base) {
  const totals = calcTotals(cart.lines, cart.mode);
  return Object.assign(base, {
    mode: cart.mode,
    label: cart.label || '',
    lines: cart.lines.map((l) => ({ ...l })),
    totals,
    rates: rateSnapshot(),
    updatedAt: Date.now(),
  });
}

async function ensureOrderBase() {
  if (cart.orderId) {
    const existing = await DB.get(cart.orderId);
    if (existing && existing.status === 'open') return existing;
  }
  const day = dayKey();
  const no = await nextOrderNo(day);
  return { id: `${day}-${pad(no)}`, day, no, createdAt: Date.now(), status: 'open' };
}

function holdOrder() {
  if (!cart.lines.length) { toast('订单是空的 Order is empty'); return; }
  const s = openModal(`
    <div class="sheet-head"><h3>挂单 Hold order</h3><div class="sub">先保存，客人吃完再结账 · Save now, pay later</div></div>
    <div class="sheet-body">
      <label class="field"><span>备注 / 客人 <small>Label (optional)</small></span>
        <input id="holdLabel" value="${esc(cart.label)}" placeholder="例如：靠窗 / 穿红衣 / 陈先生"></label>
    </div>
    <div class="sheet-foot"><div class="spacer"></div>
      <button class="btn ghost" data-x>取消</button>
      <button class="btn gold" data-ok>保存挂单 Save</button></div>`);
  $('[data-x]', s).onclick = closeModal;
  $('[data-ok]', s).onclick = async () => {
    cart.label = $('#holdLabel', s).value.trim();
    const order = buildOrder(await ensureOrderBase());
    await DB.put(order);
    closeModal();
    toast(`已挂单 #${pad(order.no)}`);
    clearCart();
    refreshOpenBadge();
  };
}

function openPaySheet() {
  if (!cart.lines.length) return;
  const t = calcTotals(cart.lines, cart.mode);
  let method = null;
  let tendered = '';

  const s = openModal(`
    <div class="sheet-head"><h3>结账 Payment</h3><div class="sub">${cart.mode === 'dine' ? '堂食 Dine-in' : '外带 Takeaway'} · ${cart.lines.reduce((a, l) => a + l.qty, 0)} 件 items</div></div>
    <div class="sheet-body">
      <div class="pay-total"><div class="big" id="payBig">${RM(t.total)}</div><div id="payRound" class="sub"></div></div>
      <div class="methods">${PAYMENT_METHODS.map((m) => `<button class="chip" data-m="${m.id}">${esc(m.zh)}<small>${esc(m.en)}</small></button>`).join('')}</div>
      <div class="cash-box hidden" id="cashBox">
        <label class="field" style="margin:0"><span>收到 <small>Cash received (RM)</small></span>
          <input id="tendered" inputmode="decimal" placeholder="0.00"></label>
        <div class="quick">
          <button data-t="exact">刚好<br><small>Exact</small></button>
          <button data-t="10">10</button><button data-t="20">20</button><button data-t="50">50</button><button data-t="100">100</button>
        </div>
        <div class="change" id="changeRow"><span>找零 Change</span><b>—</b></div>
      </div>
    </div>
    <div class="sheet-foot"><div class="spacer"></div>
      <button class="btn ghost" data-x>取消</button>
      <button class="btn primary" data-ok disabled>确认收款 Confirm</button></div>`);

  const due = () => (method === 'cash' ? cashRound(t.total) : t.total);
  const sync = () => {
    $$('[data-m]', s).forEach((b) => b.classList.toggle('on', b.dataset.m === method));
    $('#cashBox', s).classList.toggle('hidden', method !== 'cash');
    $('#payBig', s).textContent = RM(due());
    const r = due() - t.total;
    $('#payRound', s).textContent = method === 'cash' && r ? `含进位 Rounding ${r > 0 ? '+' : ''}${fmt(r)}` : '';
    let ready = !!method;
    if (method === 'cash') {
      const got = toSen(tendered || 0);
      const change = got - due();
      const row = $('#changeRow', s);
      row.classList.toggle('short', change < 0);
      $('b', row).textContent = tendered === '' ? '—' : (change < 0 ? `差 ${fmt(-change)}` : RM(change));
      ready = tendered !== '' && change >= 0;
    }
    $('[data-ok]', s).disabled = !ready;
  };
  s.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.m) {
      method = b.dataset.m; sync();
      if (method === 'cash') setTimeout(() => $('#tendered', s).focus(), 50);
    } else if (b.dataset.t) {
      tendered = b.dataset.t === 'exact' ? fmt(due()) : b.dataset.t;
      $('#tendered', s).value = tendered; sync();
    } else if (b.hasAttribute('data-x')) closeModal();
    else if (b.hasAttribute('data-ok') && !b.disabled) {
      b.disabled = true;
      const order = buildOrder(await ensureOrderBase());
      const payable = due();
      order.totals.rounding = payable - order.totals.total;
      order.totals.paid = payable;
      order.status = 'paid';
      order.paidAt = Date.now();
      order.payment = { method, tendered: method === 'cash' ? toSen(tendered) : payable, change: method === 'cash' ? toSen(tendered) - payable : 0 };
      await DB.put(order);
      clearCart();
      refreshOpenBadge();
      showDone(order);
    }
  };
  $('#tendered', s).oninput = (e) => { tendered = e.target.value.replace(/[^\d.]/g, ''); sync(); };
  sync();
}

function showDone(order) {
  const s = openModal(`
    <div class="sheet-body"><div class="done">
      <div class="tick">✓</div>
      <div class="no">#${pad(order.no)}</div>
      <div>${methodName(order.payment.method)} · ${RM(order.totals.paid)}</div>
      ${order.payment.method === 'cash' ? `<div class="change" style="justify-content:center;gap:14px"><span>找零 Change</span><b>${RM(order.payment.change)}</b></div>` : ''}
    </div></div>
    <div class="sheet-foot">
      <button class="btn ghost" data-print>打印收据 Print</button>
      <div class="spacer"></div>
      <button class="btn primary" data-x>新订单 New order</button></div>`);
  $('[data-print]', s).onclick = () => printReceipt(order);
  $('[data-x]', s).onclick = () => { closeModal(); $('#search').focus(); };
}

// ---------- receipt / printing ----------
function receiptHtml(o) {
  const t = o.totals;
  return `<div class="rc">
    <h1>${esc(settings.shopName)}</h1>
    ${settings.shopAddr ? `<div class="c">${esc(settings.shopAddr).replace(/\n/g, '<br>')}</div>` : ''}
    <hr>
    <div class="r"><span>单号 No. <b>#${pad(o.no)}</b></span><span>${o.mode === 'dine' ? '堂食 Dine-in' : '外带 Takeaway'}</span></div>
    <div>${dateTimeStr(o.paidAt || o.createdAt)}${o.label ? ' · ' + esc(o.label) : ''}</div>
    <hr>
    ${o.lines.map((l) => `
      <div class="r"><span>${l.qty} × ${l.code ? esc(l.code) + ' ' : ''}${esc(l.zh)}</span><span>${fmt(lineUnit(l) * l.qty)}</span></div>
      ${l.opts.length ? `<div class="s">${l.opts.map((x) => esc(x.zh)).join(' · ')}</div>` : ''}
      ${l.note ? `<div class="s">✎ ${esc(l.note)}</div>` : ''}`).join('')}
    <hr>
    <div class="r"><span>小计 Subtotal</span><span>${fmt(t.subtotal)}</span></div>
    ${t.takeaway ? `<div class="r"><span>外带费 Takeaway</span><span>${fmt(t.takeaway)}</span></div>` : ''}
    ${t.sc ? `<div class="r"><span>服务费 Service ${o.rates.scRate}%</span><span>${fmt(t.sc)}</span></div>` : ''}
    <div class="r"><span>SST ${o.rates.sstRate}%</span><span>${fmt(t.sst)}</span></div>
    ${t.rounding ? `<div class="r"><span>进位 Rounding</span><span>${fmt(t.rounding)}</span></div>` : ''}
    <div class="r t"><span>总计 TOTAL</span><span>${RM(t.paid ?? t.total)}</span></div>
    ${o.payment ? `<div class="r"><span>${methodName(o.payment.method)}</span><span>${fmt(o.payment.tendered)}</span></div>
      ${o.payment.change ? `<div class="r"><span>找零 Change</span><span>${fmt(o.payment.change)}</span></div>` : ''}` : '<div class="c">— 未付 UNPAID —</div>'}
    <hr>
    <div class="c">${esc(settings.shopFooter)}</div>
  </div>`;
}

function printHtml(html) {
  $('#printArea').innerHTML = html;
  setTimeout(() => window.print(), 50);
}
const printReceipt = (o) => printHtml(receiptHtml(o));

// ---------- orders view ----------
let ordersFilter = 'all';

async function renderOrders() {
  const day = $('#ordersDate').value || dayKey();
  let list = (await DB.byDay(day)).sort((a, b) => b.no - a.no);
  if (ordersFilter !== 'all') list = list.filter((o) => o.status === ordersFilter);
  $$('#ordersFilter button').forEach((b) => b.classList.toggle('active', b.dataset.f === ordersFilter));
  const label = { open: '未付 Unpaid', paid: '已付 Paid', void: '作废 Void' };
  $('#ordersList').innerHTML = list.length ? list.map((o) => `
    <button class="order-row" data-id="${o.id}">
      <span class="no">#${pad(o.no)}</span>
      <span>${timeStr(o.createdAt)}<br><small>${o.mode === 'dine' ? '堂食' : '外带'}</small></span>
      <span class="sum">${o.label ? `<b>${esc(o.label)}</b> · ` : ''}${o.lines.map((l) => `${l.qty}×${esc(l.code || l.zh)}`).join(', ')}</span>
      <span class="pill ${o.status}">${label[o.status]}${o.payment ? ' · ' + methodName(o.payment.method) : ''}</span>
      <span class="amt">${fmt(o.totals.paid ?? o.totals.total)}</span>
    </button>`).join('') : '<div class="empty">没有订单 No orders</div>';
}

async function openOrderDetail(id) {
  const o = await DB.get(id);
  if (!o) return;
  const s = openModal(`
    <div class="sheet-head"><h3>订单 #${pad(o.no)}</h3><div class="sub">${dateTimeStr(o.createdAt)} · ${o.mode === 'dine' ? '堂食 Dine-in' : '外带 Takeaway'}${o.label ? ' · ' + esc(o.label) : ''}</div></div>
    <div class="sheet-body">${receiptHtml(o).replace('class="rc"', 'class="rc preview"')}</div>
    <div class="sheet-foot">
      ${o.status === 'paid' ? '<button class="btn danger" data-void>作废 Void</button>' : ''}
      ${o.status === 'open' ? '<button class="btn danger" data-void>取消订单 Cancel</button>' : ''}
      <div class="spacer"></div>
      <button class="btn ghost" data-x>关闭</button>
      ${o.status !== 'void' ? '<button class="btn ghost" data-print>打印 Print</button>' : ''}
      ${o.status === 'open' ? '<button class="btn primary" data-load>继续/结账 Open</button>' : ''}
    </div>`);
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) closeModal();
    else if (b.hasAttribute('data-print')) printReceipt(o);
    else if (b.hasAttribute('data-void')) {
      confirmSheet(`作废订单 #${pad(o.no)}？`, '作废后不会计入营业额 · Voided orders are excluded from sales', '确定作废 Void', async () => {
        o.status = 'void'; o.voidedAt = Date.now();
        await DB.put(o);
        toast(`#${pad(o.no)} 已作废`);
        renderOrders(); refreshOpenBadge();
      }, true);
    } else if (b.hasAttribute('data-load')) {
      const load = () => {
        cart = { mode: o.mode, lines: o.lines.map((l) => ({ ...l })), orderId: o.id, label: o.label || '' };
        saveCart(); renderCart(); closeModal(); showView('order');
      };
      if (cart.lines.length && cart.orderId !== o.id) {
        confirmSheet('目前的订单还没处理', '载入挂单会清掉目前的订单 · Current cart will be cleared', '载入 Load', load);
      } else load();
    }
  };
}

async function refreshOpenBadge() {
  const open = (await DB.byStatus('open')).length;
  const b = $('#openBadge');
  b.textContent = open;
  b.classList.toggle('hidden', !open);
}

// ---------- report ----------
async function dayReport(day) {
  const all = await DB.byDay(day);
  const paid = all.filter((o) => o.status === 'paid');
  const r = {
    day, count: paid.length, sales: 0, subtotal: 0, takeaway: 0, sc: 0, sst: 0, rounding: 0,
    methods: {}, modes: { dine: { n: 0, amt: 0 }, take: { n: 0, amt: 0 } }, items: {},
    voids: all.filter((o) => o.status === 'void'), open: all.filter((o) => o.status === 'open'),
  };
  for (const o of paid) {
    const t = o.totals;
    r.sales += t.paid; r.subtotal += t.subtotal; r.takeaway += t.takeaway; r.sc += t.sc; r.sst += t.sst; r.rounding += t.rounding || 0;
    const m = (r.methods[o.payment.method] ||= { n: 0, amt: 0 });
    m.n++; m.amt += t.paid;
    r.modes[o.mode].n++; r.modes[o.mode].amt += t.paid;
    for (const l of o.lines) {
      const k = l.itemId;
      const it = (r.items[k] ||= { code: l.code, zh: l.zh, qty: 0, amt: 0 });
      it.qty += l.qty; it.amt += lineUnit(l) * l.qty;
    }
  }
  return r;
}

async function renderReport() {
  const day = $('#reportDate').value || dayKey();
  const r = await dayReport(day);
  const items = Object.values(r.items).sort((a, b) => b.qty - a.qty);
  $('#reportBody').innerHTML = `
    ${r.open.length ? `<div class="warn">还有 ${r.open.length} 张挂单未结账 · ${r.open.length} unpaid order(s) not included</div>` : ''}
    <div class="cards">
      <div class="card hl"><div class="k">营业额 Total sales</div><div class="v">${RM(r.sales)}</div></div>
      <div class="card"><div class="k">订单 Orders</div><div class="v">${r.count}</div></div>
      <div class="card"><div class="k">平均 Avg / order</div><div class="v">${r.count ? fmt(Math.round(r.sales / r.count)) : '0.00'}</div></div>
      <div class="card"><div class="k">作废 Voided</div><div class="v">${r.voids.length}</div></div>
    </div>
    <div class="cols">
      <div>
        <div class="panel"><h3>收款方式 By payment</h3><table>
          <tr><th>方式</th><th class="r">单数</th><th class="r">金额 RM</th></tr>
          ${PAYMENT_METHODS.map((m) => { const x = r.methods[m.id] || { n: 0, amt: 0 }; return `<tr><td>${m.zh}</td><td class="r">${x.n}</td><td class="r">${fmt(x.amt)}</td></tr>`; }).join('')}
          <tr><th>合计</th><th class="r">${r.count}</th><th class="r">${fmt(r.sales)}</th></tr>
        </table></div>
        <div class="panel"><h3>明细 Breakdown</h3><table>
          <tr><td>小计 Subtotal</td><td class="r">${fmt(r.subtotal)}</td></tr>
          <tr><td>外带费 Takeaway charge</td><td class="r">${fmt(r.takeaway)}</td></tr>
          <tr><td>服务费 Service charge</td><td class="r">${fmt(r.sc)}</td></tr>
          <tr><td>SST</td><td class="r">${fmt(r.sst)}</td></tr>
          <tr><td>进位 Rounding</td><td class="r">${fmt(r.rounding)}</td></tr>
          <tr><th>营业额 Total</th><th class="r">${fmt(r.sales)}</th></tr>
        </table></div>
        <div class="panel"><h3>堂食 / 外带</h3><table>
          <tr><td>堂食 Dine-in</td><td class="r">${r.modes.dine.n} 单</td><td class="r">${fmt(r.modes.dine.amt)}</td></tr>
          <tr><td>外带 Takeaway</td><td class="r">${r.modes.take.n} 单</td><td class="r">${fmt(r.modes.take.amt)}</td></tr>
        </table></div>
      </div>
      <div class="panel"><h3>销量 Items sold</h3>${items.length ? `<table>
        <tr><th>编号</th><th>品项</th><th class="r">数量</th><th class="r">RM</th></tr>
        ${items.map((i) => `<tr><td>${esc(i.code || '')}</td><td>${esc(i.zh)}</td><td class="r">${i.qty}</td><td class="r">${fmt(i.amt)}</td></tr>`).join('')}
      </table>` : '<div class="empty">还没有销售 No sales yet</div>'}</div>
    </div>`;
}

async function printReport() {
  const day = $('#reportDate').value || dayKey();
  const r = await dayReport(day);
  const items = Object.values(r.items).sort((a, b) => b.qty - a.qty);
  printHtml(`<div class="rc">
    <h1>${esc(settings.shopName)}</h1><div class="c">日结报表 Daily Report<br>${day}</div><hr>
    <div class="r"><span>订单 Orders</span><span>${r.count}</span></div>
    ${PAYMENT_METHODS.map((m) => { const x = r.methods[m.id]; return x ? `<div class="r"><span>${m.zh} (${x.n})</span><span>${fmt(x.amt)}</span></div>` : ''; }).join('')}
    <hr>
    <div class="r"><span>小计 Subtotal</span><span>${fmt(r.subtotal)}</span></div>
    <div class="r"><span>外带费 Takeaway</span><span>${fmt(r.takeaway)}</span></div>
    <div class="r"><span>服务费 Service</span><span>${fmt(r.sc)}</span></div>
    <div class="r"><span>SST</span><span>${fmt(r.sst)}</span></div>
    <div class="r"><span>进位 Rounding</span><span>${fmt(r.rounding)}</span></div>
    <div class="r t"><span>营业额 TOTAL</span><span>${fmt(r.sales)}</span></div>
    <div class="r"><span>作废 Voided</span><span>${r.voids.length}</span></div>
    <hr>${items.map((i) => `<div class="r"><span>${i.qty} × ${esc(i.code || '')} ${esc(i.zh)}</span><span>${fmt(i.amt)}</span></div>`).join('')}
    <hr><div class="c">打印于 ${dateTimeStr(Date.now())}</div></div>`);
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function exportCsv() {
  const day = $('#reportDate').value || dayKey();
  const list = (await DB.byDay(day)).sort((a, b) => a.no - b.no);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['单号 No', '时间 Time', '状态 Status', '堂食/外带', '付款 Payment', '编号 Code', '品项 Item', '选项 Options', '备注 Note', '数量 Qty', '单价 Unit', '金额 Amount', '订单总计 Order total']];
  for (const o of list) {
    for (const l of o.lines) {
      rows.push([o.no, timeStr(o.createdAt), o.status, o.mode === 'dine' ? 'Dine-in' : 'Takeaway', o.payment ? methodName(o.payment.method) : '',
        l.code, l.zh, l.opts.map((x) => x.zh).join(' / '), l.note, l.qty, fmt(lineUnit(l)), fmt(lineUnit(l) * l.qty), fmt(o.totals.paid ?? o.totals.total)]);
    }
  }
  // BOM so Excel opens the Chinese text correctly.
  download(`kimkee-${day}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
}

// ---------- settings view ----------
function renderSettings() {
  const ov = settings.overrides;
  $('#settingsBody').innerHTML = `
    <div class="page-head"><h2>设置 <small>Settings</small></h2><div class="spacer"></div>
      <button class="btn primary" id="btnSaveSettings">保存 Save</button></div>
    <div class="panel"><h3>店铺资料 Shop (收据上显示 shown on receipt)</h3>
      <div class="settings-grid">
        <label class="field"><span>店名 Name</span><input id="sShopName" value="${esc(settings.shopName)}"></label>
        <label class="field"><span>结尾 Footer</span><input id="sShopFooter" value="${esc(settings.shopFooter)}"></label>
      </div>
      <label class="field"><span>地址 Address</span><textarea id="sShopAddr" rows="2">${esc(settings.shopAddr)}</textarea></label>
    </div>
    <div class="panel"><h3>收费 Charges</h3>
      <div class="settings-grid">
        <label class="field"><span>SST %</span><input id="sSst" type="number" step="0.1" inputmode="decimal" value="${settings.sstRate}"></label>
        <label class="field"><span>服务费 Service charge % <small>(堂食 dine-in)</small></span><input id="sSc" type="number" step="0.1" inputmode="decimal" value="${settings.scRate}"></label>
        <label class="field"><span>外带费 Takeaway charge RM <small>(每件 per item)</small></span><input id="sTake" type="number" step="0.1" inputmode="decimal" value="${settings.takeawayFee}"></label>
      </div>
      <label class="toggle"><input type="checkbox" id="sSstOnSc" ${settings.sstOnSc ? 'checked' : ''}> SST 也算在服务费上 · Charge SST on service charge too</label>
      <label class="toggle"><input type="checkbox" id="sRound" ${settings.cashRounding ? 'checked' : ''}> 现金进位到 5 仙 · Round cash payments to nearest 5 sen</label>
    </div>
    <div class="panel"><h3>数据 Data</h3>
      <p style="margin:0 0 10px;color:var(--muted)">所有订单只保存在这台 iPad 上，建议每星期备份一次。<br>All orders live only on this iPad — back up weekly.</p>
      <button class="btn ghost" id="btnBackup">备份 Backup</button>
      <button class="btn ghost" id="btnRestore">恢复 Restore</button>
    </div>
    <div class="panel"><h3>菜单 Menu — 价格和停售 Prices & sold out</h3>
      <table class="menu-admin">
        <tr><th>编号</th><th>品项</th><th class="r">价格 RM</th><th class="r">停售</th></tr>
        ${CATEGORIES.map((c) => `<tr class="cat-row"><td colspan="4">${esc(c.zh)} ${esc(c.en)}</td></tr>` + c.items.map((it) => `
          <tr><td>${esc(it.code || '')}</td><td>${esc(it.zh)} <small>${esc(it.en)}</small></td>
            <td class="r"><input type="number" step="0.1" inputmode="decimal" data-price="${esc(it.id)}" value="${(ov[it.id]?.price ?? it.price).toFixed(2)}"></td>
            <td class="r"><input type="checkbox" data-off="${esc(it.id)}" ${ov[it.id]?.off ? 'checked' : ''}></td></tr>`).join('')).join('')}
      </table>
    </div>`;
}

function saveSettingsFromForm() {
  const num = (id, fallback) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : fallback; };
  settings.shopName = $('#sShopName').value.trim() || DEFAULT_SETTINGS.shopName;
  settings.shopFooter = $('#sShopFooter').value.trim();
  settings.shopAddr = $('#sShopAddr').value.trim();
  settings.sstRate = num('#sSst', settings.sstRate);
  settings.scRate = num('#sSc', settings.scRate);
  settings.takeawayFee = num('#sTake', settings.takeawayFee);
  settings.sstOnSc = $('#sSstOnSc').checked;
  settings.cashRounding = $('#sRound').checked;
  const ov = {};
  for (const inp of $$('[data-price]')) {
    const it = ITEMS[inp.dataset.price];
    const p = parseFloat(inp.value);
    const off = $(`[data-off="${CSS.escape(it.id)}"]`).checked;
    const entry = {};
    if (Number.isFinite(p) && p >= 0 && toSen(p) !== toSen(it.price)) entry.price = Math.round(p * 100) / 100;
    if (off) entry.off = true;
    if (Object.keys(entry).length) ov[it.id] = entry;
  }
  settings.overrides = ov;
  saveSettings();
  renderItems(); renderCart();
  toast('已保存 Saved');
}

async function backup() {
  const data = { app: 'kimkee-pos', version: 1, exportedAt: Date.now(), settings, orders: await DB.all() };
  download(`kimkee-pos-backup-${dayKey()}.json`, JSON.stringify(data), 'application/json');
}

async function restore(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'kimkee-pos' || !Array.isArray(data.orders)) throw new Error('not a backup');
    confirmSheet('恢复备份？', `${data.orders.length} 张订单会合并到这台 iPad · Orders will be merged in`, '恢复 Restore', async () => {
      for (const o of data.orders) await DB.put(o);
      if (data.settings) { settings = Object.assign({}, DEFAULT_SETTINGS, data.settings); saveSettings(); }
      renderSettings(); renderItems(); refreshOpenBadge();
      toast(`已恢复 ${data.orders.length} 张订单`);
    });
  } catch (e) {
    toast('文件不对 Not a valid backup file');
  }
}

// ---------- navigation ----------
function showView(v) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  if (v === 'orders') renderOrders();
  if (v === 'report') renderReport();
  if (v === 'settings') renderSettings();
}

function tickClock() {
  const d = new Date();
  const days = ['日', '一', '二', '三', '四', '五', '六'];
  $('#clock').textContent = `${dayKey(d)} 星期${days[d.getDay()]} ${timeStr(d)}`;
}

// ---------- wiring ----------
function wire() {
  $('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); };
  $('#catList').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    currentCat = b.dataset.cat;
    $('#search').value = '';
    renderCats(); renderItems();
    $('#itemGrid').scrollTop = 0;
  };
  $('#itemGrid').onclick = (e) => { const b = e.target.closest('.item'); if (b) onItemTap(b.dataset.id); };
  $('#search').oninput = () => { renderCats(); renderItems(); };
  // Typing a code and pressing Enter / Go adds that item straight away.
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    const q = searchQuery();
    if (!q) return;
    const res = searchItems(q);
    const exact = res.find((it) => it.code && it.code.toUpperCase() === q.toUpperCase());
    const pick = exact || (res.length === 1 ? res[0] : null);
    if (pick) { $('#search').value = ''; renderCats(); renderItems(); onItemTap(pick.id); }
  };
  $('#searchClear').onclick = () => { $('#search').value = ''; renderCats(); renderItems(); };

  $('#modeSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    cart.mode = b.dataset.mode; saveCart(); renderCart();
  };
  $('#cartLines').onclick = (e) => {
    const lineEl = e.target.closest('.line');
    if (!lineEl) return;
    const line = cart.lines.find((l) => l.lid === +lineEl.dataset.lid);
    if (!line) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'inc') { line.qty++; saveCart(); renderCart(); }
    else if (act === 'dec') {
      if (line.qty > 1) line.qty--; else cart.lines = cart.lines.filter((l) => l !== line);
      saveCart(); renderCart();
    } else if (act === 'edit') {
      const it = ITEMS[line.itemId];
      if (it) openItemSheet(it, line);
    }
  };
  $('#btnClear').onclick = () => {
    if (!cart.lines.length && !cart.orderId) return;
    confirmSheet('清空订单？', cart.orderId ? '挂单会保留在订单列表 · The held order stays in Orders' : '', '清空 Clear', clearCart, true);
  };
  $('#btnHold').onclick = holdOrder;
  $('#btnPay').onclick = openPaySheet;

  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  $('#ordersDate').value = dayKey();
  $('#ordersDate').onchange = renderOrders;
  $('#ordersFilter').onclick = (e) => { const b = e.target.closest('button'); if (b) { ordersFilter = b.dataset.f; renderOrders(); } };
  $('#ordersList').onclick = (e) => { const b = e.target.closest('.order-row'); if (b) openOrderDetail(b.dataset.id); };

  $('#reportDate').value = dayKey();
  $('#reportDate').onchange = renderReport;
  $('#btnPrintReport').onclick = printReport;
  $('#btnExportCsv').onclick = exportCsv;

  $('#settingsBody').onclick = (e) => {
    const id = e.target.closest('button')?.id;
    if (id === 'btnSaveSettings') saveSettingsFromForm();
    else if (id === 'btnBackup') backup();
    else if (id === 'btnRestore') $('#restoreFile').click();
  };
  $('#restoreFile').onchange = (e) => { const f = e.target.files[0]; if (f) restore(f); e.target.value = ''; };
}

async function init() {
  wire();
  renderCats(); renderItems(); renderCart();
  tickClock(); setInterval(tickClock, 15000);
  try {
    await DB.open();
    refreshOpenBadge();
  } catch (e) {
    toast('无法打开数据库 Cannot open storage');
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
