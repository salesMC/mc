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

  if (page === 'orders')      loadOrders();
  if (page === 'payments')    loadPayments();
  if (page === 'promo-codes') loadPromoCodes();
  if (page === 'customers') {
    loadCustomers().then(() => {
      // /admin/customers?open=<id> deep-links to a customer (used from the order modal)
      const open = new URLSearchParams(location.search).get('open');
      if (open) showCustomerDetail(Number(open));
    });
  }
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

function resetConfig() {
  if (!confirm('Reset all calculator settings to default?')) return;
  fetch('/api/settings/calculator', { method: 'DELETE' })
    .then(r => r.json())
    .then(d => { if (!d.success) throw new Error(); location.reload(); })
    .catch(() => alert('Error resetting settings'));
}

// ==================== ORDERS MANAGEMENT ====================
async function loadOrders() {
  try {
    const tbody = document.getElementById('ordersBody');
    if (!tbody) return; // not on the Orders page
    const res = await fetch('/api/orders');
    const orders = await res.json();
    tbody.innerHTML = '';

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
        <td>${payStatePill(order.paymentState)}</td>
        <td class="text-center whitespace-nowrap">
          <button onclick="event.stopImmediatePropagation(); showOrderDetail('${esc(order.id)}')"
                  class="text-cyan-400 hover:text-white p-2" title="Open">
            <i class="fas fa-eye"></i>
          </button>
          ${order.status === 'Done' || order.status === 'Canceled' ? `
            <button onclick="event.stopImmediatePropagation(); deleteOrder('${esc(order.id)}', this)"
                    class="text-red-400 hover:text-red-500 p-2" title="Delete">
              <i class="fas fa-trash"></i>
            </button>
          ` : ''}
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

async function deleteOrder(orderId) {
  if (!confirm(`Delete order ${orderId} permanently?`)) return;
  try {
    const res = await fetch(`/api/orders/${orderId}`, { method: 'DELETE' });
    if (res.ok) loadOrders();
  } catch (err) {
    alert('Error deleting order');
  }
}

async function showOrderDetail(orderId) {
  try {
    const res = await fetch('/api/orders/' + orderId);
    const order = await res.json();
    if (!order || !order.id) return;

    document.getElementById('modalOrderId').textContent = `Order ${order.id}`;
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
            <button onclick="window.location.href='/admin/customers?open=${order.customerId}'"
                    class="text-cyan-400 hover:text-white text-sm mt-3 inline-flex items-center gap-1">
              <i class="fas fa-user"></i> View customer &amp; history
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

      ${confirmationPanelHTML(order)}

      <div class="mt-10 pt-6 border-t border-[var(--line)] flex justify-between items-center">
        <div>
          <p class="text-muted text-sm">Total Amount</p>
          <p class="text-4xl font-bold text-[var(--orange)]">$${Number(order.total || 0).toLocaleString()}</p>
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
function payStatePill(state) {
  const [label, cls, title] = PAY_STATE_LABELS[state] || [state || '—', 'pay-released', ''];
  return `<span class="pay-pill ${cls}" style="margin-left:0" title="${esc(title)}">${label}</span>`;
}
function paymentPill(o) { return payStatePill(o.paymentState); }

let customersCache = [];
let customerSearchTimer = null;

async function loadCustomers() {
  const tbody = document.getElementById('customersBody');
  if (!tbody) return; // not on the Customers page
  const q = document.getElementById('customerSearch')?.value.trim() || '';
  try {
    const res = await fetch('/api/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
    customersCache = await res.json();
    tbody.innerHTML = '';
    document.getElementById('customerCount').textContent = customersCache.length;

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
  customerSearchTimer = setTimeout(loadCustomers, 250);
}

async function showCustomerDetail(id) {
  try {
    const res = await fetch('/api/customers/' + id);
    const c = await res.json();
    if (!c || !c.id) return;

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
    el.innerHTML = wizQuoteHTML();
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
    wiz.location = { pickup: g('wr-pickup').value.trim(), delivery: g('wr-delivery').value.trim() };
    wiz.distance = g('wr-distance').value;
    wiz.pickupDate = g('wr-pickupDate').value;
    wiz.mustDeliverBy = g('wr-deliverBy').value;
  } else if (wiz.step === 3 && g('wizFinalPrice')) {
    wiz.finalPrice = g('wizFinalPrice').value;
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
        <label class="label-dark">Damages / Condition Notes</label>
        <textarea id="wv-damages-${i}" class="input-dark" placeholder="Dents, scratches, missing parts, leaks, flat tires, broken glass…">${esc(v.damages)}</textarea>
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
    new google.maps.places.Autocomplete(p, opts).addListener('place_changed', wizCalcDistance);
    new google.maps.places.Autocomplete(d, opts).addListener('place_changed', wizCalcDistance);
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
function wizComputedTotal() { return wiz.vehicles.reduce((sum, v) => sum + wizVehiclePrice(v), 0); }
function wizUpdateRunningTotal() {
  if (!wiz) return;
  const t = document.getElementById('wizRunningTotal');
  if (t) t.textContent = '$' + wizComputedTotal().toLocaleString();
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
      <div class="text-[var(--orange)] font-semibold shrink-0">$${wizVehiclePrice(v).toLocaleString()}</div>
    </div>`).join('');

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

    <div class="mb-6">${rows}</div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5 items-start">
      <div class="bg-[var(--bg-deep)] border border-[var(--line)] rounded-xl p-5">
        <div class="text-xs text-muted">Calculated price</div>
        <div class="text-2xl font-bold text-white mb-4">$${computed.toLocaleString()}</div>
        <label class="label-dark">Final quoted price ($)</label>
        <input id="wizFinalPrice" type="number" min="0" step="1" class="input-dark text-2xl font-bold"
               style="color: var(--orange);" value="${esc(final)}" oninput="wiz.finalPrice = this.value">
        <button type="button" onclick="wiz.finalPrice = null; document.getElementById('wizFinalPrice').value = ${computed}"
                class="text-xs text-cyan-400 hover:text-white mt-2"><i class="fas fa-rotate-left mr-1"></i>Use calculated price</button>
      </div>
      <div>
        <label class="label-dark">Internal order notes</label>
        <textarea id="wizNotes" class="input-dark" style="min-height:140px" placeholder="Call notes, special instructions, gate codes…">${esc(wiz.notes)}</textarea>
        <p class="text-xs text-muted mt-2">
          Saved as an <span class="text-red-400 font-semibold">unpaid</span> phone-in order.
          Mark it paid from the order details once payment is collected.
        </p>
      </div>
    </div>`;
}

async function wizSave() {
  wizCollect();
  const total = Math.max(0, Math.round(Number(wiz.finalPrice)) || wizComputedTotal());
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
  const agreedRow = o.agreedAt ? `
    <p class="text-sm mt-2"><i class="fas fa-file-signature text-lime-400 mr-1"></i>
      Agreed by <strong class="text-white">${esc(o.agreedName || '—')}</strong> on ${fmtDateTime(o.agreedAt)}${o.agreedIp ? ` <span class="text-muted">(IP ${esc(o.agreedIp)})</span>` : ''}
    </p>` : '';
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

async function loadPayments() {
  const tbody = document.getElementById('paymentsBody');
  if (!tbody) return;
  try {
    const res = await fetch('/api/payments');
    const data = await res.json();
    paymentsCache = data.payments || [];
    const t = data.totals || {};
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = money(v); };
    set('payTotalHolding', t.holding); set('payTotalCharged', t.charged); set('payTotalRefunded', t.refunded); set('payTotalPending', t.pending);
    renderPayments();
  } catch (e) { console.error('loadPayments:', e); }
}

function setPaymentsFilter(f) {
  paymentsFilter = f;
  document.querySelectorAll('[data-pay-filter]').forEach(b => b.classList.toggle('active', b.dataset.payFilter === f));
  renderPayments();
}

function renderPayments() {
  const tbody = document.getElementById('paymentsBody');
  if (!tbody) return;
  const q = (document.getElementById('paymentsSearch')?.value || '').trim().toLowerCase();
  const rows = paymentsCache.filter(PAYMENT_FILTERS[paymentsFilter] || PAYMENT_FILTERS.all)
    .filter(p => !q || [p.id, p.customer, p.email, p.phone, p.vehicle].some(v => String(v || '').toLowerCase().includes(q)));
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
    let actions = '';
    if (p.paymentState === 'holding') {
      actions += btn('Charge', 'pay-action-primary', `markPickedUp('${id}', ${Number(p.holdAmount || p.total)}, loadPayments)`, 'Vehicle picked up — charge the full amount or a custom amount');
      actions += btn('No-show fee', '', `chargeNoShowFee('${id}', ${Number(p.noShowFee || 150)})`, 'Vehicle was gone — charge the agreed fee instead');
      actions += btn('Release', 'pay-action-danger', `releaseHold('${id}')`, 'Cancel the hold without charging');
    }
    if (['charged', 'partially_refunded', 'fee_charged'].includes(p.paymentState) && remaining > 0 && (p.stripePaymentIntentId || p.feePaymentIntentId))
      actions += btn('Refund', 'pay-action-danger', `refundOrder('${id}', ${remaining}, loadPayments)`, `Refund up to ${money(remaining)}`);
    if (['unpaid', 'released', 'expired', 'pending'].includes(p.paymentState) && p.source === 'admin')
      actions += btn(p.paymentState === 'pending' ? 'Resend link' : 'Send confirmation', 'pay-action-primary', `sendConfirmationFromPayments('${id}')`, 'Email the customer the pickup confirmation + card link');
    actions += btn('<i class="fas fa-eye"></i>', '', `showOrderDetail('${id}')`, 'Open order');

    return `<tr class="cursor-pointer" onclick="showOrderDetail('${id}')">
      <td><div class="font-mono text-orange-400 font-semibold">${id}</div><div class="text-[11px] text-muted mt-0.5">${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ''} · ${p.source === 'admin' ? 'Phone' : 'Website'}</div></td>
      <td><div class="font-medium text-white">${esc(p.customer || '—')}</div><div class="text-[11px] text-muted mt-0.5 truncate max-w-[220px]">${esc(p.email || p.phone || '')}</div></td>
      <td class="col-hide-mobile text-sm">${esc(p.vehicle || '—')}</td>
      <td>${payStatePill(p.paymentState)}</td>
      <td class="text-sm">${amountCell}</td>
      <td class="text-right whitespace-nowrap">${actions}</td>
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
