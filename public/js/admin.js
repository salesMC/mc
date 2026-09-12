// Shared script for every admin page (/admin/orders, /customers, /promo-codes, /calculator).
// Each page sets <body data-page="..."> and initAdminPage() loads only what that page needs.
// Sign-in lives on /admin (views/admin/login.ejs).

// ==================== SESSION HANDLING ====================
// Admin pages are only served with a valid admin cookie (checked on the server).
// If the session expires while a page is open, the next API call returns 401 and
// we go back to sign-in, returning here afterwards.
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await _fetch(input, init);
  if (res.status === 401 && String(input).startsWith('/api/')) {
    sessionStorage.removeItem('mcAdminAuth');
    sessionStorage.removeItem('mcAdminEmail');
    window.location.replace('/admin?next=' + encodeURIComponent(location.pathname + location.search));
  }
  return res;
};

async function adminLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  sessionStorage.removeItem('mcAdminAuth');
  sessionStorage.removeItem('mcAdminEmail');
  window.location.href = '/admin';
}

async function initAdminPage() {
  const page = document.body.dataset.page;
  try {
    const me = await (await fetch('/api/auth/me')).json();
    if (!me.authenticated || me.role !== 'admin') return adminLogout();
    sessionStorage.setItem('mcAdminAuth', '1');
    sessionStorage.setItem('mcAdminEmail', me.email);
    const emailEl = document.getElementById('adminNavEmail');
    if (emailEl) emailEl.textContent = me.email;
  } catch (e) { /* offline — page still renders */ }

  await loadCurrentConfig(); // pricing config: calculator page + customer quote wizard

  const open = new URLSearchParams(location.search).get('open');
  if (page === 'orders') {
    loadOrders();
    if (open) showOrderDetail(open);      // /admin/orders?open=<id>
  }
  if (page === 'payments')    loadPayments();
  if (page === 'promo-codes') loadPromoCodes();
  if (page === 'leads')       loadLeads();
  if (page === 'email')       loadEmailStatus();
  if (page === 'search')      loadSearchResults();
  if (page === 'calculator')  { loadPricingSettings(); loadLocationRatings(); }
  if (page === 'customers') {
    loadCustomers();
    if (open) showCustomerDetail(Number(open)); // /admin/customers?open=<id>
  }
  initGlobalSearch();
}

// ==================== PAGING HELPER ====================
// Renders "Showing 1–50 of 320 · Prev / Next · per page" into a .pager element.
function renderPager(el, { page, pages, total, limit }, onPage, onLimit) {
  if (!el) return;
  if (!total) { el.innerHTML = ''; return; }
  const from = (page - 1) * limit + 1, to = Math.min(total, page * limit);
  el.innerHTML = `
    <span>Showing <strong class="text-white">${from}–${to}</strong> of <strong class="text-white">${total}</strong></span>
    <span class="flex items-center gap-2">
      <button ${page <= 1 ? 'disabled' : ''} data-go="1" title="First"><i class="fas fa-angles-left"></i></button>
      <button ${page <= 1 ? 'disabled' : ''} data-go="${page - 1}"><i class="fas fa-angle-left"></i> Prev</button>
      <span>Page <strong class="text-white">${page}</strong> of ${pages}</span>
      <button ${page >= pages ? 'disabled' : ''} data-go="${page + 1}">Next <i class="fas fa-angle-right"></i></button>
      <button ${page >= pages ? 'disabled' : ''} data-go="${pages}" title="Last"><i class="fas fa-angles-right"></i></button>
      <select data-limit>${[25, 50, 100, 200].map(n => `<option value="${n}" ${n === limit ? 'selected' : ''}>${n} / page</option>`).join('')}</select>
    </span>`;
  el.querySelectorAll('button[data-go]').forEach(b => b.onclick = () => onPage(Number(b.dataset.go)));
  el.querySelector('select[data-limit]').onchange = (e) => onLimit(Number(e.target.value));
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ==================== DETAIL NAVIGATION (order ⇄ customer, in place) ====================
// A small history so you can open an order, jump to its customer, open another of
// their orders, and come back — without ever leaving the page you're on.
let detailStack = [];
function detailPush(kind, id) {
  const top = detailStack[detailStack.length - 1];
  if (!top || top.kind !== kind || String(top.id) !== String(id)) detailStack.push({ kind, id });
  updateBackButtons();
}
function updateBackButtons() {
  const show = detailStack.length > 1;
  ['orderBackBtn', 'customerBackBtn'].forEach(id => { const b = document.getElementById(id); if (b) b.classList.toggle('hidden', !show); });
}
async function detailBack() {
  if (detailStack.length < 2) return;
  detailStack.pop();
  const prev = detailStack[detailStack.length - 1];
  if (prev.kind === 'order') await showOrderDetail(prev.id, { fromHistory: true });
  else await showCustomerDetail(prev.id, { fromHistory: true });
}
function detailReset() { detailStack = []; updateBackButtons(); }

// ==================== GLOBAL SEARCH (top bar) ====================
let gsActive = -1, gsItems = [];
function initGlobalSearch() {
  const input = document.getElementById('globalSearch');
  if (!input) return;
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
    if (e.key === 'Escape') globalSearchClose();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#globalSearchWrap')) globalSearchClose(); });
}
const globalSearchFetch = debounce(async (q) => {
  const box = document.getElementById('globalSearchResults');
  try {
    const d = await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
    gsItems = [];
    let html = '';
    if (d.orders.length) {
      html += '<div class="gs-section">Orders</div>';
      d.orders.forEach(o => {
        const i = gsItems.push({ kind: 'order', id: o.id }) - 1;
        html += `<div class="gs-item" data-i="${i}" onclick="globalSearchOpen(${i})">
          <div class="min-w-0"><div class="gs-main"><span class="font-mono text-orange-400">${esc(o.id)}</span> · ${esc(o.customer || '—')}</div><div class="gs-sub">${esc(o.vehicle || '')}${o.email ? ' · ' + esc(o.email) : ''}</div></div>
          <div class="text-right shrink-0"><div class="text-white text-sm">${money(o.total)}</div>${payStatePill(o.paymentState)}</div></div>`;
      });
    }
    if (d.customers.length) {
      html += '<div class="gs-section">Customers</div>';
      d.customers.forEach(c => {
        const i = gsItems.push({ kind: 'customer', id: c.id }) - 1;
        html += `<div class="gs-item" data-i="${i}" onclick="globalSearchOpen(${i})">
          <div class="min-w-0"><div class="gs-main">${esc(c.name)}${c.company ? ' <span class="text-muted font-normal">· ' + esc(c.company) + '</span>' : ''}</div><div class="gs-sub">${esc(c.email || '')}${c.phone ? ' · ' + esc(c.phone) : ''}</div></div>
          <div class="text-right shrink-0 text-xs text-muted">${c.orderCount} order${c.orderCount === 1 ? '' : 's'}<div class="text-white">${money(c.totalSpent)}</div></div></div>`;
      });
    }
    if (!html) html = `<div class="gs-empty">Nothing found for “${esc(q)}”</div>`;
    box.innerHTML = html; box.classList.remove('hidden'); gsActive = -1;
  } catch (e) { console.error('search:', e); }
}, 200);
function globalSearchInput() {
  const q = document.getElementById('globalSearch').value.trim();
  if (q.length < 2) return globalSearchClose();
  globalSearchFetch(q);
}
function globalSearchKey(e) {
  const items = document.querySelectorAll('#globalSearchResults .gs-item');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    gsActive = e.key === 'ArrowDown' ? Math.min(items.length - 1, gsActive + 1) : Math.max(0, gsActive - 1);
    items.forEach((el, i) => el.classList.toggle('active', i === gsActive));
    items[gsActive]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (gsActive >= 0) return globalSearchOpen(gsActive);
    const q = document.getElementById('globalSearch').value.trim();
    if (q) location.href = '/admin/search?q=' + encodeURIComponent(q);   // full results page
  }
}
function globalSearchClose() { const box = document.getElementById('globalSearchResults'); if (box) box.classList.add('hidden'); }
async function globalSearchOpen(i) {
  const it = gsItems[i]; if (!it) return;
  globalSearchClose();
  document.getElementById('globalSearch').blur();
  detailReset();
  if (it.kind === 'order') await showOrderDetail(it.id); else await showCustomerDetail(it.id);
}

// ==================== PROMO CODES ====================

async function loadPromoCodes() {
  try {
    const res = await fetch('/api/promo-codes');
    const codes = await res.json();
    const tbody = document.getElementById('promoCodesBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (codes.length === 0) {
      document.getElementById('noPromosMessage').classList.remove('hidden');
      return;
    }
    document.getElementById('noPromosMessage').classList.add('hidden');

    codes.forEach(p => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <span id="code-label-${p.id}" class="font-mono text-orange-400 font-semibold tracking-widest">${esc(p.code)}</span>
          <input id="code-input-${p.id}" type="text" value="${esc(p.code)}"
                 class="input-admin hidden font-mono uppercase w-36"
                 oninput="this.value=this.value.toUpperCase()">
        </td>
        <td>
          <span id="discount-label-${p.id}">${p.type === 'percent' ? p.discount + '%' : '$' + Number(p.discount).toFixed(2)}</span>
          <input id="discount-input-${p.id}" type="number" step="0.01" value="${p.discount}" class="input-admin hidden w-24">
        </td>
        <td>
          <span id="type-label-${p.id}">${p.type === 'percent' ? 'Percent' : 'Fixed'}</span>
          <select id="type-input-${p.id}" class="input-admin hidden w-28">
            <option value="percent" ${p.type==='percent'?'selected':''}>% Percent</option>
            <option value="fixed"   ${p.type==='fixed'  ?'selected':''}>$ Fixed</option>
          </select>
        </td>
        <td>
          <span onclick="togglePromoActive(${p.id}, ${p.active})"
                class="status-badge cursor-pointer ${p.active ? 'bg-lime-500/10 text-lime-400 hover:bg-lime-500/20' : 'bg-red-500/10 text-red-400 hover:bg-red-500/20'}">
            ${p.active ? 'Active' : 'Inactive'}
          </span>
        </td>
        <td class="text-center flex items-center justify-center gap-2 py-4">
          <button id="edit-btn-${p.id}" onclick="startEditPromo(${p.id})"
                  class="text-cyan-400 hover:text-white p-2" title="Edit">
            <i class="fas fa-pencil"></i>
          </button>
          <button id="save-btn-${p.id}" onclick="saveEditPromo(${p.id})"
                  class="hidden text-lime-400 hover:text-white p-2" title="Save">
            <i class="fas fa-check"></i>
          </button>
          <button id="cancel-btn-${p.id}" onclick="cancelEditPromo(${p.id})"
                  class="hidden text-muted hover:text-white p-2" title="Cancel">
            <i class="fas fa-xmark"></i>
          </button>
          <button onclick="deletePromoCode(${p.id})"
                  class="text-red-400 hover:text-red-300 p-2" title="Delete">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch(e) {
    console.error('Error loading promo codes:', e);
  }
}

function startEditPromo(id) {
  ['code','discount','type'].forEach(f => {
    document.getElementById(`${f}-label-${id}`)?.classList.add('hidden');
    document.getElementById(`${f}-input-${id}`)?.classList.remove('hidden');
  });
  document.getElementById(`edit-btn-${id}`)?.classList.add('hidden');
  document.getElementById(`save-btn-${id}`)?.classList.remove('hidden');
  document.getElementById(`cancel-btn-${id}`)?.classList.remove('hidden');
}

function cancelEditPromo(id) {
  loadPromoCodes();
}

async function saveEditPromo(id) {
  const discount = document.getElementById(`discount-input-${id}`)?.value;
  const type     = document.getElementById(`type-input-${id}`)?.value;
  const active   = 1; // keep current active state
  try {
    await fetch(`/api/promo-codes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discount, type, active })
    });
    loadPromoCodes();
  } catch(e) { alert('Error saving promo code'); }
}

async function togglePromoActive(id, currentActive) {
  try {
    const p = await (await fetch('/api/promo-codes')).json();
    const promo = p.find(x => x.id === id);
    if (!promo) return;
    await fetch(`/api/promo-codes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discount: promo.discount, type: promo.type, active: currentActive ? 0 : 1 })
    });
    loadPromoCodes();
  } catch(e) { alert('Error updating promo code'); }
}

async function addPromoCode() {
  const code     = document.getElementById('newPromoCode').value.trim();
  const discount = document.getElementById('newPromoDiscount').value;
  const type     = document.getElementById('newPromoType').value;
  if (!code || !discount) { alert('Please enter a code and discount value'); return; }
  try {
    const res = await fetch('/api/promo-codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, discount, type })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById('newPromoCode').value = '';
      document.getElementById('newPromoDiscount').value = '';
      loadPromoCodes();
    } else {
      alert(data.message || 'Error creating promo code');
    }
  } catch(e) { alert('Error creating promo code'); }
}

async function deletePromoCode(id) {
  if (!confirm('Delete this promo code?')) return;
  try {
    await fetch(`/api/promo-codes/${id}`, { method: 'DELETE' });
    loadPromoCodes();
  } catch(e) { alert('Error deleting promo code'); }
}

// ==================== CALCULATOR SETTINGS ====================
let config = {
  baseFee: 120,
  tiers: [
    { max: 30, rate: 3.00 },
    { max: 70, rate: 2.20 },
    { max: 110, rate: 1.80 },
    { max: 160, rate: 1.50 },
    { max: Infinity, rate: 1.30 }
  ],
  // Keep in sync with the defaults in calculator.ejs / payment.ejs so phone quotes match web quotes
  multipliers: { sedan: 1.00, 'mid-suv': 1.10, 'full-suv': 1.20, 'pickup': 1.15, 'cargo-van': 1.25, 'passenger-van': 1.25, 'mini-van': 1.00, 'other': 1.20 },
  addons: { inoperable: 75, modified: 100, urgent: 100 }
};

// Pricing lives on the server (settings table) so the website, the checkout and
// the phone-quote wizard all use the same numbers.
async function loadCurrentConfig() {
  try {
    const res = await fetch('/api/settings/calculator');
    if (res.ok) config = await res.json();
  } catch (e) { console.error('Could not load calculator settings', e); }

  // Only the calculator page has the settings form
  if (!document.getElementById('baseFee')) return;

  document.getElementById('baseFee').value = config.baseFee;
  document.getElementById('multSedan').value = config.multipliers.sedan;
  document.getElementById('multMid').value = config.multipliers['mid-suv'];
  document.getElementById('multFull').value = config.multipliers['full-suv'];
  document.getElementById('multPickup').value = config.multipliers['pickup'] || 1.00;
  document.getElementById('multCargoVan').value = config.multipliers['cargo-van'] || 1.00;
  document.getElementById('multPassengerVan').value = config.multipliers['passenger-van'] || 1.00;
  document.getElementById('multMiniVan').value = config.multipliers['mini-van'] || 1.00;
  document.getElementById('multOther').value = config.multipliers['other'] || 1.00;
  document.getElementById('addonInop').value = config.addons.inoperable;
  document.getElementById('addonMod').value = config.addons.modified;
  document.getElementById('addonUrgent').value = config.addons.urgent;

  renderTiers();
}

function renderTiers() {
  const tbody = document.getElementById('tiersBody');
  tbody.innerHTML = '';
  config.tiers.forEach((tier, i) => {
    const row = document.createElement('tr');
    row.className = 'border-t border-[var(--line)]';
    const maxDisplay = (tier.max == null || tier.max === Infinity) ? '∞' : tier.max;
    row.innerHTML = `
      <td class="py-4"><input type="text" value="${maxDisplay}" class="input-admin w-28" onchange="updateTier(${i}, 'max', this.value)"></td>
      <td class="py-4"><input type="number" step="0.01" value="${tier.rate}" class="input-admin w-32" onchange="updateTier(${i}, 'rate', this.value)"></td>
      <td class="py-4 text-right">
        ${config.tiers.length > 1 ? `<button onclick="deleteTier(${i}); event.stopImmediatePropagation()" class="text-red-400 hover:text-red-500"><i class="fas fa-trash"></i></button>` : ''}
      </td>
    `;
    tbody.appendChild(row);
  });
}

function updateTier(i, field, value) {
  if (field === 'max') {
    const v = String(value).trim();
    config.tiers[i].max = (v === '' || v === '∞' || v.toLowerCase() === 'infinity') ? null : parseFloat(v) || 0;
  } else {
    config.tiers[i].rate = parseFloat(value) || 0;
  }
}

function addTier() {
  const last = config.tiers.pop();
  config.tiers.push({ max: 200, rate: 1.40 });
  config.tiers.push(last);
  renderTiers();
}

function deleteTier(i) {
  if (config.tiers.length <= 1) return;
  if (confirm('Delete this tier?')) {
    config.tiers.splice(i, 1);
    renderTiers();
  }
}

function saveConfig() {
  config.baseFee = parseFloat(document.getElementById('baseFee').value) || 120;
  config.multipliers.sedan = parseFloat(document.getElementById('multSedan').value) || 1;
  config.multipliers['mid-suv'] = parseFloat(document.getElementById('multMid').value) || 1.1;
  config.multipliers['full-suv'] = parseFloat(document.getElementById('multFull').value) || 1.2;
  config.multipliers['pickup'] = parseFloat(document.getElementById('multPickup').value) || 1.00;
  config.multipliers['cargo-van'] = parseFloat(document.getElementById('multCargoVan').value) || 1.00;
  config.multipliers['passenger-van'] = parseFloat(document.getElementById('multPassengerVan').value) || 1.00;
  config.multipliers['mini-van'] = parseFloat(document.getElementById('multMiniVan').value) || 1.00;
  config.multipliers['other'] = parseFloat(document.getElementById('multOther').value) || 1.00;
  config.addons.inoperable = parseFloat(document.getElementById('addonInop').value) || 75;
  config.addons.modified = parseFloat(document.getElementById('addonMod').value) || 100;
  config.addons.urgent = parseFloat(document.getElementById('addonUrgent').value) || 100;

  fetch('/api/settings/calculator', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config)
  }).then(r => r.json()).then(d => {
    if (!d.success) throw new Error(d.message || 'Save failed');
    config = d.config;
    renderTiers();
    alert('✅ Calculator settings saved — the website, checkout and phone quotes now use these prices.');
  }).catch(e => alert('Error saving settings: ' + e.message));
}

// ---------- Market pricing (settings 'pricing') ----------
let pricingCfg = null;
async function loadPricingSettings() {
  const box = document.getElementById('pricingSection'); if (!box) return;
  try {
    const d = await (await fetch('/api/settings/pricing')).json();
    pricingCfg = d.pricing;
    const P = d.pricing, F = d.fuel;
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    box.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div><label class="label-dark">Minimum order price ($)</label><input id="pMin" type="number" value="${P.minimumPrice}" class="input-admin"><p class="text-xs text-muted mt-1">Short local runs never go below this.</p></div>
        <div><label class="label-dark">Enclosed multiplier</label><input id="pEnclosed" type="number" step="0.01" value="${P.enclosedMultiplier}" class="input-admin"><p class="text-xs text-muted mt-1">1.45 = enclosed costs 45% more than open.</p></div>
        <div><label class="label-dark">Extra-vehicle discount (%)</label><input id="pMulti" type="number" step="0.5" value="${P.multiVehicleDiscountPct}" class="input-admin"><p class="text-xs text-muted mt-1">Off each additional vehicle on the same route.</p></div>
      </div>

      <div class="p-5 rounded-xl mb-8" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h4 class="font-semibold text-white"><i class="fas fa-gas-pump text-[var(--orange)] mr-2"></i>Fuel surcharge <span class="text-muted text-sm font-normal">— moves with the U.S. diesel price every week</span></h4>
          <div class="text-sm">${F ? `<span class="text-white font-semibold">Diesel $${Number(F.price).toFixed(2)}/gal</span> <span class="text-muted">· week of ${esc(F.period)} · updated ${new Date(F.fetchedAt).toLocaleDateString()}</span>` : (d.fuelConfigured ? '<span class="text-amber-300">No diesel price fetched yet</span>' : '<span class="text-amber-300">Add EIA_API_KEY in Railway to turn this on</span>')}
            <button onclick="refreshFuel()" class="pay-action ml-2"><i class="fas fa-rotate"></i> Update now</button></div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div><label class="label-dark">On</label><select id="pFuelOn" class="input-admin"><option value="true" ${P.fuel.enabled ? 'selected' : ''}>Yes</option><option value="false" ${!P.fuel.enabled ? 'selected' : ''}>No</option></select></div>
          <div><label class="label-dark">Baseline diesel ($/gal)</label><input id="pFuelBase" type="number" step="0.01" value="${P.fuel.baselineDiesel}" class="input-admin"></div>
          <div><label class="label-dark">% per $0.25 above/below</label><input id="pFuelPct" type="number" step="0.5" value="${P.fuel.pctPerQuarter}" class="input-admin"></div>
          <div><label class="label-dark">Max discount (%)</label><input id="pFuelMin" type="number" step="1" value="${P.fuel.minPct}" class="input-admin"></div>
          <div><label class="label-dark">Max surcharge (%)</label><input id="pFuelMax" type="number" step="1" value="${P.fuel.maxPct}" class="input-admin"></div>
        </div>
        <p class="text-xs text-muted mt-3">Example: baseline $5.95, 3% per $0.25 → diesel at $6.45 adds 6% to every quote; at $5.70 it takes 3% off. Set the baseline to the diesel price on the day you last calibrated the base rates.</p>
      </div>

      <div class="p-5 rounded-xl mb-8" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <h4 class="font-semibold text-white mb-1"><i class="fas fa-calendar-days text-[var(--orange)] mr-2"></i>Season multipliers <span class="text-muted text-sm font-normal">— by pickup month (1.06 = +6%)</span></h4>
        <p class="text-xs text-muted mb-4">Winter and summer run high, spring and fall run flat. Snowbird traffic (south in fall, north in spring) is why Nov–Feb and Jun–Jul sit above 1.</p>
        <div class="grid grid-cols-4 md:grid-cols-6 lg:grid-cols-12 gap-2">
          ${monthNames.map((m, i) => `<div><label class="label-dark text-center block">${m}</label><input id="pSeason${i + 1}" type="number" step="0.01" value="${P.season[i + 1]}" class="input-admin text-center px-1"></div>`).join('')}
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div class="p-5 rounded-xl" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
          <h4 class="font-semibold text-white mb-3"><i class="fas fa-clock text-[var(--orange)] mr-2"></i>Timing</h4>
          <div class="grid grid-cols-2 gap-3">
            <div><label class="label-dark">Short notice: within (days)</label><input id="pShortDays" type="number" value="${P.timing.shortNoticeDays}" class="input-admin"></div>
            <div><label class="label-dark">Short-notice surcharge (%)</label><input id="pShortPct" type="number" step="0.5" value="${P.timing.shortNoticePct}" class="input-admin"></div>
            <div><label class="label-dark">Flexible: window of (days)</label><input id="pFlexDays" type="number" value="${P.timing.flexibleDays}" class="input-admin"></div>
            <div><label class="label-dark">Flexible discount (%)</label><input id="pFlexPct" type="number" step="0.5" value="${P.timing.flexiblePct}" class="input-admin"></div>
          </div>
        </div>
        <div class="p-5 rounded-xl" style="background: rgba(255,106,61,0.06); border: 1px solid rgba(255,106,61,0.35);">
          <h4 class="font-semibold text-white mb-1"><i class="fas fa-sliders text-[var(--orange)] mr-2"></i>Market dial</h4>
          <p class="text-xs text-muted mb-3">Your hand on the wheel. Hearing rates are up from carriers or Central Dispatch? +5. Slow month? −5. Applied on top of everything, on every quote, until you change it.</p>
          <div class="flex items-center gap-3"><input id="pMarket" type="number" step="0.5" value="${P.marketPct}" class="input-admin text-2xl font-bold w-32" style="color: var(--orange);"><span class="text-white text-xl">%</span></div>
        </div>
      </div>

      <div class="p-5 rounded-xl mb-8" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <h4 class="font-semibold text-white mb-1"><i class="fas fa-location-dot text-[var(--orange)] mr-2"></i>Hard-to-reach locations <span class="text-muted text-sm font-normal">— extra fee when a pickup or delivery is far from any metro, or the AI check says the place is difficult</span></h4>
        <p class="text-xs text-muted mb-4">Tier = the higher of the two checks. Same address always gets the same tier; you can override any address in the list below. ${d.aiConfigured ? '<span class="text-lime-300">AI check is on.</span>' : '<span class="text-amber-300">AI check needs ANTHROPIC_API_KEY in Railway — until then only the metro-distance rule runs.</span>'}</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <div><label class="label-dark">Location fees on</label><select id="pDiffOn" class="input-admin"><option value="true" ${P.difficulty.enabled ? 'selected' : ''}>Yes</option><option value="false" ${!P.difficulty.enabled ? 'selected' : ''}>No</option></select></div>
          <div><label class="label-dark">Use AI check</label><select id="pDiffAi" class="input-admin"><option value="true" ${P.difficulty.aiEnabled ? 'selected' : ''}>Yes</option><option value="false" ${!P.difficulty.aiEnabled ? 'selected' : ''}>No</option></select></div>
        </div>
        <div class="grid grid-cols-3 gap-3">
          ${[1, 2, 3].map(t => `<div class="p-3 rounded-lg" style="border:1px solid var(--line)"><div class="text-xs text-muted uppercase tracking-wider mb-2">Tier ${t}${t === 1 ? ' · small town' : t === 2 ? ' · rural / unpaved' : ' · island / very remote'}</div>
            <label class="label-dark">Fee ($)</label><input id="pDiffFee${t}" type="number" value="${P.difficulty.fees[t]}" class="input-admin mb-2">
            <label class="label-dark">…or ≥ miles from a metro</label><input id="pDiffMiles${t}" type="number" value="${P.difficulty.metroMiles[t]}" class="input-admin"></div>`).join('')}
        </div>
      </div>

      <div class="p-5 rounded-xl mb-8" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <h4 class="font-semibold text-white mb-1"><i class="fas fa-route text-[var(--orange)] mr-2"></i>Lane multipliers <span class="text-muted text-sm font-normal">— from region (rows) to region (columns). 1.00 = no change, 1.08 = +8%, 0.96 = −4%</span></h4>
        <p class="text-xs text-muted mb-4">Direction matters: out of Florida costs more than into Florida because trucks are already heading south. Leave a box at 1 to ignore it.</p>
        <div class="overflow-x-auto"><table class="text-xs" id="laneGrid"><thead><tr><th class="p-1 text-muted">from \\ to</th>${Object.keys(d.regions).map(r => `<th class="p-1 text-center text-muted" title="${esc(d.regions[r])}">${r}</th>`).join('')}</tr></thead>
          <tbody>${Object.keys(d.regions).map(fr => `<tr><th class="p-1 text-left text-dim whitespace-nowrap" title="${esc(d.regions[fr])}">${fr} <span class="text-muted font-normal">${esc(d.regions[fr])}</span></th>${Object.keys(d.regions).map(to => { const v = P.lanes[fr + '>' + to] || 1; return `<td class="p-0.5"><input data-lane="${fr}>${to}" type="number" step="0.01" value="${v}" class="input-admin text-center px-0.5 py-1 ${v !== 1 ? 'text-[var(--orange)] font-semibold' : 'text-muted'}" style="width:58px;font-size:11px" ${fr === to ? 'disabled' : ''}></td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      </div>

      <div class="flex gap-3 mb-10">
        <button onclick="savePricingSettings()" class="flex-1 btn btn-primary py-4"><i class="fas fa-save"></i> Save market settings</button>
        <button onclick="resetPricingSettings()" class="btn btn-ghost py-4 px-6"><i class="fas fa-rotate-left"></i> Reset market settings</button>
      </div>

      <div class="p-5 rounded-xl" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <h4 class="font-semibold text-white mb-3"><i class="fas fa-flask text-[var(--orange)] mr-2"></i>Test a price <span class="text-muted text-sm font-normal">— see exactly what a customer would be quoted today</span></h4>
        <div class="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
          <div><label class="label-dark">Miles</label><input id="tMiles" type="number" value="2900" class="input-admin"></div>
          <div><label class="label-dark">Vehicle</label><select id="tType" class="input-admin">${vehicleTypeOptions('sedan')}</select></div>
          <div><label class="label-dark">Transport</label><select id="tTransport" class="input-admin"><option value="open">Open</option><option value="enclosed">Enclosed</option></select></div>
          <div><label class="label-dark">Pickup date</label><input id="tPickup" type="date" class="input-admin"></div>
          <button onclick="testPrice()" class="btn btn-cyan py-3"><i class="fas fa-calculator"></i> Price it</button>
          <div class="col-span-2 md:col-span-2"><label class="label-dark">Pickup address (optional, for lane + location checks)</label><input id="tPickupAddr" class="input-admin" placeholder="Los Angeles, CA"></div>
          <div class="col-span-2 md:col-span-3"><label class="label-dark">Delivery address (optional)</label><input id="tDeliveryAddr" class="input-admin" placeholder="Southbury, CT"></div>
        </div>
        <div id="tResult" class="mt-4 text-sm"></div>
      </div>`;
  } catch (e) { box.innerHTML = '<p class="text-red-400 text-sm">Could not load market settings.</p>'; }
}
function readPricingForm() {
  const g = id => document.getElementById(id).value;
  const season = {}; for (let m = 1; m <= 12; m++) season[m] = parseFloat(g('pSeason' + m));
  return {
    minimumPrice: parseFloat(g('pMin')), enclosedMultiplier: parseFloat(g('pEnclosed')), multiVehicleDiscountPct: parseFloat(g('pMulti')),
    fuel: { enabled: g('pFuelOn') === 'true', baselineDiesel: parseFloat(g('pFuelBase')), pctPerQuarter: parseFloat(g('pFuelPct')), minPct: parseFloat(g('pFuelMin')), maxPct: parseFloat(g('pFuelMax')) },
    season, timing: { shortNoticeDays: parseFloat(g('pShortDays')), shortNoticePct: parseFloat(g('pShortPct')), flexibleDays: parseFloat(g('pFlexDays')), flexiblePct: parseFloat(g('pFlexPct')) },
    marketPct: parseFloat(g('pMarket')),
    difficulty: { enabled: g('pDiffOn') === 'true', aiEnabled: g('pDiffAi') === 'true',
      fees: { 1: parseFloat(g('pDiffFee1')), 2: parseFloat(g('pDiffFee2')), 3: parseFloat(g('pDiffFee3')) },
      metroMiles: { 1: parseFloat(g('pDiffMiles1')), 2: parseFloat(g('pDiffMiles2')), 3: parseFloat(g('pDiffMiles3')) } },
    lanes: (() => { const out = {}; document.querySelectorAll('#laneGrid input[data-lane]').forEach(i => { const v = parseFloat(i.value); if (v && v !== 1) out[i.dataset.lane] = v; }); return out; })()
  };
}
// Location ratings list (address → tier) with a manual override
async function loadLocationRatings() {
  const box = document.getElementById('locationRatings'); if (!box) return;
  const q = document.getElementById('locSearch')?.value.trim() || '';
  try {
    const rows = await (await fetch('/api/locations' + (q ? '?q=' + encodeURIComponent(q) : ''))).json();
    if (!rows.length) { box.innerHTML = '<p class="text-muted text-sm">No addresses rated yet. Ratings appear as customers get quotes.</p>'; return; }
    box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th>Address</th><th>Nearest metro</th><th>AI says</th><th>Override</th></tr></thead><tbody class="text-dim">
      ${rows.map(r => `<tr><td class="max-w-[320px] truncate" title="${esc(r.address)}">${esc(r.address)}</td>
        <td class="text-xs">${r.metro ? esc(r.metro) + ' · ' + r.metroMiles + ' mi' : '—'}</td>
        <td class="text-xs">${r.aiTier != null ? 'Tier ' + r.aiTier : '—'}${r.reasons && r.reasons.length ? '<div class="text-muted">' + esc(r.reasons.join('; ')) + '</div>' : ''}</td>
        <td><select onchange="overrideLocation(${r.id}, this.value)" class="input-admin py-1 text-xs w-32"><option value="" ${r.overrideTier == null ? 'selected' : ''}>auto</option>${[0,1,2,3].map(t => `<option value="${t}" ${r.overrideTier === t ? 'selected' : ''}>Tier ${t}</option>`).join('')}</select></td></tr>`).join('')}
    </tbody></table></div>`;
  } catch (e) { box.innerHTML = '<p class="text-red-400 text-sm">Could not load.</p>'; }
}
async function overrideLocation(id, v) {
  await fetch('/api/locations/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrideTier: v === '' ? null : Number(v) }) });
  panelMsg('Location tier updated. New quotes for this address use it.', true);
}
async function savePricingSettings() {
  try {
    const r = await fetch('/api/settings/pricing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(readPricingForm()) });
    const d = await r.json(); if (!d.success) throw new Error(d.message || 'Save failed');
    panelMsg('Market settings saved. Every new quote uses them now.', true); loadPricingSettings();
  } catch (e) { panelMsg(e.message, false); }
}
async function resetPricingSettings() {
  if (!confirm('Reset all market settings to the defaults?')) return;
  await fetch('/api/settings/pricing', { method: 'DELETE' }); loadPricingSettings();
}
async function refreshFuel() {
  const r = await fetch('/api/settings/pricing/refresh-fuel', { method: 'POST' }); const d = await r.json();
  panelMsg(d.message || (d.success ? 'Updated' : 'Failed'), d.success); loadPricingSettings();
}
async function testPrice() {
  const out = document.getElementById('tResult'); out.innerHTML = '<span class="text-muted">Pricing…</span>';
  const r = await fetch('/api/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    vehicles: [{ type: document.getElementById('tType').value, condition: 'operable' }], distance: Number(document.getElementById('tMiles').value) || 0,
    transportType: document.getElementById('tTransport').value, pickupDate: document.getElementById('tPickup').value,
    pickup: document.getElementById('tPickupAddr').value.trim(), delivery: document.getElementById('tDeliveryAddr').value.trim() }) });
  const d = await r.json();
  if (!d.success) { out.innerHTML = '<span class="text-red-400">Could not price.</span>'; return; }
  out.innerHTML = `<div class="text-3xl font-bold text-[var(--orange)] mb-2">${money(d.total)}</div>
    <div class="text-xs text-muted mb-2">Rate used: $${d.cpm}/mile · base $${config.baseFee}</div>
    <div class="space-y-1">${d.lines.map(l => `<div class="flex justify-between gap-4 text-dim"><span>${esc(l.label)}</span><span class="${l.amount < 0 ? 'text-lime-300' : 'text-white'}">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}</div>`;
}

function resetConfig() {
  if (!confirm('Reset all calculator settings to default?')) return;
  fetch('/api/settings/calculator', { method: 'DELETE' })
    .then(r => r.json())
    .then(d => { if (!d.success) throw new Error(); location.reload(); })
    .catch(() => alert('Error resetting settings'));
}

// ==================== ORDERS MANAGEMENT ====================
const ordersView = { page: 1, limit: 50 };
const ordersFilterChanged = debounce(() => { ordersView.page = 1; loadOrders(); }, 250);

async function loadOrders() {
  try {
    const tbody = document.getElementById('ordersBody');
    if (!tbody) return; // not on the Orders page
    const q = document.getElementById('ordersSearch')?.value.trim() || '';
    const status = document.getElementById('ordersStatus')?.value || '';
    const payment = document.getElementById('ordersPayment')?.value || '';
    const params = new URLSearchParams({ page: ordersView.page, limit: ordersView.limit });
    if (q) params.set('q', q); if (status) params.set('status', status); if (payment) params.set('payment', payment);
    const res = await fetch('/api/orders?' + params);
    const data = await res.json();
    const orders = data.orders || [];
    tbody.innerHTML = '';
    renderPager(document.getElementById('ordersPager'), { page: data.page, pages: data.pages, total: data.total, limit: ordersView.limit },
      p => { ordersView.page = p; loadOrders(); }, n => { ordersView.limit = n; ordersView.page = 1; loadOrders(); });

    if (orders.length === 0) {
      document.getElementById('noOrdersMessage').classList.remove('hidden');
      return;
    }
    document.getElementById('noOrdersMessage').classList.add('hidden');

    const statusClasses = {
      'New': 'bg-blue-500/10 text-blue-400 hover:bg-blue-500/20',
      'In Work': 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20',
      'Done': 'bg-lime-500/10 text-lime-400 hover:bg-lime-500/20',
      'Canceled': 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
    };

    orders.forEach(order => {
      const tr = document.createElement('tr');
      tr.className = "cursor-pointer";
      const vehicle = [order.vehicle?.year, order.vehicle?.make, order.vehicle?.model].filter(Boolean).join(' ');
      tr.innerHTML = `
        <td>
          <div class="font-mono text-orange-400 font-semibold">${esc(order.id)}</div>
          <div class="text-[11px] text-muted mt-0.5">${order.createdAt ? new Date(order.createdAt).toLocaleDateString() : ''} · ${order.source === 'admin' ? 'Phone' : 'Website'}</div>
        </td>
        <td>
          <div class="font-medium text-white">${esc(order.contact?.fullName || '—')}</div>
          <div class="text-[11px] text-muted mt-0.5 truncate max-w-[220px]">${esc(order.contact?.email || order.contact?.phone || '')}</div>
        </td>
        <td class="text-sm col-hide-mobile">${esc(vehicle || '—')}</td>
        <td class="text-right font-semibold text-white whitespace-nowrap">${money(order.total)}</td>
        <td>
          <span onclick="event.stopImmediatePropagation(); changeOrderStatus('${esc(order.id)}', this)"
                class="status-badge ${statusClasses[order.status] || statusClasses['New']}" title="Click to change">
            ${esc(order.status || 'New')}
          </span>
        </td>
        <td>${payStatePill(order.paymentState, order)}</td>
        <td class="text-center whitespace-nowrap">
          <button onclick="event.stopImmediatePropagation(); showOrderDetail('${esc(order.id)}')"
                  class="text-cyan-400 hover:text-white p-2" title="Open">
            <i class="fas fa-eye"></i>
          </button>
          <button onclick="event.stopImmediatePropagation(); deleteOrder('${esc(order.id)}', '${esc(order.paymentState)}')"
                  class="text-red-400 hover:text-red-500 p-2" title="Delete order">
            <i class="fas fa-trash"></i>
          </button>
        </td>
      `;
      tr.onclick = (e) => {
        if (!e.target.closest('button')) showOrderDetail(order.id);
      };
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Error loading orders:', e);
  }
}


async function changeOrderStatus(orderId, element) {
  event.stopImmediatePropagation();
  const currentStatus = element.textContent.trim();
  const statuses = ['New', 'In Work', 'Done'];
  let nextStatus = statuses[(statuses.indexOf(currentStatus) + 1) % 3];

  if (confirm(`Change status of order ${orderId} to "${nextStatus}"?`)) {
    try {
      const res = await fetch(`/api/orders/${orderId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus })
      });

      if (res.ok) loadOrders();
    } catch (err) {
      alert('Error updating status');
    }
  }
}

async function deleteOrder(orderId, state) {
  const holdNote = state === 'holding' ? '\n\nThis order has an active card hold. Deleting it releases the hold (customer pays nothing).' : '';
  if (!confirm(`Delete order ${orderId} permanently? This cannot be undone.${holdNote}`)) return;
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.success) throw new Error(d.message || 'Could not delete the order');
    closeModal();
    if (document.getElementById('ordersBody')) loadOrders();
    if (document.getElementById('paymentsBody')) loadPayments();
    panelMsg(`Order ${orderId} deleted${d.released ? ' and its card hold released' : ''}.`, true);
  } catch (err) {
    panelMsg(err.message, false);
  }
}

async function showOrderDetail(orderId, { fromHistory = false } = {}) {
  try {
    const res = await fetch('/api/orders/' + encodeURIComponent(orderId));
    const order = await res.json();
    if (!order || !order.id) return;
    if (!fromHistory) detailPush('order', order.id); else updateBackButtons();
    document.getElementById('customerDetailModal')?.classList.add('hidden');

    document.getElementById('modalOrderId').textContent = `Order ${order.id}`;
    const delBtn = document.getElementById('orderDeleteBtn');
    if (delBtn) delBtn.onclick = () => deleteOrder(order.id, order.paymentState);
    order.status = String(order.status || 'New');

    // Support both old (single vehicle) and new (multi-vehicle) format
    const vehicleList = order.vehicles && order.vehicles.length
      ? order.vehicles
      : [order.vehicle || {}];

    const location = order.location || {};
    const contact  = order.contact  || {};

    const vehiclesHTML = vehicleList.map((vehicle, idx) => `
      <div class="border border-[var(--line)] rounded-xl p-5 ${idx > 0 ? 'mt-4' : ''}">
        <div class="flex items-center gap-2 mb-3">
          <i class="fas fa-car text-[var(--orange)] text-xs"></i>
          <h4 class="font-semibold text-white text-sm">Vehicle ${idx + 1}${vehicleList.length > 1 ? ' of ' + vehicleList.length : ''}</h4>
        </div>
        <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <p><strong>Year:</strong> ${esc(vehicle.year || '—')}</p>
          <p><strong>Make:</strong> ${esc(vehicle.make || '—')}</p>
          <p><strong>Model:</strong> ${esc(vehicle.model || '—')}</p>
          <p><strong>VIN:</strong> ${esc(vehicle.vin || '—')}</p>
          <p><strong>Type:</strong> ${esc(vehicle.type || '—')}</p>
          <p><strong>Condition:</strong> ${esc(vehicle.condition || '—')}</p>
          <p><strong>Runs &amp; drives:</strong> ${vehicle.runsAndDrives ? 'Yes' : 'No'}</p>
          <p><strong>Has keys:</strong> ${vehicle.hasKeys ? 'Yes' : 'No'}</p>
          <p><strong>Modified:</strong> ${vehicle.modified ? 'Yes' : 'No'}</p>
          <p><strong>Urgent:</strong> ${vehicle.urgent ? 'Yes' : 'No'}</p>
          ${vehicle.modDescription ? `<p class="col-span-2"><strong>Modifications:</strong> ${esc(vehicle.modDescription)}</p>` : ''}
          ${vehicle.damages ? `<p class="col-span-2 text-amber-400"><strong class="text-amber-400">Damages:</strong> ${esc(vehicle.damages)}</p>` : ''}
        </div>
        ${vehicle.photos && vehicle.photos.length ? `
          <div class="mt-4">
            <strong class="text-white text-sm block mb-2">Photos (${vehicle.photos.length})</strong>
            <div class="grid grid-cols-3 gap-2">
              ${vehicle.photos.map(p => {
                if (p?.url && /^\/uploads\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?\.[a-z]+$/.test(p.url)) return p.url;
                if (/^data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+$/.test(p?.data || '')) return p.data;
                return null;
              }).filter(Boolean).map(src => `
                <a href="${src}" target="_blank" rel="noopener"><img src="${src}" class="rounded-lg border border-[var(--line)] object-cover h-24 w-full" alt="vehicle photo"></a>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `).join('');

    const html = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 modal-grid">
        <div>
          <h4 class="font-semibold text-white mb-3">Contact Information</h4>
          <p><strong>Name:</strong> ${esc(contact.fullName || '—')}</p>
          <p><strong>Email:</strong> ${esc(contact.email || '—')}</p>
          <p><strong>Phone:</strong> ${esc(contact.phone || '—')}</p>
          ${contact.company ? `<p><strong>Company:</strong> ${esc(contact.company)}</p>` : ''}
          ${order.customerId ? `
            <button onclick="showCustomerDetail(${order.customerId})"
                    class="text-cyan-400 hover:text-white text-sm mt-3 inline-flex items-center gap-1">
              <i class="fas fa-user"></i> View customer &amp; all their orders
            </button>` : ''}
        </div>
        <div>
          <h4 class="font-semibold text-white mb-3">Route &amp; Dates</h4>
          <p><strong>Pickup:</strong> ${esc(location.pickup || '—')}</p>
          <p><strong>Delivery:</strong> ${esc(location.delivery || '—')}</p>
          <p class="mt-2"><strong>First possible:</strong> ${esc(order.pickupDate || '—')}</p>
          <p><strong>Must deliver by:</strong> ${esc(order.mustDeliverBy || '—')}</p>
          <p class="mt-2"><strong>Transport:</strong> ${esc(order.transportType || '—')}</p>
          ${order.distance ? `<p><strong>Distance:</strong> ${Number(order.distance).toLocaleString()} mi</p>` : ''}
        </div>
      </div>

      <div class="mt-8">
        <h4 class="font-semibold text-white mb-3">
          Vehicles
          <span class="text-xs font-normal text-muted ml-2">(${vehicleList.length} vehicle${vehicleList.length > 1 ? 's' : ''})</span>
        </h4>
        ${vehiclesHTML}
      </div>

      ${order.notes ? `
        <div class="mt-6 bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 text-sm">
          <strong class="text-white block mb-1"><i class="fas fa-note-sticky mr-1 text-[var(--orange)]"></i> Internal notes</strong>
          <span class="whitespace-pre-line">${esc(order.notes)}</span>
        </div>` : ''}

      ${order.pricing && order.pricing.lines && order.pricing.lines.length ? `
      <div class="mt-8 bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-5">
        <h4 class="font-semibold text-white mb-1"><i class="fas fa-chart-line text-[var(--orange)] mr-2"></i>How this price was built <span class="text-muted text-xs font-normal">(admin only)</span></h4>
        <p class="text-xs text-muted mb-3">Rate used: $${order.pricing.cpm}/mile. Every layer that touched this quote:</p>
        <div class="space-y-1 text-sm">${order.pricing.lines.map(l => `<div class="flex justify-between gap-4"><span class="text-dim">${esc(l.label)}</span><span class="${l.amount < 0 ? 'text-lime-300' : 'text-white'} whitespace-nowrap">${l.amount < 0 ? '−' : ''}${money(Math.abs(l.amount))}</span></div>`).join('')}</div>
        ${order.pricing.quotedTotal != null && order.pricing.quotedTotal !== order.total ? `<p class="text-xs text-amber-300 mt-3">Engine total was ${money(order.pricing.quotedTotal)}; the order total is ${money(order.total)} (adjusted by admin).</p>` : ''}
      </div>` : ''}
      ${confirmationPanelHTML(order)}

      <div class="mt-10 pt-6 border-t border-[var(--line)] flex justify-between items-center">
        <div>
          <p class="text-muted text-sm">Total Amount</p>
          <p class="text-4xl font-bold text-[var(--orange)]">$${Number(order.total || 0).toLocaleString()}
            ${['unpaid', 'pending', 'released', 'expired'].includes(order.paymentState)
              ? `<button onclick="editOrderPrice('${esc(order.id)}', ${Number(order.total) || 0})" class="ml-2 align-middle text-sm text-cyan-400 hover:text-white" title="Change the quoted price (admin only)"><i class="fas fa-pen-to-square"></i> Edit</button>`
              : `<span class="ml-2 align-middle text-xs text-muted" title="Locked while a card hold or charge exists"><i class="fas fa-lock"></i></span>`}
          </p>
          ${paymentSummaryLine(order)}
        </div>
        <div class="text-right">
          <p class="text-muted text-sm">Status</p>
          <span class="status-badge ${order.status === 'Done' ? 'bg-lime-500/10 text-lime-400' : order.status === 'In Work' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'}">
            ${order.status || 'New'}
          </span>
        </div>
      </div>
    `;

    document.getElementById('modalContent').innerHTML = html;
    document.getElementById('orderModal').classList.remove('hidden');
  } catch (e) {
    console.error(e);
  }
}

function closeModal() {
  document.getElementById('orderModal').classList.add('hidden');
  detailReset();
}

async function toggleOrderPayment(orderId, paymentStatus) {
  try {
    const res = await fetch(`/api/orders/${orderId}/payment`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentStatus })
    });
    if (!res.ok) throw new Error();
    loadOrders();
    showOrderDetail(orderId);
  } catch (e) { alert('Error updating payment status'); }
}

// ==================== CUSTOMERS ====================
const CUSTOMER_TYPE_LABELS = { dealer: 'Dealer', auction: 'Auction', oem: 'OEM', fleet: 'Fleet', individual: 'Individual', other: 'Other' };
const VEHICLE_TYPE_LABELS  = {
  'sedan': 'Sedan / Compact SUV', 'mid-suv': 'Mid-size SUV', 'mini-van': 'Mini Van', 'full-suv': 'Full-size SUV',
  'pickup': 'Pick-up Truck', 'cargo-van': 'Cargo Van', 'passenger-van': 'Passenger Van', 'other': 'Other'
};
const GOOGLE_MAPS_KEY = window.MC_GOOGLE_MAPS_KEY || ''; // injected by views/admin/_head.ejs from .env

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
function typeBadge(t) {
  const key = CUSTOMER_TYPE_LABELS[t] ? t : 'individual';
  return `<span class="type-badge type-${key}">${CUSTOMER_TYPE_LABELS[key]}</span>`;
}
function typeOptions(selected) {
  return Object.entries(CUSTOMER_TYPE_LABELS)
    .map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}
function vehicleTypeOptions(selected) {
  return Object.entries(VEHICLE_TYPE_LABELS)
    .map(([v, l]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${l}</option>`).join('');
}
function yearOptions(selected) {
  let h = '<option value="">Select year</option>';
  for (let y = 2030; y >= 1900; y--) h += `<option value="${y}" ${String(y) === String(selected) ? 'selected' : ''}>${y}</option>`;
  return h;
}
// One pill per order for the money situation (server computes paymentState)
const PAY_STATE_LABELS = {
  unpaid:             ['No card yet',          'pay-unpaid',   'No confirmation sent — nothing on the customer\'s card'],
  pending:            ['Awaiting card',        'pay-wait',     'Confirmation emailed — waiting for the customer to authorize'],
  holding:            ['On hold · not charged','pay-hold',     'Card authorized. Money is reserved, NOT taken. Charge at pickup, or Release for no fee'],
  charged:            ['Charged',              'pay-paid',     'Money collected'],
  partially_refunded: ['Partly refunded',      'pay-fee',      'Part of the charge was refunded'],
  refunded:           ['Refunded',             'pay-released', 'Fully refunded (Stripe fee not returned)'],
  fee_charged:        ['No-show fee charged',  'pay-fee',      'Only the no-show fee was collected'],
  released:           ['Released · $0',        'pay-released', 'Hold cancelled. Customer paid nothing, no Stripe fee'],
  expired:            ['Hold expired',         'pay-unpaid',   'Nobody charged or released within 7 days — send a new confirmation']
};
function payStatePill(state, o) {
  const [label, cls, title] = PAY_STATE_LABELS[state] || [state || '—', 'pay-released', ''];
  const dispute = o && o.disputeStatus === 'open' ? ' <span class="pay-pill pay-unpaid" style="margin-left:4px" title="The customer&#39;s bank opened a chargeback. See the order notes">Chargeback</span>' : '';
  return `<span class="pay-pill ${cls}" style="margin-left:0" title="${esc(title)}">${label}</span>${dispute}`;
}
function paymentPill(o) { return payStatePill(o.paymentState); }

let customersCache = [];
let customerSearchTimer = null;

const customersView = { page: 1, limit: 50 };
async function loadCustomers() {
  const tbody = document.getElementById('customersBody');
  if (!tbody) return; // not on the Customers page
  const q = document.getElementById('customerSearch')?.value.trim() || '';
  try {
    const params = new URLSearchParams({ page: customersView.page, limit: customersView.limit });
    if (q) params.set('q', q);
    const data = await (await fetch('/api/customers?' + params)).json();
    customersCache = data.customers || [];
    tbody.innerHTML = '';
    document.getElementById('customerCount').textContent = data.total || 0;
    renderPager(document.getElementById('customersPager'), { page: data.page, pages: data.pages, total: data.total, limit: customersView.limit },
      p => { customersView.page = p; loadCustomers(); }, n => { customersView.limit = n; customersView.page = 1; loadCustomers(); });

    const empty = document.getElementById('noCustomersMessage');
    if (!customersCache.length) { empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');

    customersCache.forEach(c => {
      const tr = document.createElement('tr');
      tr.className = 'cursor-pointer';
      tr.innerHTML = `
        <td class="font-medium text-white">
          ${esc(c.name)}
          ${c.company ? `<div class="text-xs text-muted font-normal">${esc(c.company)}</div>` : ''}
        </td>
        <td class="text-sm col-hide-mobile">
          ${c.email ? esc(c.email) : '<span class="text-muted">—</span>'}
          ${c.phone ? `<div class="text-xs text-muted">${esc(c.phone)}</div>` : ''}
        </td>
        <td>${typeBadge(c.type)}</td>
        <td class="text-center">${c.orderCount}</td>
        <td class="font-semibold text-[var(--orange)]">$${Number(c.totalSpent).toLocaleString()}</td>
        <td class="text-xs col-hide-mobile">${fmtDate(c.lastOrderAt)}</td>
        <td class="text-center whitespace-nowrap">
          <button onclick="event.stopImmediatePropagation(); showCustomerDetail(${c.id})" class="text-cyan-400 hover:text-white p-2" title="View"><i class="fas fa-eye"></i></button>
          <button onclick="event.stopImmediatePropagation(); openCustomerWizard(${c.id})" class="text-[var(--orange)] hover:text-white p-2" title="New quote"><i class="fas fa-file-invoice-dollar"></i></button>
          <button onclick="event.stopImmediatePropagation(); openCustomerEdit(${c.id})" class="text-lime-400 hover:text-white p-2" title="Edit"><i class="fas fa-pencil"></i></button>
          <button onclick="event.stopImmediatePropagation(); deleteCustomer(${c.id})" class="text-red-400 hover:text-red-300 p-2" title="Delete"><i class="fas fa-trash"></i></button>
        </td>`;
      tr.onclick = (e) => { if (!e.target.closest('button')) showCustomerDetail(c.id); };
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error('Error loading customers:', e);
  }
}

function onCustomerSearch() {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => { customersView.page = 1; loadCustomers(); }, 250);
}

async function showCustomerDetail(id, { fromHistory = false } = {}) {
  try {
    const res = await fetch('/api/customers/' + id);
    const c = await res.json();
    if (!c || !c.id) return;
    if (!fromHistory) detailPush('customer', c.id); else updateBackButtons();
    document.getElementById('orderModal')?.classList.add('hidden');

    document.getElementById('customerDetailName').textContent = c.name;
    document.getElementById('customerDetailQuoteBtn').onclick = () => { closeCustomerDetail(); openCustomerWizard(c.id); };
    document.getElementById('customerDetailEditBtn').onclick  = () => { closeCustomerDetail(); openCustomerEdit(c.id); };

    const orders = c.orders || [];
    const orderRows = orders.map(o => {
      const v = o.vehicle || {};
      const count = o.vehicles?.length || 1;
      const label = count > 1 ? `${count} vehicles` : [v.year, v.make, v.model].filter(Boolean).join(' ') || '—';
      const from = (o.location?.pickup || '').split(',')[0];
      const to   = (o.location?.delivery || '').split(',')[0];
      return `
        <tr class="cursor-pointer" onclick="showOrderDetail('${esc(o.id)}')">
          <td class="font-mono text-orange-400">${esc(o.id)}</td>
          <td class="text-xs">${fmtDate(o.createdAt)}</td>
          <td class="text-sm">${esc(label)}</td>
          <td class="text-sm col-hide-mobile">${esc(from)} → ${esc(to)}</td>
          <td class="font-semibold text-[var(--orange)]">$${Number(o.total || 0).toLocaleString()}</td>
          <td><span class="status-badge ${o.status === 'Done' ? 'bg-lime-500/10 text-lime-400' : o.status === 'In Work' ? 'bg-amber-500/10 text-amber-400' : 'bg-blue-500/10 text-blue-400'}">${esc(o.status || 'New')}</span>${paymentPill(o)}</td>
        </tr>`;
    }).join('');

    document.getElementById('customerDetailContent').innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-8 modal-grid">
        <div class="space-y-2 text-sm">
          <div class="mb-3">${typeBadge(c.type)}</div>
          <p><strong>Email:</strong> ${c.email ? `<a href="mailto:${esc(c.email)}" class="text-cyan-400 hover:text-white">${esc(c.email)}</a>` : '—'}</p>
          <p><strong>Phone:</strong> ${c.phone ? `<a href="tel:${esc(c.phone)}" class="text-cyan-400 hover:text-white">${esc(c.phone)}</a>` : '—'}</p>
          <p><strong>Company:</strong> ${c.company ? esc(c.company) : '—'}</p>
          <p><strong>Customer since:</strong> ${fmtDate(c.createdAt)}</p>
        </div>
        <div class="grid grid-cols-3 gap-3">
          <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 text-center">
            <div class="text-2xl font-bold text-white">${c.orderCount}</div>
            <div class="text-xs text-muted mt-1">Orders</div>
          </div>
          <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 text-center">
            <div class="text-2xl font-bold text-[var(--orange)]">$${Number(c.totalSpent).toLocaleString()}</div>
            <div class="text-xs text-muted mt-1">Total</div>
          </div>
          <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 text-center">
            <div class="text-sm font-bold text-white pt-1">${fmtDate(c.lastOrderAt)}</div>
            <div class="text-xs text-muted mt-1">Last order</div>
          </div>
        </div>
      </div>
      ${c.notes ? `
        <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 text-sm">
          <strong class="text-white block mb-1"><i class="fas fa-note-sticky mr-1 text-[var(--orange)]"></i> Notes</strong>
          <span class="whitespace-pre-line">${esc(c.notes)}</span>
        </div>` : ''}
      <div>
        <h4 class="font-semibold text-white mb-3">Order History <span class="text-xs font-normal text-muted ml-2">(${orders.length})</span></h4>
        ${orders.length ? `
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead><tr><th>Order</th><th>Date</th><th>Vehicle</th><th class="col-hide-mobile">Route</th><th>Total</th><th>Status</th></tr></thead>
              <tbody class="text-dim">${orderRows}</tbody>
            </table>
          </div>` : '<p class="text-muted text-sm">No orders yet.</p>'}
      </div>`;

    document.getElementById('customerDetailModal').classList.remove('hidden');
  } catch (e) {
    console.error(e);
  }
}

function closeCustomerDetail() {
  document.getElementById('customerDetailModal').classList.add('hidden');
  detailReset();
}

// Look a customer up in the loaded list, falling back to the API (e.g. deep links)
async function getCustomer(id) {
  const cached = customersCache.find(x => x.id === id);
  if (cached) return cached;
  try {
    const c = await (await fetch('/api/customers/' + id)).json();
    return c && c.id ? c : null;
  } catch (e) { return null; }
}

async function openCustomerEdit(id) {
  const c = await getCustomer(id);
  if (!c) return;
  document.getElementById('ceId').value      = c.id;
  document.getElementById('ceName').value    = c.name || '';
  document.getElementById('cePhone').value   = c.phone || '';
  document.getElementById('ceEmail').value   = c.email || '';
  document.getElementById('ceCompany').value = c.company || '';
  document.getElementById('ceType').innerHTML = typeOptions(c.type || 'individual');
  document.getElementById('ceNotes').value   = c.notes || '';
  document.getElementById('ceError').classList.add('hidden');
  document.getElementById('customerEditModal').classList.remove('hidden');
}

function closeCustomerEdit() {
  document.getElementById('customerEditModal').classList.add('hidden');
}

async function saveCustomerEdit() {
  const id  = document.getElementById('ceId').value;
  const err = document.getElementById('ceError');
  err.classList.add('hidden');
  try {
    const res = await fetch('/api/customers/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:    document.getElementById('ceName').value,
        phone:   document.getElementById('cePhone').value,
        email:   document.getElementById('ceEmail').value,
        company: document.getElementById('ceCompany').value,
        type:    document.getElementById('ceType').value,
        notes:   document.getElementById('ceNotes').value
      })
    });
    const data = await res.json();
    if (!data.success) { err.textContent = data.message || 'Error saving customer'; err.classList.remove('hidden'); return; }
    closeCustomerEdit();
    loadCustomers();
  } catch (e) {
    err.textContent = 'Connection error'; err.classList.remove('hidden');
  }
}

async function deleteCustomer(id) {
  const c = customersCache.find(x => x.id === id);
  if (!confirm(`Delete customer "${c?.name || id}"? Their orders will be kept but unlinked.`)) return;
  try {
    await fetch('/api/customers/' + id, { method: 'DELETE' });
    loadCustomers();
  } catch (e) { alert('Error deleting customer'); }
}

// ==================== CUSTOMER INTAKE WIZARD (phone-in quote) ====================
// Mirrors the /payment wizard: Customer → Vehicles → Route → Quote. Saves an
// order with source 'admin' + paymentStatus 'unpaid' and upserts the customer.
const WIZ_STEPS = ['Customer', 'Vehicles', 'Route', 'Quote'];
let wiz = null;
let wizVehicleTab = 0;
let wizDistanceService = null;

function wizFreshVehicle() {
  return {
    year: '', make: '', model: '', vin: '',
    type: 'sedan', condition: 'operable',
    runsAndDrives: true, hasKeys: true,
    modified: false, modDescription: '',
    urgent: false, damages: '', photos: []
  };
}

async function openCustomerWizard(customerId) {
  const c = customerId ? await getCustomer(customerId) : null;
  wiz = {
    step: 0,
    customerId: c ? c.id : null,
    customer: {
      name: c?.name || '', email: c?.email || '', phone: c?.phone || '',
      company: c?.company || '', type: c?.type || 'individual', notes: c?.notes || ''
    },
    vehicles: [wizFreshVehicle()],
    location: { pickup: '', delivery: '' },
    distance: '', pickupDate: '', mustDeliverBy: '', transportType: 'open',
    finalPrice: null, notes: ''
  };
  wizVehicleTab = 0;
  document.getElementById('wizTitle').textContent = c ? `New Quote — ${c.name}` : 'New Customer / Quote';
  wizRender(0);
  document.getElementById('customerWizardModal').classList.remove('hidden');
}

function closeCustomerWizard() {
  if (wiz) {
    wizCollect();
    const dirty = wiz.step > 0 || wiz.customer.name || wiz.customer.phone;
    if (dirty && !confirm('Discard this intake? Unsaved details will be lost.')) return;
  }
  wiz = null;
  document.getElementById('customerWizardModal').classList.add('hidden');
}

function wizRenderSteps() {
  document.getElementById('wizSteps').innerHTML = WIZ_STEPS.map((s, i) => `
    <span class="wiz-step ${i === wiz.step ? 'active' : i < wiz.step ? 'done' : ''}">
      <span>${i < wiz.step ? '<i class="fas fa-check"></i>' : i + 1}</span> ${s}
    </span>`).join('');
  document.getElementById('wizPrevBtn').classList.toggle('invisible', wiz.step === 0);
  document.getElementById('wizNextBtn').classList.toggle('hidden', wiz.step === 3);
  document.getElementById('wizSaveBtn').classList.toggle('hidden', wiz.step !== 3);
  wizUpdateRunningTotal();
}

function wizRender(step) {
  wiz.step = step;
  const el = document.getElementById('wizContent');
  if (step === 0) {
    el.innerHTML = wizCustomerHTML();
  } else if (step === 1) {
    el.innerHTML = `
      <h4 class="text-lg font-semibold text-white mb-4">Vehicle Details</h4>
      <div id="wizVehicleTabs" class="flex flex-nowrap gap-2 mb-4 overflow-x-auto pb-1" style="scrollbar-width:none;"></div>
      <div id="wizVehicleForm"></div>`;
    wizRenderVehicleTabs();
    wizRenderVehicle(wizVehicleTab);
  } else if (step === 2) {
    el.innerHTML = wizRouteHTML();
    wizInitMaps();
  } else {
    el.innerHTML = '<p class="text-muted text-sm"><i class="fas fa-circle-notch fa-spin mr-1"></i> Pricing this route…</p>';
    wizFetchServerPrice().then(() => { el.innerHTML = wizQuoteHTML(); wizPriceDiff(); wizUpdateRunningTotal(); });
  }
  wizRenderSteps();
  el.scrollTop = 0;
}

// Pull the current step's DOM values into `wiz`
function wizCollect() {
  const g = id => document.getElementById(id);
  if (wiz.step === 0 && g('wc-name')) {
    wiz.customer = {
      name: g('wc-name').value.trim(), email: g('wc-email').value.trim(), phone: g('wc-phone').value.trim(),
      company: g('wc-company').value.trim(), type: g('wc-type').value, notes: g('wc-notes').value.trim()
    };
  } else if (wiz.step === 1) {
    wizSaveVehicle(wizVehicleTab);
  } else if (wiz.step === 2 && g('wr-pickup')) {
    wiz.location = { ...wiz.location, pickup: g('wr-pickup').value.trim(), delivery: g('wr-delivery').value.trim() };
    wiz.distance = g('wr-distance').value;
    wiz.pickupDate = g('wr-pickupDate').value;
    wiz.mustDeliverBy = g('wr-deliverBy').value;
  } else if (wiz.step === 3 && g('wizFinalPrice')) {
    wiz.finalPrice = g('wizFinalPrice').value;
    wiz.priceReason = (g('wizPriceReason')?.value || '').trim();
    wiz.noShowFee = g('wizNoShowFee')?.value ?? wiz.noShowFee;
    wiz.notes = g('wizNotes').value.trim();
  }
}

function wizValidate() {
  let ok = true;
  document.querySelectorAll('#wizContent .error-msg').forEach(e => e.textContent = '');
  document.querySelectorAll('#wizContent .input-dark').forEach(e => e.classList.remove('error'));
  const fail = (id, msg) => {
    document.getElementById(id)?.classList.add('error');
    const e = document.getElementById(id + '-err');
    if (e) e.textContent = msg;
    ok = false;
  };

  if (wiz.step === 0) {
    if (!wiz.customer.name)  fail('wc-name',  'Name is required');
    if (!wiz.customer.phone) fail('wc-phone', 'Phone is required');
    if (wiz.customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(wiz.customer.email)) fail('wc-email', 'Invalid email address');
  } else if (wiz.step === 1) {
    for (let i = 0; i < wiz.vehicles.length; i++) {
      const v = wiz.vehicles[i];
      if (!v.year || !v.make || !v.model) {
        if (i !== wizVehicleTab) { wizVehicleTab = i; wizRenderVehicleTabs(); wizRenderVehicle(i); }
        if (!v.year)  fail('wv-year-' + i,  'Year is required');
        if (!v.make)  fail('wv-make-' + i,  'Make is required');
        if (!v.model) fail('wv-model-' + i, 'Model is required');
        break;
      }
    }
  } else if (wiz.step === 2) {
    if (!wiz.location.pickup)      fail('wr-pickup',     'Pickup address is required');
    if (!wiz.location.delivery)    fail('wr-delivery',   'Delivery address is required');
    if (!(Number(wiz.distance) > 0)) fail('wr-distance', 'Enter the distance in miles');
    if (!wiz.pickupDate)           fail('wr-pickupDate', 'Pickup date is required');
    if (!wiz.mustDeliverBy)        fail('wr-deliverBy',  'Deliver-by date is required');
  }
  return ok;
}

function wizNext() { wizCollect(); if (!wizValidate()) return; wizRender(wiz.step + 1); }
function wizPrev() { wizCollect(); if (wiz.step > 0) wizRender(wiz.step - 1); }

// ---- Step 0: Customer ----
function wizCustomerHTML() {
  const c = wiz.customer;
  return `
    <h4 class="text-lg font-semibold text-white mb-4">Customer Information</h4>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="label-dark">Full Name <span class="text-red-400">*</span></label>
        <input id="wc-name" class="input-dark" value="${esc(c.name)}" autocomplete="off">
        <div id="wc-name-err" class="error-msg"></div>
      </div>
      <div>
        <label class="label-dark">Phone <span class="text-red-400">*</span></label>
        <input id="wc-phone" type="tel" class="input-dark" value="${esc(c.phone)}" autocomplete="off">
        <div id="wc-phone-err" class="error-msg"></div>
      </div>
      <div>
        <label class="label-dark">Email</label>
        <input id="wc-email" type="email" class="input-dark" value="${esc(c.email)}" autocomplete="off" placeholder="Optional — used to link future web orders">
        <div id="wc-email-err" class="error-msg"></div>
      </div>
      <div>
        <label class="label-dark">Company</label>
        <input id="wc-company" class="input-dark" value="${esc(c.company)}" autocomplete="off">
      </div>
      <div>
        <label class="label-dark">Customer Type</label>
        <select id="wc-type" class="input-dark">${typeOptions(c.type)}</select>
      </div>
      <div class="sm:col-span-2">
        <label class="label-dark">Customer Notes</label>
        <textarea id="wc-notes" class="input-dark" placeholder="How they found us, preferences, best time to call…">${esc(c.notes)}</textarea>
      </div>
    </div>`;
}

// ---- Step 1: Vehicles ----
function wizRenderVehicleTabs() {
  const c = document.getElementById('wizVehicleTabs');
  if (!c) return;
  c.innerHTML = wiz.vehicles.map((v, i) => `
    <button type="button" class="vehicle-tab ${i === wizVehicleTab ? 'active' : ''}" onclick="wizSwitchVehicle(${i})">
      Vehicle ${i + 1}${wiz.vehicles.length > 1 ? `<span class="remove-vtab" onclick="wizRemoveVehicle(event, ${i})">×</span>` : ''}
    </button>`).join('') +
    `<button type="button" class="add-vehicle-tab" onclick="wizAddVehicle()"><i class="fas fa-plus"></i> Add Vehicle</button>`;
}

function wizSwitchVehicle(i) {
  wizSaveVehicle(wizVehicleTab);
  wizVehicleTab = i;
  wizRenderVehicleTabs();
  wizRenderVehicle(i);
}

function wizAddVehicle() {
  wizSaveVehicle(wizVehicleTab);
  wiz.vehicles.push(wizFreshVehicle());
  wizSwitchVehicle(wiz.vehicles.length - 1);
  wizUpdateRunningTotal();
}

function wizRemoveVehicle(e, i) {
  e.stopPropagation();
  if (wiz.vehicles.length <= 1) return;
  if (i !== wizVehicleTab) wizSaveVehicle(wizVehicleTab);
  wiz.vehicles.splice(i, 1);
  if (i < wizVehicleTab) wizVehicleTab--;
  if (wizVehicleTab >= wiz.vehicles.length) wizVehicleTab = wiz.vehicles.length - 1;
  wizRenderVehicleTabs();
  wizRenderVehicle(wizVehicleTab);
  wizUpdateRunningTotal();
}

function wizVehicleHTML(i, v) {
  return `
    <div class="space-y-5">
      <div>
        <label class="label-dark">VIN <span class="text-muted font-normal">(auto-fills year / make / model)</span></label>
        <div class="flex gap-2">
          <input id="wv-vin-${i}" class="input-dark uppercase tracking-widest" maxlength="17"
                 placeholder="1HGCM82633A123456" value="${esc(v.vin)}" autocomplete="off">
          <button type="button" onclick="wizDecodeVin(${i})" class="btn btn-cyan px-4 shrink-0">
            <i class="fas fa-magnifying-glass"></i> Decode
          </button>
        </div>
        <div id="wv-vinResult-${i}" class="vin-result mt-2 text-sm hidden"></div>
        <div id="wv-vinError-${i}" class="mt-2 text-sm text-red-400 hidden"></div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label class="label-dark">Year <span class="text-red-400">*</span></label>
          <select id="wv-year-${i}" class="input-dark">${yearOptions(v.year)}</select>
          <div id="wv-year-${i}-err" class="error-msg"></div>
        </div>
        <div>
          <label class="label-dark">Make <span class="text-red-400">*</span></label>
          <input id="wv-make-${i}" class="input-dark" value="${esc(v.make)}" autocomplete="off">
          <div id="wv-make-${i}-err" class="error-msg"></div>
        </div>
        <div>
          <label class="label-dark">Model <span class="text-red-400">*</span></label>
          <input id="wv-model-${i}" class="input-dark" value="${esc(v.model)}" autocomplete="off">
          <div id="wv-model-${i}-err" class="error-msg"></div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="label-dark">Vehicle Type</label>
          <select id="wv-type-${i}" class="input-dark" onchange="wizSaveVehicle(${i}); wizUpdateRunningTotal()">${vehicleTypeOptions(v.type)}</select>
        </div>
        <div>
          <label class="label-dark">Condition</label>
          <div class="flex gap-5 pt-3">
            <label class="flex items-center gap-2 cursor-pointer text-white">
              <input type="radio" name="wv-cond-${i}" value="operable" ${v.condition !== 'inoperable' ? 'checked' : ''}
                     onchange="wizSaveVehicle(${i}); wizUpdateRunningTotal()"> Operable
            </label>
            <label class="flex items-center gap-2 cursor-pointer text-white">
              <input type="radio" name="wv-cond-${i}" value="inoperable" ${v.condition === 'inoperable' ? 'checked' : ''}
                     onchange="wizSaveVehicle(${i}); wizUpdateRunningTotal()"> Inoperable
              <span class="text-xs text-muted">(+$${config.addons.inoperable})</span>
            </label>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <label class="label-dark">Runs and drives</label>
          <select id="wv-runs-${i}" class="input-dark">
            <option value="yes" ${v.runsAndDrives !== false ? 'selected' : ''}>Yes</option>
            <option value="no"  ${v.runsAndDrives === false ? 'selected' : ''}>No</option>
          </select>
        </div>
        <div>
          <label class="label-dark">Has keys</label>
          <select id="wv-keys-${i}" class="input-dark">
            <option value="yes" ${v.hasKeys !== false ? 'selected' : ''}>Yes</option>
            <option value="no"  ${v.hasKeys === false ? 'selected' : ''}>No</option>
          </select>
        </div>
      </div>

      <div class="space-y-3">
        <label class="flex items-center gap-3 cursor-pointer text-white">
          <input type="checkbox" id="wv-modified-${i}" ${v.modified ? 'checked' : ''}
                 onchange="document.getElementById('wv-modBlock-${i}').classList.toggle('hidden', !this.checked); wizSaveVehicle(${i}); wizUpdateRunningTotal()">
          Modified / Custom vehicle <span class="text-xs text-muted">(+$${config.addons.modified})</span>
        </label>
        <div id="wv-modBlock-${i}" class="${v.modified ? '' : 'hidden'}">
          <textarea id="wv-modDesc-${i}" class="input-dark" placeholder="Lifted, lowered, oversized tires, wide body, snow plow…">${esc(v.modDescription)}</textarea>
        </div>
        <label class="flex items-center gap-3 cursor-pointer text-white">
          <input type="checkbox" id="wv-urgent-${i}" ${v.urgent ? 'checked' : ''}
                 onchange="wizSaveVehicle(${i}); wizUpdateRunningTotal()">
          Urgent Delivery <span class="text-xs text-muted">(+$${config.addons.urgent})</span>
        </label>
      </div>


      <div>
        <label class="label-dark">Vehicle Photos <span class="text-muted font-normal">(optional, up to 8)</span></label>
        <div class="upload-zone p-5 text-center">
          <input type="file" id="wv-photos-${i}" accept="image/*" multiple class="hidden">
          <label for="wv-photos-${i}" class="cursor-pointer block">
            <i class="fas fa-cloud-upload-alt text-2xl text-[var(--orange)] mb-1"></i>
            <span class="text-[var(--orange)] font-medium block text-sm">Upload photos</span>
          </label>
        </div>
        <div id="wv-photoPreview-${i}" class="mt-3 grid grid-cols-3 sm:grid-cols-4 gap-3"></div>
      </div>
      <div>
        <label class="label-dark">Notes about this vehicle <span class="text-muted font-normal">(damage, missing parts, special instructions)</span></label>
        <textarea id="wv-damages-${i}" class="input-dark" maxlength="1000" placeholder="Dents, scratches, missing parts, leaks, flat tires, gate codes, anything the driver should know…">${esc(v.damages)}</textarea>
      </div>
    </div>`;
}

function wizRenderVehicle(i) {
  const fc = document.getElementById('wizVehicleForm');
  if (!fc) return;
  fc.innerHTML = wizVehicleHTML(i, wiz.vehicles[i]);
  wizRenderPhotos(i);
  document.getElementById('wv-photos-' + i).addEventListener('change', (e) => wizAddPhotos(i, e.target));
  let vinTimer;
  document.getElementById('wv-vin-' + i).addEventListener('input', (e) => {
    clearTimeout(vinTimer);
    if (e.target.value.trim().length === 17) vinTimer = setTimeout(() => wizDecodeVin(i), 500);
  });
}

function wizSaveVehicle(i) {
  const g = id => document.getElementById(id + '-' + i);
  if (!g('wv-year') || !wiz.vehicles[i]) return;
  Object.assign(wiz.vehicles[i], {
    vin:           g('wv-vin').value.trim().toUpperCase(),
    year:          g('wv-year').value,
    make:          g('wv-make').value.trim(),
    model:         g('wv-model').value.trim(),
    type:          g('wv-type').value,
    condition:     document.querySelector(`input[name="wv-cond-${i}"]:checked`)?.value || 'operable',
    runsAndDrives: g('wv-runs').value !== 'no',
    hasKeys:       g('wv-keys').value !== 'no',
    modified:      g('wv-modified').checked,
    modDescription: g('wv-modDesc').value.trim(),
    urgent:        g('wv-urgent').checked,
    damages:       g('wv-damages').value.trim()
  });
}

async function wizDecodeVin(i) {
  const input = document.getElementById('wv-vin-' + i);
  const vin = input.value.trim().toUpperCase();
  const ok  = document.getElementById('wv-vinResult-' + i);
  const err = document.getElementById('wv-vinError-' + i);
  ok.classList.add('hidden'); err.classList.add('hidden');
  if (vin.length < 11) {
    err.textContent = 'Enter the full 17-character VIN';
    err.classList.remove('hidden');
    return;
  }
  ok.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-1"></i>Decoding…';
  ok.classList.remove('hidden');
  try {
    const d = await (await fetch('/api/vin/' + encodeURIComponent(vin))).json();
    if (!d.success) throw new Error(d.message || 'VIN not found');
    if (d.year)  document.getElementById('wv-year-'  + i).value = d.year;
    if (d.make)  document.getElementById('wv-make-'  + i).value = d.make;
    if (d.model) document.getElementById('wv-model-' + i).value = d.model;
    ok.innerHTML = `<i class="fas fa-check mr-1"></i>${esc(d.label)}${d.trim ? ' · ' + esc(d.trim) : ''}${d.bodyClass ? ' · ' + esc(d.bodyClass) : ''}`;
    wizSaveVehicle(i);
  } catch (e) {
    ok.classList.add('hidden');
    err.textContent = e.message || 'Could not decode VIN';
    err.classList.remove('hidden');
  }
}

function wizRenderPhotos(i) {
  const p = document.getElementById('wv-photoPreview-' + i);
  if (!p) return;
  p.innerHTML = wiz.vehicles[i].photos.map((ph, k) => `
    <div class="relative">
      <img src="${ph.data}" class="rounded-lg border border-[var(--line)] object-cover h-24 w-full">
      <button type="button" onclick="wizRemovePhoto(${i}, ${k})"
              class="absolute -top-2 -right-2 bg-red-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">×</button>
    </div>`).join('');
}

function wizAddPhotos(i, input) {
  Array.from(input.files).forEach(file => {
    if (!file.type.startsWith('image/')) return;
    if (wiz.vehicles[i].photos.length >= 8) return alert('Maximum 8 photos per vehicle');
    const reader = new FileReader();
    reader.onload = (e) => {
      wiz.vehicles[i].photos.push({ name: file.name, data: e.target.result });
      wizRenderPhotos(i);
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}

function wizRemovePhoto(i, k) {
  wiz.vehicles[i].photos.splice(k, 1);
  wizRenderPhotos(i);
}

// ---- Step 2: Route ----
function wizRouteHTML() {
  return `
    <h4 class="text-lg font-semibold text-white mb-4">Route &amp; Dates</h4>
    <div class="space-y-4">
      <div>
        <label class="label-dark">Pickup Address <span class="text-red-400">*</span></label>
        <input id="wr-pickup" class="input-dark" value="${esc(wiz.location.pickup)}" autocomplete="off" placeholder="Street, City, State">
        <div id="wr-pickup-err" class="error-msg"></div>
      </div>
      <div>
        <label class="label-dark">Delivery Address <span class="text-red-400">*</span></label>
        <input id="wr-delivery" class="input-dark" value="${esc(wiz.location.delivery)}" autocomplete="off" placeholder="Street, City, State">
        <div id="wr-delivery-err" class="error-msg"></div>
      </div>
      <div>
        <label class="label-dark">Distance (miles) <span class="text-red-400">*</span></label>
        <input id="wr-distance" type="number" min="0" class="input-dark" value="${esc(wiz.distance)}"
               oninput="wiz.distance = this.value; wizUpdateRunningTotal()">
        <p class="text-xs text-muted mt-1">Auto-calculated when both addresses are picked from the suggestions. Editable.</p>
        <div id="wr-distance-err" class="error-msg"></div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label class="label-dark">First possible pickup <span class="text-red-400">*</span></label>
          <input id="wr-pickupDate" type="date" class="input-dark" value="${esc(wiz.pickupDate)}">
          <div id="wr-pickupDate-err" class="error-msg"></div>
        </div>
        <div>
          <label class="label-dark">Must deliver by <span class="text-red-400">*</span></label>
          <input id="wr-deliverBy" type="date" class="input-dark" value="${esc(wiz.mustDeliverBy)}">
          <div id="wr-deliverBy-err" class="error-msg"></div>
        </div>
      </div>
      <div>
        <label class="label-dark">Transport Type</label>
        <div class="flex gap-3">
          <button type="button" id="wr-tOpen" onclick="wizTransport('open')"
                  class="btn-transport flex-1 py-3 border-2 rounded-lg font-medium ${wiz.transportType === 'open' ? 'active' : ''}">Open</button>
          <button type="button" id="wr-tEnclosed" onclick="wizTransport('enclosed')"
                  class="btn-transport flex-1 py-3 border-2 rounded-lg font-medium ${wiz.transportType === 'enclosed' ? 'active' : ''}">Enclosed</button>
        </div>
      </div>
    </div>`;
}

function wizTransport(t) {
  wiz.transportType = t;
  document.getElementById('wr-tOpen').classList.toggle('active', t === 'open');
  document.getElementById('wr-tEnclosed').classList.toggle('active', t === 'enclosed');
}

// Google Maps is loaded lazily the first time the Route step opens.
// If it fails, the distance field still works manually.
function wizInitMaps() {
  const bind = () => {
    if (!window.google?.maps?.places) return;
    const p = document.getElementById('wr-pickup');
    const d = document.getElementById('wr-delivery');
    if (!p || !d) return;
    const opts = { types: ['address'], componentRestrictions: { country: 'us' } };
    const acP = new google.maps.places.Autocomplete(p, opts), acD = new google.maps.places.Autocomplete(d, opts);
    acP.addListener('place_changed', () => { const g = acP.getPlace()?.geometry?.location; wiz.location.pickupLat = g ? g.lat() : undefined; wiz.location.pickupLng = g ? g.lng() : undefined; wizCalcDistance(); });
    acD.addListener('place_changed', () => { const g = acD.getPlace()?.geometry?.location; wiz.location.deliveryLat = g ? g.lat() : undefined; wiz.location.deliveryLng = g ? g.lng() : undefined; wizCalcDistance(); });
    wizDistanceService = new google.maps.DistanceMatrixService();
  };
  if (window.google?.maps?.places) return bind();
  if (window._wizMapsLoading) { window._wizMapsCbs.push(bind); return; }
  window._wizMapsLoading = true;
  window._wizMapsCbs = [bind];
  window.wizMapsReady = () => { (window._wizMapsCbs || []).forEach(f => f()); window._wizMapsCbs = []; };
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&callback=wizMapsReady`;
  s.async = true; s.defer = true;
  s.onerror = () => console.warn('Google Maps failed to load — enter the distance manually');
  document.head.appendChild(s);
}

function wizCalcDistance() {
  const p = document.getElementById('wr-pickup')?.value.trim();
  const d = document.getElementById('wr-delivery')?.value.trim();
  if (!p || !d || !wizDistanceService) return;
  wizDistanceService.getDistanceMatrix(
    { origins: [p], destinations: [d],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.IMPERIAL },
    (resp, status) => {
      if (status === 'OK' && resp.rows[0].elements[0].status === 'OK') {
        const miles = Math.round(resp.rows[0].elements[0].distance.value * 0.000621371);
        const el = document.getElementById('wr-distance');
        if (el) el.value = miles;
        wiz.distance = miles;
        wizUpdateRunningTotal();
      }
    }
  );
}

// ---- Pricing (same formula as /payment, using the admin's saved calculator config) ----
function wizVehiclePrice(v) {
  const miles = Math.max(0, parseFloat(wiz.distance) || 0);
  let cpm = config.tiers[config.tiers.length - 1].rate;
  for (const t of config.tiers) { if (miles <= (t.max == null ? Infinity : t.max)) { cpm = t.rate; break; } }
  let s = config.baseFee + cpm * miles;
  if (config.multipliers[v.type]) s *= config.multipliers[v.type];
  if (v.condition === 'inoperable') s += config.addons.inoperable;
  if (v.modified) s += config.addons.modified;
  if (v.urgent)   s += config.addons.urgent;
  return Math.round(s);
}
function wizComputedTotal() { return wiz.serverPrice ? wiz.serverPrice.total : wiz.vehicles.reduce((sum, v) => sum + wizVehiclePrice(v), 0); }
// Ask the server engine (fuel/season/timing/market) for the real number + breakdown
async function wizFetchServerPrice() {
  try {
    const r = await fetch('/api/price', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      vehicles: wiz.vehicles.map(({ photos, ...v }) => v), distance: Number(wiz.distance) || 0,
      transportType: wiz.transportType, pickupDate: wiz.pickupDate, mustDeliverBy: wiz.mustDeliverBy,
      pickup: wiz.location.pickup, delivery: wiz.location.delivery,
      pickupLat: wiz.location.pickupLat, pickupLng: wiz.location.pickupLng, deliveryLat: wiz.location.deliveryLat, deliveryLng: wiz.location.deliveryLng }) });
    const d = await r.json();
    if (d.success) wiz.serverPrice = d;
  } catch (e) { console.warn('price:', e); }
}
// Footer total: the price the customer will be quoted (the admin override when set)
function wizFinalTotal() {
  const computed = wizComputedTotal();
  const f = wiz && wiz.finalPrice != null && wiz.finalPrice !== '' ? Math.round(Number(wiz.finalPrice)) : NaN;
  return f >= 0 ? f : computed;
}
function wizUpdateRunningTotal() {
  if (!wiz) return;
  const t = document.getElementById('wizRunningTotal');
  const label = t && t.previousElementSibling;
  const final = wizFinalTotal(), computed = wizComputedTotal();
  if (t) t.textContent = '$' + final.toLocaleString();
  if (label) label.textContent = final !== computed ? 'Quoted (adjusted)' : 'Estimated';
}

// ---- Step 3: Quote ----
function wizQuoteHTML() {
  const c = wiz.customer;
  const miles = Number(wiz.distance) || 0;
  const computed = wizComputedTotal();
  const final = (wiz.finalPrice != null && wiz.finalPrice !== '') ? wiz.finalPrice : computed;

  const rows = wiz.vehicles.map((v, i) => `
    <div class="flex justify-between items-start gap-4 py-3 border-b border-[var(--line)]">
      <div>
        <div class="font-semibold text-white">Vehicle ${i + 1}: ${esc([v.year, v.make, v.model].filter(Boolean).join(' '))}</div>
        <div class="text-xs text-muted mt-1">
          ${esc(VEHICLE_TYPE_LABELS[v.type] || v.type)} · ${v.condition === 'inoperable' ? 'Inoperable' : 'Operable'}
          ${v.runsAndDrives === false ? ' · Does not run' : ''}${v.hasKeys === false ? ' · No keys' : ''}
          ${v.modified ? ' · Modified' : ''}${v.urgent ? ' · Urgent' : ''}${v.vin ? ' · VIN ' + esc(v.vin) : ''}
          ${v.photos.length ? ` · ${v.photos.length} photo${v.photos.length > 1 ? 's' : ''}` : ''}
        </div>
        ${v.damages ? `<div class="text-xs text-amber-400 mt-1"><i class="fas fa-triangle-exclamation mr-1"></i>${esc(v.damages)}</div>` : ''}
      </div>
      <div class="text-right shrink-0"><div class="text-dim font-semibold">${wiz.serverPrice && wiz.serverPrice.lines[i] ? money(wiz.serverPrice.lines[i].amount) : '$' + wizVehiclePrice(v).toLocaleString()}</div><div class="text-[10px] text-muted uppercase tracking-wider">calculated</div></div>
    </div>`).join('');
  const engineLines = wiz.serverPrice ? wiz.serverPrice.lines.slice(wiz.vehicles.length) : [];
  const engineHTML = engineLines.length ? `
    <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-4 mb-6 text-xs text-dim space-y-1">
      <div class="text-muted uppercase tracking-wider mb-2">Market adjustments (admin only)</div>
      ${engineLines.map(l => `<div class="flex justify-between gap-4"><span>${esc(l.label)}</span><span class="${l.amount < 0 ? 'text-lime-300' : 'text-white'}">${l.amount < 0 ? '−' : '+'}${money(Math.abs(l.amount))}</span></div>`).join('')}
    </div>` : '';

  return `
    <h4 class="text-lg font-semibold text-white mb-4">Quote Summary</h4>
    <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-5 space-y-2 text-sm text-dim mb-5">
      <div><strong class="text-white">Customer:</strong> ${esc(c.name)}${c.company ? ' · ' + esc(c.company) : ''} · ${esc(c.phone)}${c.email ? ' · ' + esc(c.email) : ''} ${typeBadge(c.type)}</div>
      <div><strong class="text-white">From:</strong> ${esc(wiz.location.pickup)}</div>
      <div><strong class="text-white">To:</strong> ${esc(wiz.location.delivery)}</div>
      <div>
        <strong class="text-white">Distance:</strong> ${miles.toLocaleString()} mi ·
        <strong class="text-white">Transport:</strong> ${esc(wiz.transportType)} ·
        <strong class="text-white">Pickup:</strong> ${esc(wiz.pickupDate)} ·
        <strong class="text-white">Deliver by:</strong> ${esc(wiz.mustDeliverBy)}
      </div>
    </div>

    <div class="mb-4">${rows}</div>
    ${engineHTML}

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
      <div class="bg-[var(--bg-deep)] border rounded-xl p-5" style="border-color: rgba(255,106,61,0.4)">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div>
            <div class="text-xs text-muted uppercase tracking-wider">Calculated price</div>
            <div class="text-xl font-bold text-white">$${computed.toLocaleString()}</div>
          </div>
          <span class="pay-pill pay-phone" style="margin-left:0" title="Only you see this. The customer sees the final price only.">Admin only</span>
        </div>
        <label class="label-dark"><i class="fas fa-pen-to-square text-[var(--orange)] mr-1"></i> Adjust the price (what the customer pays)</label>
        <div class="flex items-center gap-2">
          <span class="text-2xl font-bold text-white">$</span>
          <input id="wizFinalPrice" type="number" min="0" step="1" class="input-dark text-2xl font-bold flex-1"
                 style="color: var(--orange);" value="${esc(final)}" oninput="wiz.finalPrice = this.value; wizPriceDiff()">
        </div>
        <div id="wizPriceDiff" class="text-xs mt-2 min-h-[18px]"></div>
        <div class="flex flex-wrap gap-1.5 mt-3">
          ${[['-$25', -25], ['-$50', -50], ['-$100', -100], ['-5%', -0.05], ['-10%', -0.10], ['+$50', 50]].map(([l, d]) =>
            `<button type="button" onclick="wizPriceQuick(${d})" class="pay-action" style="margin-left:0">${l}</button>`).join('')}
          <button type="button" onclick="wiz.finalPrice = null; document.getElementById('wizFinalPrice').value = ${computed}; wizPriceDiff()"
                  class="pay-action" style="margin-left:0"><i class="fas fa-rotate-left"></i> Calculated</button>
        </div>
        <label class="label-dark mt-4">Reason for the adjustment <span class="text-muted font-normal">(saved on the order)</span></label>
        <input id="wizPriceReason" class="input-dark" placeholder="e.g. repeat dealer, matched competitor, flexible dates…" value="${esc(wiz.priceReason || '')}" oninput="wiz.priceReason = this.value">

        <div class="mt-5 pt-4 border-t border-[var(--line)]">
          <label class="label-dark"><i class="fas fa-ban text-amber-400 mr-1"></i> No-show / dry-run fee <span class="text-muted font-normal">(what the customer agrees to if the vehicle is gone)</span></label>
          <div class="flex items-center gap-2">
            <span class="text-xl font-bold text-white">$</span>
            <input id="wizNoShowFee" type="number" min="0" step="1" class="input-dark text-xl font-bold w-40" value="${esc(wiz.noShowFee != null && wiz.noShowFee !== '' ? wiz.noShowFee : DEFAULT_NO_SHOW_FEE)}" oninput="wiz.noShowFee = this.value">
            <span class="text-xs text-muted">default $${DEFAULT_NO_SHOW_FEE}</span>
          </div>
        </div>
      </div>
      <div>
        <label class="label-dark">Internal order notes</label>
        <textarea id="wizNotes" class="input-dark" style="min-height:140px" placeholder="Call notes, special instructions, gate codes…">${esc(wiz.notes)}</textarea>
        <p class="text-xs text-muted mt-2">
          Saved as a phone-in order with <span class="text-red-400 font-semibold">no card yet</span>.
          Next step is sending the customer the pickup confirmation from the order.
        </p>
      </div>
    </div>`;
}
// Shows "-$50 (7.7% off)" under the price box, and applies the quick buttons
function wizPriceDiff() {
  wizUpdateRunningTotal();
  const el = document.getElementById('wizPriceDiff'); if (!el || !wiz) return;
  const computed = wizComputedTotal(), final = Number(document.getElementById('wizFinalPrice')?.value);
  if (!(final >= 0) || final === computed) { el.textContent = 'Same as the calculated price.'; el.className = 'text-xs mt-2 min-h-[18px] text-muted'; return; }
  const diff = final - computed, pct = computed ? Math.abs(diff) / computed * 100 : 0;
  el.textContent = `${diff < 0 ? '−' : '+'}$${Math.abs(diff).toLocaleString()} (${pct.toFixed(1)}% ${diff < 0 ? 'off' : 'more'}) vs calculated`;
  el.className = 'text-xs mt-2 min-h-[18px] ' + (diff < 0 ? 'text-amber-300' : 'text-lime-300');
}
function wizPriceQuick(d) {
  const input = document.getElementById('wizFinalPrice'); if (!input) return;
  const base = Number(input.value) || wizComputedTotal();
  const next = Math.max(0, Math.round(Math.abs(d) < 1 ? base * (1 + d) : base + d));
  input.value = next; wiz.finalPrice = next; wizPriceDiff();
}

async function wizSave() {
  wizCollect();
  const computed = wizComputedTotal();
  const total = Math.max(0, Math.round(Number(wiz.finalPrice)) || computed);
  if (total !== computed) {
    const line = `Price adjusted: calculated $${computed.toLocaleString()} → quoted $${total.toLocaleString()}${wiz.priceReason ? ' — ' + wiz.priceReason : ''}`;
    wiz.notes = (wiz.notes ? wiz.notes + '\n' : '') + line;
  }
  const c = wiz.customer;
  const btn = document.getElementById('wizSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Saving…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'MC-' + Date.now().toString().slice(-6),
        status: 'New',
        source: 'admin',
        paymentStatus: 'unpaid',
        customerId: wiz.customerId,
        contact: { fullName: c.name, email: c.email, phone: c.phone, company: c.company, type: c.type },
        customerNotes: c.notes,
        vehicles: wiz.vehicles,
        vehicle: wiz.vehicles[0],
        location: wiz.location,
        distance: Number(wiz.distance) || null,
        pickupDate: wiz.pickupDate,
        mustDeliverBy: wiz.mustDeliverBy,
        transportType: wiz.transportType,
        total,
        noShowFee: wiz.noShowFee != null && wiz.noShowFee !== '' ? Number(wiz.noShowFee) : undefined,
        pricing: wiz.serverPrice ? { lines: wiz.serverPrice.lines, factors: wiz.serverPrice.factors, cpm: wiz.serverPrice.cpm } : undefined,
        notes: wiz.notes
      })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.message || 'Save failed');
    wiz = null;
    document.getElementById('customerWizardModal').classList.add('hidden');
    loadOrders();
    loadCustomers();
    alert(`✅ Quote saved as order ${data.orderId} — $${total.toLocaleString()}\n\nNext: send the customer the pickup confirmation from the order details.`);
    showOrderDetail(data.orderId);
  } catch (e) {
    alert('Error saving: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-save"></i> Save Customer & Quote';
  }
}

// ==================== PICKUP CONFIRMATION + CARD HOLD (order modal) ====================
const DEFAULT_NO_SHOW_FEE = 150;
const PAY_LABELS = {
  unpaid:            ['Unpaid',                'pay-unpaid'],
  confirmation_sent: ['Awaiting confirmation', 'pay-wait'],
  authorized:        ['Hold placed',           'pay-hold'],
  paid:              ['Paid',                  'pay-paid'],
  fee_charged:       ['No-show fee charged',   'pay-fee'],
  released:          ['Hold released',         'pay-released'],
  expired:           ['Hold expired',          'pay-unpaid']
};
function payLabel(s) { return PAY_LABELS[s] || [s || 'unknown', 'pay-released']; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
function money(n) { return '$' + Number(n || 0).toLocaleString(); }

// Source + payment line under the total. Web orders keep the manual paid/unpaid toggle;
// phone-in orders are driven by the confirmation panel above.
function paymentSummaryLine(o) {
  const src = o.source === 'admin'
    ? '<i class="fas fa-phone mr-1"></i>Phone-in order'
    : '<i class="fas fa-globe mr-1"></i>Website order';
  const toggle = o.source !== 'admin' && ['paid', 'unpaid'].includes(o.paymentStatus) && !o.stripePaymentIntentId
    ? `<button onclick="toggleOrderPayment('${o.id}', '${o.paymentStatus === 'unpaid' ? 'paid' : 'unpaid'}')"
               class="ml-2 text-cyan-400 hover:text-white underline">${o.paymentStatus === 'unpaid' ? 'Mark paid' : 'Mark unpaid'}</button>`
    : '';
  const charged = o.chargedAmount != null ? o.chargedAmount : (o.paymentStatus === 'paid' ? o.total : 0);
  const remaining = Math.max(0, Math.round((charged - (o.refundedAmount || 0)) * 100) / 100);
  const refund = ''; // the Refund button lives in the Payment panel below
  const refunded = o.refundedAmount ? ` · <span class="text-amber-300">${money(o.refundedAmount)} refunded</span>` : '';
  return `<p class="text-xs text-muted mt-2">${src} · ${payStatePill(o.paymentState)}${refunded}${toggle}${refund}</p>`;
}

function confirmationPanelHTML(o) {
  // Shown for every order: phone-in orders get the confirmation/hold controls,
  // website orders get their charge + refund controls. Same actions as the Payments page.

  const email = (o.contact || {}).email;
  const fee   = o.noShowFee != null ? o.noShowFee : DEFAULT_NO_SHOW_FEE;
  const link  = o.confirmToken ? `${location.origin}/confirm/${o.confirmToken}` : '';
  const linkRow = link ? `
    <div class="flex items-center gap-2 mt-3">
      <input readonly value="${esc(link)}" class="input-admin text-xs font-mono flex-1" onclick="this.select()">
      <button onclick="copyText('${esc(link)}', this)" class="btn btn-ghost px-3 py-2 text-xs shrink-0"><i class="fas fa-copy"></i> Copy</button>
      <a href="${esc(link)}" target="_blank" class="btn btn-ghost px-3 py-2 text-xs shrink-0" title="Preview the customer page"><i class="fas fa-arrow-up-right-from-square"></i></a>
    </div>` : '';
  const card = o.agreement && o.agreement.authorization && o.agreement.authorization.card;
  const agreedRow = o.agreedAt ? `
    <div class="mt-3 p-3 rounded-lg text-sm" style="background:rgba(190,242,100,0.06);border:1px solid rgba(190,242,100,0.25)">
      <div><i class="fas fa-file-signature text-lime-400 mr-1"></i>
        Signed by <strong class="text-white">${esc(o.agreedName || '—')}</strong> on ${fmtDateTime(o.agreedAt)}${o.agreedIp ? ` <span class="text-muted">· IP ${esc(o.agreedIp)}</span>` : ''}${card ? ` · <span class="text-white">${esc((card.brand || '').toUpperCase())} •••• ${esc(card.last4)}</span>` : ''}
      </div>
      <a href="/admin/orders/${encodeURIComponent(o.id)}/agreement" target="_blank" rel="noopener" class="inline-flex items-center gap-1 mt-2 text-cyan-400 hover:text-white text-xs font-semibold">
        <i class="fas fa-file-contract"></i> View signed agreement &amp; receipt (printable)
      </a>
    </div>` : '';
  const feeInput = `
    <div>
      <label class="label-dark">No-show / dry-run fee ($)</label>
      <input id="noShowFeeInput" type="number" min="0" step="1" value="${fee}" class="input-admin w-32">
    </div>`;

  let body = '';
  switch (o.paymentStatus) {
    case 'unpaid':
    case 'released':
    case 'expired':
      body = `
        ${o.paymentStatus === 'released' ? '<p class="text-sm text-muted mb-3"><i class="fas fa-rotate-left mr-1"></i> The card hold was released and the card removed. You can send a new confirmation.</p>' : ''}
        ${o.paymentStatus === 'expired' ? '<p class="text-sm text-amber-400 mb-3"><i class="fas fa-clock mr-1"></i> The 7-day card hold expired before pickup and the card was removed automatically. Send a new confirmation if the pickup is still on.</p>' : ''}
        <p class="text-sm text-dim mb-4">Email the customer a link to accept the pickup terms and authorize a card hold for <strong class="text-white">${money(o.total)}</strong>. They are only charged once you mark the vehicle picked up.</p>
        ${!email ? '<p class="text-sm text-amber-400 mb-4"><i class="fas fa-triangle-exclamation mr-1"></i> No email on this order — you can still generate the link and text it to the customer.</p>' : ''}
        <div class="flex flex-wrap items-end gap-3">
          ${feeInput}
          <button onclick="sendConfirmation('${o.id}')" class="btn btn-primary py-3">
            <i class="fas fa-paper-plane"></i> ${email ? 'Send confirmation email' : 'Generate confirmation link'}
          </button>
        </div>
        ${linkRow}`;
      break;

    case 'confirmation_sent':
      body = `
        <p class="text-sm"><i class="fas fa-paper-plane text-amber-400 mr-1"></i> Sent ${fmtDateTime(o.confirmSentAt)}${email ? ` to <strong class="text-white">${esc(email)}</strong>` : ''}. Waiting for the customer to agree and enter a card.</p>
        ${agreedRow}
        ${linkRow}
        <div class="flex flex-wrap items-end gap-3 mt-4">
          ${feeInput}
          <button onclick="sendConfirmation('${o.id}')" class="btn btn-ghost py-3"><i class="fas fa-rotate-right"></i> Resend</button>
        </div>`;
      break;

    case 'authorized':
      body = `
        <p class="text-sm"><i class="fas fa-credit-card text-cyan-400 mr-1"></i>
          <strong class="text-white">${money(o.holdAmount || o.total)} is on hold — nothing has been charged.</strong> The hold and the saved card are kept until <strong class="text-white">${fmtDateTime(o.holdExpiresAt)}</strong> (7 days), then released automatically.
        </p>
        <div class="mt-3 p-3 rounded-lg text-xs leading-relaxed" style="background:rgba(255,255,255,0.03);border:1px solid var(--line)">
          <div><span class="text-lime-300 font-semibold">Charge</span> = money is collected. Stripe keeps its ~3% fee, even if you refund later.</div>
          <div class="mt-1"><span class="text-white font-semibold">Release</span> = pickup not happening. Customer pays nothing, the pending line drops off their card, <span class="text-white">no Stripe fee</span>.</div>
        </div>
        ${agreedRow}
        <div class="flex flex-wrap gap-3 mt-4">
          <button onclick="markPickedUp('${o.id}', ${Number(o.holdAmount || o.total) || 0})" class="btn btn-primary py-3">
            <i class="fas fa-truck-pickup"></i> Vehicle picked up — charge ${money(o.total)}
          </button>
          <button onclick="chargeNoShowFee('${o.id}', ${Number(fee) || 0})" class="btn btn-ghost py-3" style="color:#FBBF24;border-color:rgba(251,191,36,0.4)">
            <i class="fas fa-ban"></i> Vehicle gone — charge ${money(fee)} fee
          </button>
          <button onclick="releaseHold('${o.id}')" class="btn btn-ghost py-3"><i class="fas fa-unlock"></i> Release hold</button>
        </div>`;
      break;

    case 'paid':
    case 'fee_charged': {
      const charged   = o.chargedAmount != null ? o.chargedAmount : o.total;
      const refunded  = o.refundedAmount || 0;
      const remaining = Math.max(0, Math.round((charged - refunded) * 100) / 100);
      const canRefund = remaining > 0 && (o.stripePaymentIntentId || o.feePaymentIntentId);
      const isFee = o.paymentStatus === 'fee_charged';
      const what = isFee
        ? `Vehicle was not available. No-show fee of <strong class="text-white">${money(charged)}</strong> charged on ${fmtDateTime(o.chargedAt)}. The transport hold was released.`
        : `Charged <strong class="text-white">${money(charged)}</strong>${o.chargedAt ? ' on ' + fmtDateTime(o.chargedAt) : ''}${o.pickedUpAt ? ` · picked up ${fmtDateTime(o.pickedUpAt)}` : ''}.`;
      const refundRow = refunded
        ? `<p class="text-sm mt-1"><i class="fas fa-rotate-left text-amber-300 mr-1"></i> Refunded <strong class="text-white">${money(refunded)}</strong>${o.refundedAt ? ' on ' + fmtDateTime(o.refundedAt) : ''}${remaining > 0 ? ` · <span class="text-white">${money(remaining)}</span> still charged` : ' · fully refunded'}.</p>`
        : '';
      const refundBtn = canRefund
        ? `<div class="flex flex-wrap gap-3 mt-4">
             <button onclick="refundOrder('${o.id}', ${remaining})" class="btn btn-ghost py-3" style="color:#FBBF24;border-color:rgba(251,191,36,0.4)"><i class="fas fa-rotate-left"></i> Refund up to ${money(remaining)}</button>
           </div>
           <p class="text-xs text-muted mt-2">Refunds go back to the same card. Stripe keeps its processing fee on refunded money.</p>`
        : (!o.stripePaymentIntentId && !isFee ? '<p class="text-xs text-muted mt-2">No Stripe payment is linked to this order, so refunds are handled outside the site.</p>' : '');
      body = `
        <p class="text-sm"><i class="fas ${isFee ? 'fa-ban text-purple-400' : 'fa-circle-check text-lime-400'} mr-1"></i> ${what}</p>
        ${refundRow}${agreedRow}${refundBtn}`;
      break;
    }

    default:
      body = `<p class="text-sm text-muted">Payment status: ${esc(o.paymentStatus)}</p>`;
  }

  return `
    <div class="mt-8 bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h4 class="font-semibold text-white"><i class="fas fa-credit-card text-[var(--orange)] mr-2"></i>Payment</h4>
        ${payStatePill(o.paymentState)}
      </div>
      <div id="confirmPanelMsg" class="hidden"></div>
      ${body}
    </div>`;
}

function copyText(text, btn) {
  const done = () => { const h = btn.innerHTML; btn.innerHTML = '<i class="fas fa-check"></i> Copied'; setTimeout(() => btn.innerHTML = h, 1500); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(() => prompt('Copy this link:', text));
  else prompt('Copy this link:', text);
}

function panelMsg(msg, ok) {
  const el = document.getElementById('confirmPanelMsg');
  if (el) {
    el.textContent = msg;
    el.className = 'text-sm mb-3 ' + (ok ? 'text-lime-400' : 'text-red-400');
    return;
  }
  // No open order panel (e.g. Payments page) → small toast in the corner
  let t = document.getElementById('adminToast');
  if (!t) { t = document.createElement('div'); t.id = 'adminToast'; t.className = 'admin-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('admin-toast-ok', !!ok);
  t.classList.toggle('admin-toast-err', !ok);
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 5000);
}

async function postOrderAction(orderId, action, body) {
  const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.message || 'Request failed');
  return data;
}

async function sendConfirmation(orderId) {
  const fee = document.getElementById('noShowFeeInput')?.value;
  try {
    const d = await postOrderAction(orderId, 'send-confirmation', { noShowFee: fee });
    loadOrders();
    await showOrderDetail(orderId);
    panelMsg(d.emailSent ? `Confirmation email sent to ${d.sentTo}.` : `Link generated, but no email was sent: ${d.emailError}`, d.emailSent);
  } catch (e) { panelMsg(e.message, false); }
}

// Ask for an amount with a default; returns a number or null when cancelled/invalid
function askAmount(message, defaultValue, max) {
  const raw = prompt(message, Number(defaultValue || 0).toFixed(2));
  if (raw === null) return null;
  const n = Number(String(raw).replace(/[$,\s]/g, ''));
  if (!(n > 0)) { alert('Enter an amount greater than 0.'); return null; }
  if (max != null && n > max + 0.005) { alert(`The most you can enter is ${money(max)}.`); return null; }
  return Math.round(n * 100) / 100;
}

async function markPickedUp(orderId, amount, afterwards) {
  const amt = askAmount(`Mark the vehicle as picked up and charge the customer now.\n\nAmount to charge (up to ${money(amount)} on hold):`, amount, amount);
  if (amt === null) return;
  try {
    const d = await postOrderAction(orderId, 'pickup', { amount: amt });
    await (afterwards ? afterwards() : refreshAfterPayment(orderId));
    panelMsg(`Charged ${money(d.amount)}.`, true);
  } catch (e) { panelMsg(e.message, false); }
}

async function refundOrder(orderId, remaining, afterwards) {
  const amt = askAmount(`Refund to the customer's card.\n\nAmount to refund (up to ${money(remaining)}):`, remaining, remaining);
  if (amt === null) return;
  const reason = prompt('Reason (optional, saved in the order notes):', '') || '';
  try {
    const d = await postOrderAction(orderId, 'refund', { amount: amt, reason });
    await (afterwards ? afterwards() : refreshAfterPayment(orderId));
    panelMsg(`Refunded ${money(d.amount)}. ${d.remaining > 0 ? money(d.remaining) + ' still charged.' : 'Fully refunded.'}`, true);
  } catch (e) { panelMsg(e.message, false); }
}

async function refreshAfterPayment(orderId) {
  if (document.getElementById('ordersBody')) { loadOrders(); await showOrderDetail(orderId); }
  if (document.getElementById('paymentsBody')) await loadPayments();
}

async function chargeNoShowFee(orderId, fee) {
  const amt = askAmount('The vehicle was not available.\n\nNo-show / dry-run fee to charge:', fee);
  if (amt === null) return;
  try {
    const d = await postOrderAction(orderId, 'charge-fee', { amount: amt });
    await refreshAfterPayment(orderId);
    panelMsg(`No-show fee ${money(d.amount)} charged and the transport hold released.`, true);
  } catch (e) { panelMsg(e.message, false); }
}

async function releaseHold(orderId) {
  if (!confirm('Release the card hold without charging the customer? The saved card is removed too.')) return;
  try {
    await postOrderAction(orderId, 'release-hold');
    await refreshAfterPayment(orderId);
    panelMsg('Hold released and the card removed.', true);
  } catch (e) { panelMsg(e.message, false); }
}

// ==================== PAYMENTS PAGE ====================
let paymentsCache = [];
let paymentsFilter = 'all';
const PAYMENT_FILTERS = {
  all:      () => true,
  pending:  p => p.paymentState === 'pending' || p.paymentState === 'unpaid',
  holding:  p => p.paymentState === 'holding',
  charged:  p => ['charged', 'partially_refunded', 'fee_charged'].includes(p.paymentState),
  refunded: p => ['refunded', 'partially_refunded'].includes(p.paymentState),
  other:    p => ['released', 'expired'].includes(p.paymentState)
};

const paymentsView = { page: 1, limit: 50 };
async function loadPayments() {
  const tbody = document.getElementById('paymentsBody');
  if (!tbody) return;
  try {
    const q = (document.getElementById('paymentsSearch')?.value || '').trim();
    const params = new URLSearchParams({ page: paymentsView.page, limit: paymentsView.limit });
    if (q) params.set('q', q); if (paymentsFilter && paymentsFilter !== 'all') params.set('state', paymentsFilter);
    const data = await (await fetch('/api/payments?' + params)).json();
    paymentsCache = data.payments || [];
    const t = data.totals || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = money(v); };
    set('payTotalHolding', t.holding); set('payTotalCharged', t.charged); set('payTotalRefunded', t.refunded); set('payTotalPending', t.pending);
    renderPager(document.getElementById('paymentsPager'), { page: data.page, pages: data.pages, total: data.total, limit: paymentsView.limit },
      p => { paymentsView.page = p; loadPayments(); }, n => { paymentsView.limit = n; paymentsView.page = 1; loadPayments(); });
    renderPayments();
  } catch (e) { console.error('loadPayments:', e); }
}

function setPaymentsFilter(f) {
  paymentsFilter = f;
  document.querySelectorAll('[data-pay-filter]').forEach(b => b.classList.toggle('active', b.dataset.payFilter === f));
  paymentsView.page = 1;
  loadPayments();
}
const paymentsSearchChanged = debounce(() => { paymentsView.page = 1; loadPayments(); }, 250);

function renderPayments() {
  const tbody = document.getElementById('paymentsBody');
  if (!tbody) return;
  const rows = paymentsCache; // already searched, filtered and paged by the server
  const empty = document.getElementById('noPaymentsMessage');
  if (empty) empty.classList.toggle('hidden', rows.length > 0);
  tbody.innerHTML = rows.map(p => {
    const charged = p.chargedAmount || 0, refunded = p.refundedAmount || 0, remaining = Math.max(0, Math.round((charged - refunded) * 100) / 100);
    let amountCell = '';
    if (p.paymentState === 'holding') amountCell = `<div class="text-cyan-300 font-semibold">${money(p.holdAmount || p.total)} on hold</div><div class="text-[11px] text-muted">until ${p.holdExpiresAt ? new Date(p.holdExpiresAt).toLocaleDateString() : '—'}</div>`;
    else if (['charged', 'partially_refunded', 'refunded', 'fee_charged'].includes(p.paymentState)) amountCell = `<div class="text-white font-semibold">${money(charged)} charged</div>${refunded ? `<div class="text-[11px] text-amber-300">${money(refunded)} refunded</div>` : `<div class="text-[11px] text-muted">${p.chargedAt ? new Date(p.chargedAt).toLocaleDateString() : ''}</div>`}`;
    else amountCell = `<div class="text-muted">${money(p.total)} quoted</div><div class="text-[11px] text-muted">${p.paymentState === 'pending' ? 'waiting for customer' : p.paymentState === 'expired' ? 'hold expired' : p.paymentState === 'released' ? 'released' : 'not charged'}</div>`;

    const btn = (label, cls, fn, title) => `<button onclick="event.stopImmediatePropagation(); ${fn}" class="pay-action ${cls}" title="${esc(title || '')}">${label}</button>`;
    const id = esc(p.id);
    // One main button per row; everything else lives in the "⋯" menu
    let primary = '';
    const menu = [];
    if (p.paymentState === 'holding') {
      primary = btn('<i class="fas fa-truck-pickup"></i> Charge', 'pay-action-primary', `markPickedUp('${id}', ${Number(p.holdAmount || p.total)}, loadPayments)`, 'Vehicle picked up — charge the full amount or a custom amount');
      menu.push(['fa-ban', 'Charge no-show fee instead', `chargeNoShowFee('${id}', ${Number(p.noShowFee || 150)})`]);
      menu.push(['fa-unlock', 'Release hold (no charge, no fee)', `releaseHold('${id}')`]);
    }
    if (['charged', 'partially_refunded', 'fee_charged'].includes(p.paymentState) && remaining > 0 && (p.stripePaymentIntentId || p.feePaymentIntentId))
      primary = btn('<i class="fas fa-rotate-left"></i> Refund', '', `refundOrder('${id}', ${remaining}, loadPayments)`, `Refund up to ${money(remaining)}`);
    if (['unpaid', 'released', 'expired', 'pending'].includes(p.paymentState) && p.source === 'admin')
      primary = btn(p.paymentState === 'pending' ? '<i class="fas fa-paper-plane"></i> Resend link' : '<i class="fas fa-paper-plane"></i> Send confirmation', 'pay-action-primary', `sendConfirmationFromPayments('${id}')`, 'Email the customer the pickup confirmation + card link');
    menu.push(['fa-eye', 'Open order', `showOrderDetail('${id}')`]);
    menu.push(['fa-trash', 'Delete order', `deleteOrder('${id}', '${esc(p.paymentState)}')`, 'danger']);
    const menuHtml = `
      <span class="row-menu">
        <button class="pay-action" onclick="event.stopImmediatePropagation(); toggleRowMenu(this)" title="More"><i class="fas fa-ellipsis"></i></button>
        <div class="row-menu-list hidden">
          ${menu.map(([icon, label, fn, kind]) => `<button onclick="event.stopImmediatePropagation(); closeRowMenus(); ${fn}" class="${kind === 'danger' ? 'danger' : ''}"><i class="fas ${icon}"></i> ${label}</button>`).join('')}
        </div>
      </span>`;

    return `<tr class="cursor-pointer" onclick="showOrderDetail('${id}')">
      <td><div class="font-mono text-orange-400 font-semibold">${id}</div><div class="text-[11px] text-muted mt-1">${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ''} · ${p.source === 'admin' ? 'Phone' : 'Website'}</div></td>
      <td><div class="font-medium text-white">${esc(p.customer || '—')}</div><div class="text-[11px] text-muted mt-1 truncate max-w-[260px]">${esc(p.email || p.phone || '')}</div></td>
      <td class="col-hide-mobile text-sm">${esc(p.vehicle || '—')}</td>
      <td>${payStatePill(p.paymentState, p)}</td>
      <td class="text-sm">${amountCell}</td>
      <td class="text-right whitespace-nowrap">${primary}${menuHtml}</td>
    </tr>`;
  }).join('');
}

async function sendConfirmationFromPayments(orderId) {
  const p = paymentsCache.find(x => x.id === orderId);
  const fee = askAmount('No-show fee the customer agrees to if the vehicle is gone at pickup:', p?.noShowFee || 150);
  if (fee === null) return;
  try {
    const d = await postOrderAction(orderId, 'send-confirmation', { noShowFee: fee });
    await loadPayments();
    panelMsg(d.emailSent ? `Confirmation email sent to ${d.sentTo}.` : `Link generated, but no email was sent: ${d.emailError}`, d.emailSent);
  } catch (e) { panelMsg(e.message, false); }
}

// ==================== INIT ====================
initAdminPage();

// ==================== CHANGE PASSWORD (top bar → Account) ====================
function openPasswordModal() {
  const m = document.getElementById('passwordModal'); if (!m) return;
  document.getElementById('pwModalEmail').textContent = sessionStorage.getItem('mcAdminEmail') || '';
  ['pwCurrent', 'pwNew', 'pwNew2'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('pwMsg').classList.add('hidden');
  m.classList.remove('hidden');
  document.getElementById('pwCurrent').focus();
}
function closePasswordModal() { document.getElementById('passwordModal')?.classList.add('hidden'); }
async function submitPasswordChange() {
  const cur = document.getElementById('pwCurrent').value, a = document.getElementById('pwNew').value, b = document.getElementById('pwNew2').value;
  const msg = document.getElementById('pwMsg');
  const say = (t, ok) => { msg.textContent = t; msg.className = 'text-sm ' + (ok ? 'text-lime-400' : 'text-red-400'); };
  if (a.length < 8) return say('Use at least 8 characters.', false);
  if (a !== b) return say('The two new passwords do not match.', false);
  try {
    const res = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: cur, newPassword: a }) });
    const d = await res.json();
    if (d.success) { say('Password updated.', true); setTimeout(closePasswordModal, 1200); }
    else say(d.message || 'Could not change the password.', false);
  } catch (e) { say('Connection error. Try again.', false); }
}

// ==================== ROW "⋯" MENUS ====================
function closeRowMenus() { document.querySelectorAll('.row-menu-list').forEach(m => m.classList.add('hidden')); }
function toggleRowMenu(btn) {
  const list = btn.nextElementSibling; const open = !list.classList.contains('hidden');
  closeRowMenus();
  if (!open) list.classList.remove('hidden');
}
document.addEventListener('click', (e) => { if (!e.target.closest('.row-menu')) closeRowMenus(); });

// ==================== EDIT PRICE ON AN EXISTING ORDER (admin only) ====================
async function editOrderPrice(orderId, current) {
  const amt = askAmount(`New quoted price for order ${orderId} (currently ${money(current)}):`, current);
  if (amt === null) return;
  const reason = prompt('Reason (optional, saved on the order):', '') || '';
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}/price`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ total: amt, reason }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.success) throw new Error(d.message || 'Could not change the price');
    if (document.getElementById('ordersBody')) loadOrders();
    if (document.getElementById('paymentsBody')) loadPayments();
    await showOrderDetail(orderId, { fromHistory: true });
    panelMsg(`Price changed to ${money(d.total)}.`, true);
  } catch (e) { panelMsg(e.message, false); }
}

// ==================== LEADS ====================
const leadsView = { page: 1, limit: 50 };
const leadsSearchChanged = debounce(() => { leadsView.page = 1; loadLeads(); }, 250);
async function loadLeads() {
  const tbody = document.getElementById('leadsBody'); if (!tbody) return;
  const q = document.getElementById('leadsSearch')?.value.trim() || '';
  const params = new URLSearchParams({ page: leadsView.page, limit: leadsView.limit }); if (q) params.set('q', q);
  try {
    const data = await (await fetch('/api/leads?' + params)).json();
    const rows = data.leads || [];
    renderPager(document.getElementById('leadsPager'), { page: data.page, pages: data.pages, total: data.total, limit: leadsView.limit },
      p => { leadsView.page = p; loadLeads(); }, n => { leadsView.limit = n; leadsView.page = 1; loadLeads(); });
    document.getElementById('noLeadsMessage').classList.toggle('hidden', rows.length > 0);
    tbody.innerHTML = rows.map(l => `<tr>
      <td><a href="mailto:${esc(l.email)}" class="text-white hover:text-cyan-400 font-medium">${esc(l.email)}</a></td>
      <td class="text-sm">${esc(l.source || 'website')}</td>
      <td class="text-xs">${l.createdAt ? new Date(l.createdAt).toLocaleString() : ''}</td>
      <td>${l.isCustomer ? '<span class="pay-pill pay-paid" style="margin-left:0">Became a customer</span>' : '<span class="pay-pill pay-wait" style="margin-left:0">New lead</span>'}</td>
      <td class="text-right whitespace-nowrap">
        <a href="mailto:${esc(l.email)}?subject=${encodeURIComponent('Your vehicle shipping quote from Mcships')}" class="pay-action" title="Email them"><i class="fas fa-reply"></i> Reply</a>
        <button onclick="deleteLead(${l.id})" class="pay-action pay-action-danger" title="Delete"><i class="fas fa-trash"></i></button>
      </td></tr>`).join('');
  } catch (e) { console.error('loadLeads:', e); }
}
async function deleteLead(id) {
  if (!confirm('Delete this lead?')) return;
  const r = await fetch('/api/leads/' + id, { method: 'DELETE' });
  if (r.ok) loadLeads(); else panelMsg('Could not delete the lead', false);
}


// ==================== EMAIL SENDING PAGE ====================
async function loadEmailStatus() {
  const box = document.getElementById('emailStatus'); if (!box) return;
  try {
    const st = await (await fetch('/api/email/status')).json();
    const justConnected = new URLSearchParams(location.search).get('connected') === '1';
    let gmailCard;
    if (st.gmailConnected) {
      gmailCard = `
      <div class="p-5 rounded-xl" style="background: rgba(190,242,100,0.06); border: 1px solid rgba(190,242,100,0.35);">
        <div class="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div class="font-semibold text-white"><i class="fas fa-circle-check text-lime-400 mr-1"></i> Gmail connected</div>
            <div class="text-sm text-dim mt-1">Customer emails are sent through <strong class="text-white">${esc(st.gmailEmail || 'Gmail')}</strong> and show up in that account's Sent folder. Sender shown to customers: <strong class="text-white">${esc(st.from)}</strong>.</div>
            <div class="text-xs text-muted mt-2">Connected ${st.gmailConnectedAt ? new Date(st.gmailConnectedAt).toLocaleString() : ''} · Google allows about 500 emails a day from a Gmail account.</div>
          </div>
          <button onclick="disconnectGmail()" class="pay-action pay-action-danger" style="margin-left:0"><i class="fas fa-link-slash"></i> Disconnect</button>
        </div>
      </div>`;
    } else if (st.gmailConfigured) {
      gmailCard = `
      <div class="p-5 rounded-xl" style="background: rgba(255,106,61,0.06); border: 1px solid rgba(255,106,61,0.35);">
        <div class="font-semibold text-white"><i class="fas fa-envelope text-[var(--orange)] mr-1"></i> Gmail not connected yet</div>
        <div class="text-sm text-dim mt-1 mb-4">Connect the mcships1988@gmail.com account once. Google asks you to sign in and allow "Send email on your behalf". On the "Google hasn't verified this app" screen click <em>Advanced</em>, then <em>Go to mcships</em>.</div>
        <a href="/admin/gmail/connect" class="btn btn-primary px-5 py-3"><i class="fab fa-google"></i> Connect Gmail</a>
      </div>`;
    } else {
      gmailCard = `
      <div class="p-5 rounded-xl" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <div class="font-semibold text-white"><i class="fas fa-triangle-exclamation text-amber-400 mr-1"></i> Gmail sending is not set up</div>
        <div class="text-sm text-dim mt-1">Add <code class="text-white">GMAIL_CLIENT_ID</code> and <code class="text-white">GMAIL_CLIENT_SECRET</code> in Railway (from a Google Cloud OAuth client, redirect URI <code class="text-white">${esc(st.redirectUri)}</code>), then reload this page.</div>
      </div>`;
    }
    box.innerHTML = `
      ${justConnected ? '<p class="text-lime-400 text-sm"><i class="fas fa-check mr-1"></i> Gmail connected. Send a test below.</p>' : ''}
      ${gmailCard}
      <div class="p-5 rounded-xl" style="background: rgba(255,255,255,0.03); border: 1px solid var(--line);">
        <div class="font-semibold text-white"><i class="fas fa-shield-halved text-cyan-400 mr-1"></i> Fallback: ${esc(st.fallback)}</div>
        <div class="text-sm text-dim mt-1">Used for internal alerts to you, and for customer emails if Gmail is not connected or fails.</div>
      </div>`;
  } catch (e) { box.innerHTML = '<p class="text-red-400 text-sm">Could not load email status.</p>'; }
}
async function disconnectGmail() {
  if (!confirm('Disconnect Gmail? Customer emails will go through the fallback until you connect again.')) return;
  await fetch('/api/email/disconnect', { method: 'POST' });
  history.replaceState(null, '', '/admin/email');
  loadEmailStatus();
}
async function sendTestEmail() {
  const to = document.getElementById('testEmailTo').value.trim();
  const msg = document.getElementById('testEmailMsg');
  msg.className = 'text-sm mt-3 text-muted'; msg.textContent = 'Sending…';
  try {
    const r = await fetch('/api/email/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to }) });
    const d = await r.json();
    msg.className = 'text-sm mt-3 ' + (d.success ? 'text-lime-400' : 'text-red-400');
    msg.textContent = d.success ? 'Sent via ' + d.via + '. Check which tab it landed in.' : (d.message || 'Failed');
  } catch (e) { msg.className = 'text-sm mt-3 text-red-400'; msg.textContent = 'Connection error'; }
}


// ==================== SEARCH RESULTS PAGE ====================
async function loadSearchResults() {
  const q = document.body.dataset.query || '';
  const box = document.getElementById('searchResults'), sum = document.getElementById('searchSummary');
  if (!box) return;
  if (!q) { sum.textContent = 'Type something in the search bar above.'; return; }
  try {
    const d = await (await fetch('/api/search?full=1&q=' + encodeURIComponent(q))).json();
    const n = d.orders.length + d.customers.length + d.leads.length;
    sum.textContent = n ? `${d.orders.length} order${d.orders.length === 1 ? '' : 's'}, ${d.customers.length} customer${d.customers.length === 1 ? '' : 's'}, ${d.leads.length} lead${d.leads.length === 1 ? '' : 's'}. Click any row to open it here.` : 'Nothing matched. Try part of a name, the order number, a phone number or a VIN.';
    const statusCls = { 'New': 'bg-blue-500/10 text-blue-400', 'In Work': 'bg-amber-500/10 text-amber-400', 'Done': 'bg-lime-500/10 text-lime-400', 'Canceled': 'bg-red-500/10 text-red-400' };
    let html = '';
    if (d.orders.length) html += `
      <section>
        <h3 class="text-lg font-semibold text-white mb-3"><i class="fas fa-clipboard-list text-[var(--orange)] mr-2"></i>Orders <span class="text-muted text-sm font-normal">(${d.orders.length}${d.orders.length === 50 ? '+, narrow the search to see more' : ''})</span></h3>
        <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th>Order</th><th>Customer</th><th class="col-hide-mobile">Vehicle</th><th class="col-hide-mobile">Route</th><th class="text-right">Total</th><th>Status</th><th>Payment</th></tr></thead>
        <tbody class="text-dim">${d.orders.map(o => `<tr class="cursor-pointer" onclick="showOrderDetail('${esc(o.id)}')">
          <td><div class="font-mono text-orange-400 font-semibold">${esc(o.id)}</div><div class="text-[11px] text-muted mt-0.5">${o.createdAt ? new Date(o.createdAt).toLocaleDateString() : ''} · ${o.source === 'admin' ? 'Phone' : 'Website'}</div></td>
          <td><div class="font-medium text-white">${esc(o.customer || '—')}</div><div class="text-[11px] text-muted mt-0.5">${esc(o.email || o.phone || '')}</div></td>
          <td class="col-hide-mobile">${esc(o.vehicle || '—')}${o.vin ? `<div class="text-[11px] text-muted font-mono">${esc(o.vin)}</div>` : ''}</td>
          <td class="col-hide-mobile text-xs">${esc((o.pickup || '').split(',')[0])} → ${esc((o.delivery || '').split(',')[0])}</td>
          <td class="text-right text-white font-semibold whitespace-nowrap">${money(o.total)}</td>
          <td><span class="status-badge ${statusCls[o.status] || statusCls['New']}">${esc(o.status || 'New')}</span></td>
          <td>${payStatePill(o.paymentState, o)}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    if (d.customers.length) html += `
      <section>
        <h3 class="text-lg font-semibold text-white mb-3"><i class="fas fa-users text-[var(--orange)] mr-2"></i>Customers <span class="text-muted text-sm font-normal">(${d.customers.length})</span></h3>
        <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th>Customer</th><th class="col-hide-mobile">Contact</th><th>Type</th><th class="text-center">Orders</th><th class="text-right">Total</th><th class="col-hide-mobile">Last order</th></tr></thead>
        <tbody class="text-dim">${d.customers.map(c => `<tr class="cursor-pointer" onclick="showCustomerDetail(${c.id})">
          <td class="font-medium text-white">${esc(c.name)}${c.company ? `<div class="text-xs text-muted font-normal">${esc(c.company)}</div>` : ''}</td>
          <td class="col-hide-mobile text-sm">${esc(c.email || '—')}${c.phone ? `<div class="text-xs text-muted">${esc(c.phone)}</div>` : ''}</td>
          <td>${typeBadge(c.type)}</td><td class="text-center">${c.orderCount}</td>
          <td class="text-right text-white font-semibold">${money(c.totalSpent)}</td><td class="col-hide-mobile text-xs">${fmtDate(c.lastOrderAt)}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    if (d.leads.length) html += `
      <section>
        <h3 class="text-lg font-semibold text-white mb-3"><i class="fas fa-envelope-open-text text-[var(--orange)] mr-2"></i>Leads <span class="text-muted text-sm font-normal">(${d.leads.length})</span></h3>
        <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th>Email</th><th>Where from</th><th>Date</th></tr></thead>
        <tbody class="text-dim">${d.leads.map(l => `<tr><td><a href="mailto:${esc(l.email)}" class="text-white hover:text-cyan-400">${esc(l.email)}</a></td><td>${esc(l.source || 'website')}</td><td class="text-xs">${l.createdAt ? new Date(l.createdAt).toLocaleString() : ''}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    box.innerHTML = html;
  } catch (e) { sum.textContent = 'Search failed. Try again.'; console.error(e); }
}
