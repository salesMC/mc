// Type-to-filter dropdown ("combobox") used for Year / Make / Model on the calculator,
// checkout and the admin wizard. Works on any text input:
//   const c = mcCombo(inputEl, { items: array | () => array | () => Promise<array>, onSelect(value), onInput(value) });
//   c.reload()  — refetch items (e.g. after the make changed)
// Typing filters the list (matches at the start first, then anywhere), arrow keys move,
// Enter picks, Escape closes, clicking picks. Free text is allowed when nothing matches.
(function () {
  if (!document.getElementById('mc-combo-style')) {
    const st = document.createElement('style'); st.id = 'mc-combo-style';
    st.textContent = `
      .mc-combo { position: relative; }
      .mc-combo-list { position: absolute; left: 0; right: 0; top: 100%; z-index: 70; max-height: 250px; overflow-y: auto; margin-top: 4px;
        background: var(--bg-panel, #161B22); border: 1px solid var(--line, #30363d); border-radius: .5rem; box-shadow: 0 12px 30px rgba(0,0,0,.55); }
      .mc-combo-item { padding: .6rem 1rem; cursor: pointer; color: var(--ink, #e6edf3); font-size: .95rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mc-combo-item:hover, .mc-combo-item.active { background: rgba(255,106,61,.16); color: #fff; }
      .mc-combo-item b { color: var(--orange, #FF6A3D); font-weight: 600; }
      .mc-combo-empty { padding: .6rem 1rem; color: var(--ink-muted, #8b949e); font-size: .85rem; }
      .mc-combo input::-webkit-calendar-picker-indicator { display: none !important; }`;
    document.head.appendChild(st);
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.mcCombo = function (input, opts) {
    opts = opts || {};
    if (!input || input.dataset.comboBound) return input && input._mcCombo;
    input.dataset.comboBound = '1';
    input.setAttribute('autocomplete', 'off');
    const wrap = document.createElement('div'); wrap.className = 'mc-combo';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const list = document.createElement('div'); list.className = 'mc-combo-list'; list.hidden = true; wrap.appendChild(list);
    let items = [], active = -1, open = false, loading = null, hideTimer = null;

    async function load() {
      if (loading) return loading;
      loading = (async () => {
        try { const src = typeof opts.items === 'function' ? await opts.items() : opts.items; items = Array.isArray(src) ? src.map(String) : []; }
        catch (e) { items = []; }
        finally { loading = null; }
      })();
      return loading;
    }
    function filtered() {
      const q = input.value.trim().toLowerCase();
      if (!q) return items;
      const starts = items.filter(x => x.toLowerCase().startsWith(q));
      const incl = items.filter(x => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q));
      return starts.concat(incl);
    }
    function mark(x) {
      const q = input.value.trim(); if (!q) return esc(x);
      const i = x.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return esc(x);
      return esc(x.slice(0, i)) + '<b>' + esc(x.slice(i, i + q.length)) + '</b>' + esc(x.slice(i + q.length));
    }
    function render() {
      const f = filtered();
      if (active >= f.length) active = f.length - 1;
      list.innerHTML = f.length
        ? f.map((x, i) => `<div class="mc-combo-item${i === active ? ' active' : ''}" data-i="${i}">${mark(x)}</div>`).join('')
        : `<div class="mc-combo-empty">${loading ? 'Loading…' : items.length ? 'No match. You can keep what you typed.' : (opts.emptyText || 'Nothing to choose from yet.')}</div>`;
      list.hidden = false; open = true;
      const el = list.querySelector('.mc-combo-item.active'); if (el) el.scrollIntoView({ block: 'nearest' });
      return f;
    }
    function hide() { list.hidden = true; open = false; active = -1; }
    function select(v) { input.value = v; hide(); if (opts.onSelect) opts.onSelect(v); input.dispatchEvent(new Event('change', { bubbles: true })); }
    async function show() { clearTimeout(hideTimer); if (!items.length) { render(); await load(); } render(); }

    input.addEventListener('focus', show);
    input.addEventListener('click', () => { if (!open) show(); });
    input.addEventListener('input', () => { active = input.value.trim() ? 0 : -1; if (!open) show(); else render(); if (opts.onInput) opts.onInput(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) return show(); const f = filtered(); active = Math.min(active + 1, f.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter') { if (!open) return; const f = filtered(); if (active >= 0 && f[active]) { e.preventDefault(); select(f[active]); } else hide(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { hide(); }
    });
    input.addEventListener('blur', () => {
      hideTimer = setTimeout(() => {
        // snap to the exact item if the typed text matches one ignoring case
        const hit = items.find(x => x.toLowerCase() === input.value.trim().toLowerCase());
        if (hit && hit !== input.value) { input.value = hit; if (opts.onSelect) opts.onSelect(hit); }
        hide();
      }, 160);
    });
    list.addEventListener('mousedown', (e) => { const it = e.target.closest('.mc-combo-item'); if (!it) return; e.preventDefault(); select(filtered()[Number(it.dataset.i)]); });

    const api = { reload: async () => { items = []; loading = null; await load(); if (open) render(); }, setItems: (arr) => { items = (arr || []).map(String); if (open) render(); }, hide };
    input._mcCombo = api;
    return api;
  };

  // Shared loaders (cached in the page) for the vehicle lists served by the site
  let makesCache = null; const modelsCache = {};
  window.mcVehicleMakes = async function () {
    if (makesCache) return makesCache;
    try { const d = await (await fetch('/api/vehicles/makes')).json(); makesCache = Array.isArray(d.makes) ? d.makes : []; } catch (e) { makesCache = []; }
    return makesCache;
  };
  window.mcVehicleModels = async function (make, year) {
    make = String(make || '').trim(); year = String(year || '').trim();
    if (!make) return [];
    const key = make.toLowerCase() + '|' + year;
    if (modelsCache[key]) return modelsCache[key];
    try { const d = await (await fetch('/api/vehicles/models?make=' + encodeURIComponent(make) + (year ? '&year=' + encodeURIComponent(year) : ''))).json(); modelsCache[key] = Array.isArray(d.models) ? d.models : []; }
    catch (e) { modelsCache[key] = []; }
    return modelsCache[key];
  };
  // Body type + weight for a year/make/model (cached on the server): used to auto-pick the vehicle type
  window.mcVehicleInfo = async function (year, make, model) {
    make = String(make || '').trim(); model = String(model || '').trim();
    if (!make || !model) return null;
    try { const d = await (await fetch('/api/vehicles/info?year=' + encodeURIComponent(year || '') + '&make=' + encodeURIComponent(make) + '&model=' + encodeURIComponent(model))).json(); return d.success ? d : null; } catch (e) { return null; }
  };
  // "FORD" (as the VIN decoder returns it) → "Ford" using the site's make list
  window.mcPrettyMake = function (name) {
    name = String(name || '').trim(); if (!name) return '';
    const hit = (makesCache || []).find(m => m.toLowerCase() === name.toLowerCase());
    return hit || name.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^Bmw$/, 'BMW').replace(/^Gmc$/, 'GMC').replace(/^Mini$/, 'Mini');
  };
  window.mcYears = function () { const out = []; for (let y = new Date().getFullYear() + 1; y >= 1960; y--) out.push(String(y)); return out; };
})();
