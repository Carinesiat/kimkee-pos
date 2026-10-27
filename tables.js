'use strict';

// Table plan: a floor map of the shop. Each table shows whether it has an open (unpaid) order,
// how much it is and how long the customers have been seated. Loaded before app.js; everything
// here runs only after app.js has set up the shared helpers.

// Layout elements are positioned in % of the floor (which keeps a 4:3 shape), so the plan
// looks the same in landscape and portrait.
const TABLE_SIZES = {
  s: { zh: '小', en: 'Small', w: 7, h: 9 },
  m: { zh: '中', en: 'Medium', w: 9, h: 12 },
  l: { zh: '大', en: 'Large', w: 12, h: 12 },
  long: { zh: '长', en: 'Long', w: 18, h: 12 },
};

let floorEdit = false;
let openByTable = {}; // table id -> open orders

// Real floor plans, measured from each outlet's drawing (one 1414 × 2000 px drawing per shop unit).
// Each unit is placed side by side on the floor: ox = left edge in % of the floor width.
// Rects are [name, x, y, w, h] in drawing pixels.
const FLOOR_PLANS = {
  bsd: [
    { ox: 1, title: '店面 1 · Table 1–17', bar: [524, 1754, 365, 196], tables: [
      ['14', 138, 168, 196, 196], ['15', 131, 555, 197, 196], ['16', 125, 970, 197, 196], ['17', 119, 1387, 197, 196],
      ['7', 608, 99, 196, 183], ['8', 608, 282, 196, 196], ['9', 608, 536, 196, 196],
      ['10', 608, 802, 196, 184], ['11', 608, 986, 196, 196], ['12', 608, 1259, 196, 184], ['13', 608, 1443, 196, 196],
      ['1', 1074, 168, 196, 183], ['2', 1074, 351, 196, 196], ['3', 1072, 670, 196, 184], ['4', 1072, 854, 196, 195],
      ['5', 1071, 1172, 196, 184], ['6', 1071, 1356, 196, 195],
    ] },
    { ox: 51, title: '店面 2 · Table 18–32', bar: [524, 1754, 365, 196], tables: [
      ['28', 150, 100, 196, 196], ['29', 150, 296, 196, 196], ['30', 147, 758, 196, 194], ['31', 147, 952, 196, 197],
      ['32', 150, 1315, 198, 364],
      ['23', 608, 99, 196, 196], ['24', 608, 439, 196, 196], ['25', 608, 809, 196, 196], ['26', 608, 1148, 196, 196], ['27', 605, 1487, 197, 197],
      ['18', 984, 99, 365, 198], ['19', 984, 437, 365, 198], ['20', 984, 798, 365, 198], ['21', 984, 1146, 365, 199], ['22', 984, 1463, 365, 199],
    ] },
  ],
};

// Drawing pixels -> % of the 4:3 floor. Each unit gets 48% of the width; 90.5% of the height keeps the drawing's shape.
function layoutFromPlan(units) {
  const sx = 48 / 1414, sy = 90.5 / 2000, oy = 6, gap = 6;
  const els = [];
  units.forEach((u, ui) => {
    const box = ([x, y, w, h]) => ({ x: u.ox + (x + gap) * sx, y: oy + (y + gap) * sy, w: (w - 2 * gap) * sx, h: (h - 2 * gap) * sy });
    els.push({ id: `l${ui}t`, type: 'label', name: u.title, x: u.ox, y: 0.5, w: 48, h: 5 });
    for (const [name, ...r] of u.tables) els.push({ id: 't' + name, type: 'table', name, shape: 'rect', ...box(r) });
    els.push({ id: `l${ui}b`, type: 'label', name: 'BAR', fill: true, ...box(u.bar) });
  });
  return els;
}

function defaultLayout(outletId) {
  if (FLOOR_PLANS[outletId]) return layoutFromPlan(FLOOR_PLANS[outletId]);
  const outlet = OUTLETS.find((o) => o.id === outletId);
  return gridLayout(outlet ? outlet.tables : 20);
}

function gridLayout(n) {
  const cols = n > 24 ? 8 : 6;
  const rows = Math.ceil(n / cols);
  const cw = 100 / cols, ch = 100 / rows;
  const w = cw * 0.72, h = Math.min(ch * 0.7, 16);
  return Array.from({ length: n }, (_, i) => ({
    id: 't' + (i + 1), type: 'table', name: String(i + 1), shape: 'rect',
    x: (i % cols) * cw + (cw - w) / 2, y: Math.floor(i / cols) * ch + (ch - h) / 2, w, h,
  }));
}

function getLayout() {
  return settings.layout || defaultLayout(settings.outlet);
}
function saveLayout(layout) { settings.layout = layout; saveSettings(); }
const tableById = (id) => getLayout().find((e) => e.id === id);

// ---------- floor ----------
async function renderTables() {
  if (!DB.db) return;
  let open;
  try { open = await DB.byStatus('open'); } catch (e) { return; }
  openByTable = {};
  for (const o of open) if (o.table) (openByTable[o.table] ||= []).push(o);
  const counter = open.filter((o) => !o.table || !tableById(o.table)).sort((a, b) => a.createdAt - b.createdAt);
  const late = (settings.lateMins || 60) * 60000;
  const now = Date.now();

  fitFloor();
  const floor = $('#floor');
  floor.classList.toggle('editing', floorEdit);
  floor.innerHTML = getLayout().map((e) => {
    const pos = `left:${e.x}%;top:${e.y}%;width:${e.w}%;height:${e.h}%`;
    if (e.type === 'label') return `<div class="flabel ${e.fill ? 'filled' : ''}" data-id="${e.id}" style="${pos}">${esc(e.name)}</div>`;
    const orders = openByTable[e.id] || [];
    const busy = orders.length > 0;
    const since = busy ? Math.min(...orders.map((o) => o.createdAt)) : 0;
    const total = orders.reduce((a, o) => a + o.totals.total, 0);
    const mins = busy ? Math.floor((now - since) / 60000) : 0;
    return `<button class="tbl ${e.shape} ${busy ? 'busy' : ''} ${busy && now - since > late ? 'late' : ''}" data-id="${e.id}" style="${pos}">
      <b>${esc(e.name)}</b>
      ${busy ? `<span class="t-amt">${fmt(total)}</span><span class="t-min">${mins} 分</span>` : ''}
      ${orders.length > 1 ? `<span class="t-n">${orders.length}</span>` : ''}
    </button>`;
  }).join('');

  const busyTables = Object.keys(openByTable).filter((id) => tableById(id));
  const busyTotal = open.reduce((a, o) => a + o.totals.total, 0);
  $('#floorSide').innerHTML = floorEdit ? `
    <h3>编辑桌位 <small>Edit layout</small></h3>
    <p class="muted-s">拖动桌子摆到店里的位置；点一下可以改桌号、形状、大小或删除。<br>Drag to move, tap to edit.</p>
    <button class="btn ghost wide" data-act="addTable">＋ 加桌子 Add table</button>
    <button class="btn ghost wide" data-act="addLabel">＋ 加文字 Add label <small>门口 / 厨房 / 柜台</small></button>
    <button class="btn ghost wide" data-act="resetLayout">恢复默认排列 Reset</button>
    <div class="spacer"></div>
    <button class="btn primary wide" data-act="doneEdit">完成 Done</button>` : `
    <div class="floor-stats">
      <div><b>${busyTables.length}</b><small>桌用餐中 tables</small></div>
      <div><b>${fmt(busyTotal)}</b><small>未付总额 unpaid</small></div>
    </div>
    <button class="btn primary wide" data-act="counter">＋ 外带 / 柜台单<small>Takeaway / counter</small></button>
    <h4>柜台未付 <small>Counter unpaid (${counter.length})</small></h4>
    <div class="counter-list">${counter.length ? counter.map((o) => `
      <button class="counter-row" data-order="${o.id}">
        <b>#${pad(o.no)}</b><span>${esc(o.label || o.remark || o.lines.map((l) => l.code || l.zh).join(', '))}</span><em>${fmt(o.totals.total)}</em>
      </button>`).join('') : '<p class="muted-s">没有 None</p>'}</div>
    <div class="spacer"></div>
    <button class="btn ghost wide" data-act="edit">✎ 编辑桌位 Edit layout</button>`;
}

// Keep the floor at 4:3 inside whatever space the screen gives it.
function fitFloor() {
  const wrap = $('#floorWrap'), floor = $('#floor');
  const W = wrap.clientWidth - 24, H = wrap.clientHeight - 24;
  if (W <= 0 || H <= 0) return;
  const w = Math.min(W, H * 4 / 3);
  floor.style.width = w + 'px';
  floor.style.height = w * 3 / 4 + 'px';
}

// ---------- tapping tables ----------
function onTableTap(id) {
  const t = tableById(id);
  if (!t || t.type !== 'table') return;
  const orders = openByTable[id] || [];
  if (!orders.length) {
    leaveCart(() => {
      setCart({ mode: 'dine', lines: [], orderId: null, label: '', remark: '', table: t.id, tableName: t.name });
      showView('order');
    });
  } else if (orders.length === 1) tableSheet(orders[0]);
  else pickOrderSheet(t, orders);
}

// Ask before throwing away items that were added but not sent or paid.
function leaveCart(next) {
  if (cart.changed && cart.lines.length) {
    confirmSheet('目前的订单还没送出', '要放弃这些还没保存的菜吗？ · Discard unsaved items?', '放弃 Discard', next, true);
  } else next();
}

function pickOrderSheet(t, orders) {
  const s = openModal(`
    <div class="sheet-head"><h3>桌 ${esc(t.name)}</h3><div class="sub">这桌有 ${orders.length} 张单，选一张 · Pick an order</div></div>
    <div class="sheet-body"><div class="counter-list">${orders.map((o) => `
      <button class="counter-row" data-order="${o.id}"><b>#${pad(o.no)}</b><span>${esc(o.remark || o.lines.map((l) => l.code || l.zh).join(', '))}</span><em>${fmt(o.totals.total)}</em></button>`).join('')}
    </div></div>
    <div class="sheet-foot"><div class="spacer"></div><button class="btn ghost" data-x>关闭</button></div>`);
  s.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) closeModal();
    else if (b.dataset.order) tableSheet(await DB.get(b.dataset.order));
  };
}

function tableSheet(o) {
  const mins = Math.floor((Date.now() - o.createdAt) / 60000);
  const where = o.table && tableById(o.table) ? `桌 ${esc(o.tableName)}` : '柜台 Counter';
  const s = openModal(`
    <div class="sheet-head"><h3>${where} · #${pad(o.no)}</h3>
      <div class="sub">${timeStr(o.createdAt)} 入座 · ${mins} 分钟 · ${MODE_LABEL[o.mode]}${o.remark ? ' · ☎ ' + esc(o.remark) : ''}</div></div>
    <div class="sheet-body">
      ${o.lines.map((l) => `<div class="row"><span>${l.qty} × ${l.code ? `<b>${esc(l.code)}</b> ` : ''}${esc(l.zh)}${l.opts.length ? ` <small>${l.opts.map((x) => esc(x.zh)).join(' · ')}</small>` : ''}${l.pack !== 'dine' ? ` <small>· ${packTag(l.pack)}</small>` : ''}</span><span>${fmt(lineUnit(l) * l.qty)}</span></div>`).join('')}
      <div class="row total"><span>总计 Total</span><span>${RM(o.totals.total)}</span></div>
    </div>
    <div class="sheet-foot table-actions">
      <button class="btn ghost" data-a="move">换桌<small>Move</small></button>
      <button class="btn ghost" data-a="merge">并桌<small>Merge</small></button>
      <button class="btn ghost" data-a="split">分开付<small>Split bill</small></button>
      <button class="btn ghost" data-a="print">打印账单<small>Print bill</small></button>
      <div class="spacer"></div>
      <button class="btn ghost" data-x>关闭</button>
      <button class="btn gold" data-a="add">加单<small>Add items</small></button>
      <button class="btn primary" data-a="pay">结账<small>Pay</small></button>
    </div>`, 'wide');
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) return closeModal();
    const a = b.dataset.a;
    if (a === 'add') leaveCart(() => { closeModal(); loadOrderToCart(o); showView('order'); });
    else if (a === 'pay') leaveCart(() => { loadOrderToCart(o); openPaySheet(); });
    else if (a === 'print') printReceipt(o);
    else if (a === 'move') moveSheet(o);
    else if (a === 'merge') mergeSheet(o);
    else if (a === 'split') splitSheet(o);
  };
}

// ---------- move / merge ----------
function tablePicker(title, sub, tables, onPick) {
  const s = openModal(`
    <div class="sheet-head"><h3>${title}</h3><div class="sub">${sub}</div></div>
    <div class="sheet-body">${tables.length ? `<div class="table-pick">${tables.map((t) => `
      <button class="chip" data-t="${t.id}">${esc(t.name)}${openByTable[t.id] ? `<small>${fmt(openByTable[t.id].reduce((a, o) => a + o.totals.total, 0))}</small>` : ''}</button>`).join('')}</div>`
      : '<p class="muted-s">没有可以选的桌子 · No tables to choose</p>'}</div>
    <div class="sheet-foot"><div class="spacer"></div><button class="btn ghost" data-x>取消</button></div>`);
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) closeModal();
    else if (b.dataset.t) onPick(tableById(b.dataset.t));
  };
}

const tablesOnly = () => getLayout().filter((e) => e.type === 'table');

function moveSheet(o) {
  const empty = tablesOnly().filter((t) => !openByTable[t.id]);
  tablePicker('换桌 Move to table', `把 #${pad(o.no)} 搬到哪一张空桌？ · Choose an empty table`, empty, async (t) => {
    o.table = t.id;
    o.tableName = t.name;
    await DB.put(o);
    if (cart.orderId === o.id) { cart.table = t.id; cart.tableName = t.name; saveCart(); renderCart(); }
    closeModal();
    toast(`#${pad(o.no)} 已换到桌 ${t.name}`);
    renderTables();
  });
}

function mergeSheet(o) {
  const others = tablesOnly().filter((t) => openByTable[t.id] && t.id !== o.table);
  const here = o.table && tableById(o.table) ? `桌 ${esc(o.tableName)}` : `#${pad(o.no)}`;
  tablePicker('并桌 Merge', `把哪一桌并进 ${here}？那一桌的菜会加到这张单，一起付钱。 · Pick a table to merge into this bill`, others, async (t) => {
    const from = openByTable[t.id];
    for (const src of from) {
      o.lines.push(...src.lines.map((l) => ({ ...l, lid: ++lineSeq })));
      if (src.remark && !(o.remark || '').includes(src.remark)) o.remark = [o.remark, src.remark].filter(Boolean).join(' / ');
      src.status = 'merged';
      src.mergedInto = o.id;
      await DB.put(src);
    }
    o.totals = calcTotals(o.lines);
    o.mode = orderMode(o.lines);
    await DB.put(o);
    if (cart.orderId === o.id) loadOrderToCart(o);
    toast(`桌 ${t.name} 已并入 ${o.tableName ? '桌 ' + o.tableName : '#' + pad(o.no)}`);
    refreshOpenBadge();
    await renderTables();
    tableSheet(o);
  });
}

// ---------- split bill ----------
// Pick how many of each item this customer pays for; the rest stays on the table.
function splitSheet(o) {
  const pick = o.lines.map(() => 0);
  const s = openModal(`
    <div class="sheet-head"><h3>分开付 Split bill · #${pad(o.no)}</h3><div class="sub">选这位客人要付的菜 · Choose what this customer pays for</div></div>
    <div class="sheet-body">${o.lines.map((l, i) => `
      <div class="split-row">
        <span>${l.code ? `<b>${esc(l.code)}</b> ` : ''}${esc(l.zh)}${l.opts.length ? ` <small>${l.opts.map((x) => esc(x.zh)).join(' · ')}</small>` : ''}<br><small>${fmt(lineUnit(l))} × ${l.qty}</small></span>
        <div class="stepper"><button data-i="${i}" data-d="-1">−</button><span id="sp${i}">0</span><button data-i="${i}" data-d="1">+</button></div>
      </div>`).join('')}
    </div>
    <div class="sheet-foot">
      <span id="splitInfo" class="muted-s"></span>
      <div class="spacer"></div>
      <button class="btn ghost" data-x>取消</button>
      <button class="btn primary" data-ok disabled>结账所选 Pay selected</button>
    </div>`, 'wide');
  const selected = () => o.lines.map((l, i) => ({ ...l, qty: pick[i] })).filter((l) => l.qty > 0);
  const sync = () => {
    pick.forEach((n, i) => { $('#sp' + i, s).textContent = n; });
    const sel = selected();
    const all = pick.every((n, i) => n === o.lines[i].qty);
    $('#splitInfo', s).textContent = sel.length ? `这位付 ${RM(calcTotals(sel).total)}${all ? ' · 全部 All' : ''}` : '';
    $('[data-ok]', s).disabled = !sel.length;
  };
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-x')) return tableSheet(o);
    if (b.dataset.i !== undefined) {
      const i = +b.dataset.i;
      pick[i] = Math.min(o.lines[i].qty, Math.max(0, pick[i] + +b.dataset.d));
      return sync();
    }
    if (b.hasAttribute('data-ok') && !b.disabled) {
      if (pick.every((n, i) => n === o.lines[i].qty)) { loadOrderToCart(o); return openPaySheet(); }
      const paidLines = selected().map((l) => ({ ...l, lid: ++lineSeq }));
      const rest = o.lines.map((l, i) => ({ ...l, qty: l.qty - pick[i] })).filter((l) => l.qty > 0);
      openPaySheet({
        lines: paidLines,
        build: async () => Object.assign(await newOrderBase(), {
          mode: orderMode(paidLines), label: o.label || '', remark: o.remark || '', table: o.table, tableName: o.tableName,
          lines: paidLines, totals: calcTotals(paidLines), rates: rateSnapshot(), splitFrom: o.id,
        }),
        after: async () => {
          const cur = await DB.get(o.id);
          cur.lines = rest;
          cur.totals = calcTotals(rest);
          cur.mode = orderMode(rest);
          await DB.put(cur);
          if (cart.orderId === cur.id) loadOrderToCart(cur);
        },
      });
    }
  };
  sync();
}

// ---------- layout editor ----------
let drag = null;

function onFloorPointerDown(e) {
  if (!floorEdit) return;
  const el = e.target.closest('[data-id]');
  if (!el) return;
  const item = getLayout().find((x) => x.id === el.dataset.id);
  const rect = $('#floor').getBoundingClientRect();
  drag = { el, item, rect, sx: e.clientX, sy: e.clientY, ox: item.x, oy: item.y, moved: false };
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
  e.preventDefault();
}

function onFloorPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 5) drag.moved = true;
  if (!drag.moved) return;
  const it = drag.item;
  it.x = Math.round(Math.min(100 - it.w, Math.max(0, drag.ox + dx / drag.rect.width * 100)) * 2) / 2;
  it.y = Math.round(Math.min(100 - it.h, Math.max(0, drag.oy + dy / drag.rect.height * 100)) * 2) / 2;
  drag.el.style.left = it.x + '%';
  drag.el.style.top = it.y + '%';
}

function onFloorPointerUp() {
  if (!drag) return;
  const { item, moved } = drag;
  drag = null;
  if (moved) saveLayout(getLayout().map((x) => (x.id === item.id ? item : x)));
  else editElementSheet(item.id);
}

function editElementSheet(id) {
  const layout = getLayout();
  const el = layout.find((x) => x.id === id);
  const isTable = el.type === 'table';
  let shape = el.shape || 'rect';
  let size = Object.keys(TABLE_SIZES).find((k) => TABLE_SIZES[k].w === el.w && TABLE_SIZES[k].h === el.h) || '';
  const s = openModal(`
    <div class="sheet-head"><h3>${isTable ? '桌子 Table' : '文字 Label'}</h3></div>
    <div class="sheet-body">
      <label class="field"><span>${isTable ? '桌号 Table name' : '文字 Text'}</span><input id="elName" value="${esc(el.name)}"></label>
      ${isTable ? `
      <div class="group"><div class="group-title">形状 <small>Shape</small></div><div class="chips">
        <button class="chip" data-shape="rect">方 Square</button><button class="chip" data-shape="round">圆 Round</button></div></div>` : ''}
      <div class="group"><div class="group-title">大小 <small>Size</small></div><div class="chips">
        ${Object.entries(TABLE_SIZES).map(([k, v]) => `<button class="chip" data-size="${k}">${v.zh} ${v.en}</button>`).join('')}</div></div>
    </div>
    <div class="sheet-foot">
      <button class="btn danger" data-del>删除 Delete</button>
      <div class="spacer"></div>
      <button class="btn ghost" data-x>取消</button>
      <button class="btn primary" data-ok>保存 Save</button>
    </div>`);
  const sync = () => {
    $$('[data-shape]', s).forEach((b) => b.classList.toggle('on', b.dataset.shape === shape));
    $$('[data-size]', s).forEach((b) => b.classList.toggle('on', b.dataset.size === size));
  };
  s.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.shape) { shape = b.dataset.shape; sync(); }
    else if (b.dataset.size) { size = b.dataset.size; sync(); }
    else if (b.hasAttribute('data-x')) closeModal();
    else if (b.hasAttribute('data-del')) {
      if (openByTable[id]) { toast('这桌还有未付的单，不能删除 · Table has an open order'); return; }
      saveLayout(layout.filter((x) => x.id !== id));
      closeModal(); renderTables();
    } else if (b.hasAttribute('data-ok')) {
      const name = $('#elName', s).value.trim();
      if (!name) { toast('请输入名称 · Enter a name'); return; }
      if (isTable && layout.some((x) => x.type === 'table' && x.id !== id && x.name === name)) { toast(`桌号 ${name} 已经有了 · Name already used`); return; }
      el.name = name;
      if (isTable) el.shape = shape;
      if (size) {
        el.w = TABLE_SIZES[size].w; el.h = TABLE_SIZES[size].h;
        el.x = Math.min(el.x, 100 - el.w); el.y = Math.min(el.y, 100 - el.h);
      }
      saveLayout(layout);
      // Keep open orders showing the new table name.
      for (const o of openByTable[id] || []) { o.tableName = name; DB.put(o); }
      closeModal(); renderTables();
    }
  };
  sync();
}

function addElement(type) {
  const layout = getLayout();
  const nums = layout.filter((x) => x.type === 'table').map((x) => parseInt(x.name, 10)).filter(Number.isFinite);
  const id = (type === 'table' ? 't' : 'l') + Date.now().toString(36);
  const size = type === 'table' ? TABLE_SIZES.m : { w: 14, h: 6 };
  layout.push({ id, type, name: type === 'table' ? String((nums.length ? Math.max(...nums) : 0) + 1) : '门口', shape: 'rect', x: 45, y: 44, ...{ w: size.w, h: size.h } });
  saveLayout(layout);
  renderTables();
  toast(type === 'table' ? '已加桌子，拖到位置 · Drag it into place' : '已加文字 · Drag it into place');
}

function wireTables() {
  const floor = $('#floor');
  floor.addEventListener('pointerdown', onFloorPointerDown);
  floor.addEventListener('pointermove', onFloorPointerMove);
  floor.addEventListener('pointerup', onFloorPointerUp);
  floor.addEventListener('pointercancel', () => { drag = null; renderTables(); });
  floor.addEventListener('click', (e) => {
    if (floorEdit) return;
    const b = e.target.closest('.tbl');
    if (b) onTableTap(b.dataset.id);
  });
  $('#floorSide').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.order) return tableSheet(await DB.get(b.dataset.order));
    const a = b.dataset.act;
    if (a === 'counter') leaveCart(() => { setCart({ mode: 'take', lines: [], orderId: null, label: '', remark: '' }); showView('order'); });
    else if (a === 'edit') { floorEdit = true; if (!settings.layout) saveLayout(getLayout()); renderTables(); }
    else if (a === 'doneEdit') { floorEdit = false; renderTables(); toast('桌位已保存 · Layout saved'); }
    else if (a === 'addTable') addElement('table');
    else if (a === 'addLabel') addElement('label');
    else if (a === 'resetLayout') {
      confirmSheet('恢复默认排列？', '桌子会回到总店设定的平面图 · Tables go back to the outlet\'s standard floor plan', '恢复 Reset', () => {
        saveLayout(defaultLayout(settings.outlet));
        renderTables();
      }, true);
    }
  });
  new ResizeObserver(() => fitFloor()).observe($('#floorWrap'));
  // Refresh the seated minutes.
  setInterval(() => { if ($('#view-tables').classList.contains('active') && !drag && !floorEdit) renderTables(); }, 30000);
}
