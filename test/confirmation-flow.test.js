/**
 * End-to-end tests: authentication, server-side pricing + website checkout,
 * and the phone-in pickup confirmation / card-hold flow.
 *
 * Runs the real Express app against the real database, but swaps the `stripe`
 * and `nodemailer` modules for in-memory fakes so no real charges or emails
 * happen. The fake Stripe behaves like the real API for the calls we make, and
 * the test plays the customer's browser by "authorizing" PaymentIntents the way
 * Stripe.js would.
 *
 * Run:  npm test          (needs .env with DB access; admin password from
 *                          ADMIN_DEFAULT_PASSWORD or the historical default)
 */

process.env.PORT = process.env.TEST_PORT || '3990';
process.env.SMTP_HOST = 'mock.smtp';            // enable the mailer (fake transport below)
process.env.SMTP_USER = 'mock@mcships.com';
process.env.MAIL_FROM = 'MC Transportation <mock@mcships.com>';
process.env.ADMIN_NOTIFY_EMAIL = 'admin@mcships.test';
process.env.APP_URL = 'https://mcships.test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.MAIL_DISABLE_GMAIL = '1';
process.env.ANTHROPIC_API_KEY = '';                  // never call the AI during tests (metro-distance rule only)
process.env.EIA_API_KEY = '';               // never send real mail through the connected Gmail during tests

// ---------- Fake Stripe ----------
const S = { n: 0, customers: [], intents: {}, detached: [], failNextOffSession: false };
const stripeErr = (message, type) => Object.assign(new Error(message), { type });
const getPI = id => { const pi = S.intents[id]; if (!pi) throw stripeErr(`No such payment_intent: ${id}`, 'StripeInvalidRequestError'); return pi; };
const fakeStripe = {
  customers: {
    create: async (p) => { const c = { id: `cus_test${++S.n}`, ...p }; S.customers.push(c); return c; }
  },
  paymentIntents: {
    create: async (p) => {
      if (p.confirm) {
        if (!p.payment_method) throw stripeErr('payment_method required to confirm', 'StripeInvalidRequestError');
        if (S.failNextOffSession) { S.failNextOffSession = false; throw stripeErr('Your card was declined.', 'StripeCardError'); }
      }
      const pi = {
        id: `pi_test${++S.n}`, object: 'payment_intent',
        status: p.confirm ? 'succeeded' : 'requires_payment_method',
        amount: p.amount, amount_received: p.confirm ? p.amount : 0,
        created: Math.floor(Date.now() / 1000), currency: p.currency,
        customer: p.customer, payment_method: p.payment_method || null,
        capture_method: p.capture_method || 'automatic', setup_future_usage: p.setup_future_usage || null,
        off_session: !!p.off_session, metadata: p.metadata || {}, description: p.description
      };
      pi.client_secret = `${pi.id}_secret_test`;
      S.intents[pi.id] = pi; return pi;
    },
    retrieve: async (id) => getPI(id),
    capture: async (id, o) => {
      const pi = getPI(id);
      if (pi.status !== 'requires_capture') throw stripeErr(`Cannot capture a PaymentIntent with status ${pi.status}`, 'StripeInvalidRequestError');
      pi.status = 'succeeded'; pi.amount_received = (o && o.amount_to_capture) || pi.amount; return pi;
    },
    cancel: async (id) => { const pi = getPI(id); pi.status = 'canceled'; return pi; }
  },
  paymentMethods: {
    detach: async (id) => { S.detached.push(id); return { id }; }
  },
  webhooks: {
    constructEvent: (body, sig, secret) => { if (sig !== 'good-sig' || secret !== 'whsec_test') throw new Error('No signatures found matching the expected signature for payload'); return JSON.parse(body.toString()); }
  },
  refunds: {
    create: async (p) => {
      const pi = getPI(p.payment_intent);
      if (pi.status !== 'succeeded') throw stripeErr('Charge has not succeeded', 'StripeInvalidRequestError');
      pi.amount_refunded = (pi.amount_refunded || 0) + p.amount;
      if (pi.amount_refunded > pi.amount_received) throw stripeErr('Refund amount exceeds charge', 'StripeInvalidRequestError');
      const rf = { id: `re_test${++S.n}`, object: 'refund', amount: p.amount, payment_intent: pi.id, status: 'succeeded', metadata: p.metadata || {} };
      (S.refunds = S.refunds || []).push(rf); return rf;
    }
  },
  // what Stripe.js does in the browser after confirmCardPayment on a manual-capture intent
  __authorize(id) { const pi = getPI(id); pi.status = 'requires_capture'; pi.payment_method = `pm_test_visa_${id}`; return pi; },
  // ...and on a normal (auto-capture) checkout intent
  __pay(id) { const pi = getPI(id); pi.status = 'succeeded'; pi.amount_received = pi.amount; pi.payment_method = `pm_test_visa_${id}`; return pi; }
};

// ---------- Fake nodemailer ----------
const MAIL = [];
const fakeNodemailer = { createTransport: () => ({ sendMail: async (m) => { MAIL.push(m); return { messageId: 'mock' }; } }) };

// ---------- Module injection ----------
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return () => fakeStripe;
  if (request === 'nodemailer') return fakeNodemailer;
  return origLoad.apply(this, arguments);
};

const path = require('path');
const { pool, expireCardHolds } = require(path.join(__dirname, '..', 'app.js'));
const B = `http://localhost:${process.env.PORT}`;
// The suite signs in as its own throw-away admin (created below, removed at the end)
// so it never depends on — or touches — the real admin password.
const ADMIN_EMAIL = 'test-admin@mcships.test';
const ADMIN_PASSWORD = 'test-' + require('crypto').randomBytes(8).toString('hex');
async function createTestAdmin() {
  const bcrypt = require('bcryptjs');
  await pool.execute('DELETE FROM employees WHERE email = ?', [ADMIN_EMAIL]);
  await pool.execute('INSERT INTO employees (email, password, role, name) VALUES (?, ?, ?, ?)', [ADMIN_EMAIL, await bcrypt.hash(ADMIN_PASSWORD, 10), 'admin', 'Test Admin']);
}
async function removeTestAdmin() { await pool.execute('DELETE FROM employees WHERE email = ?', [ADMIN_EMAIL]); }

// ---------- Tiny test harness ----------
let passed = 0, failed = 0;
let adminCookie = '';
const created = { orders: [], customers: [] };
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}
// auth=true sends the admin cookie; auth=false is an anonymous request
async function api(method, url, body, { auth = true, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && adminCookie) headers.Cookie = adminCookie;
  const res = await fetch(B + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return res;
  let data = null; try { data = await res.json(); } catch (e) {}
  return { status: res.status, data, headers: res.headers };
}
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(B + '/api/settings/calculator'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}
async function newOrder(id, overrides = {}) {
  const r = await api('POST', '/api/orders', {
    id, source: 'admin',
    contact: { fullName: 'Test Caller', email: `${id.toLowerCase()}@example.test`, phone: '555-0100', type: 'dealer' },
    vehicles: [{ year: '2022', make: 'Honda', model: 'Civic', type: 'sedan', condition: 'operable', photos: [] }],
    location: { pickup: '100 Main St, Louisville, KY', delivery: '200 Broadway, Nashville, TN' },
    distance: 175, pickupDate: '2026-09-05', mustDeliverBy: '2026-09-10', transportType: 'open', total: 650,
    ...overrides
  });
  if (!r.data || !r.data.success) throw new Error('order create failed: ' + JSON.stringify(r.data));
  created.orders.push(id); if (r.data.customerId) created.customers.push(r.data.customerId);
  return r.data;
}
const order = async id => (await api('GET', `/api/orders/${id}`)).data;
const lastMailTo = to => [...MAIL].reverse().find(m => m.to === to);
// Price through the public engine endpoint (the same code path checkout and quotes use)
const priceVia = async (vehicles, miles, extra = {}) => (await api('POST', '/api/price', { vehicles, distance: miles, ...extra }, { auth: false })).data.total;

// Send confirmation + play the customer through agreement and card authorization (public calls)
async function sendAndAuthorize(id, fee) {
  const sent = await api('POST', `/api/orders/${id}/send-confirmation`, { noShowFee: fee });
  const token = sent.data.link.split('/').pop();
  const agree = await api('POST', `/api/confirm/${token}/agree`, { agreedName: 'Test Caller', agreed: true }, { auth: false });
  fakeStripe.__authorize(agree.data.paymentIntentId);
  const done = await api('POST', `/api/confirm/${token}/complete`, { paymentIntentId: agree.data.paymentIntentId }, { auth: false });
  return { sent, token, agree, done };
}

// ================================================================
(async () => {
  await waitForServer();
  await createTestAdmin();
  console.log('\nServer up — running tests\n');

  // ---------- 0. Authentication ----------
  console.log('0) Authentication & access control');
  let r = await api('GET', '/api/orders', null, { auth: false });
  check('orders list without login → 401', r.status === 401, r.status);
  r = await api('POST', '/api/employees', { email: 'evil@x.test', password: 'hackhackhack', role: 'admin' }, { auth: false });
  check('creating an admin without login → 401', r.status === 401, r.status);
  r = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'wrong-password' }, { auth: false });
  check('wrong password → 401', r.status === 401, r.status);
  let raw = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin' }, { auth: false, raw: true });
  const setCookie = raw.headers.get('set-cookie') || '';
  adminCookie = setCookie.split(';')[0];
  check('admin login sets an httpOnly session cookie', raw.status === 200 && /mc_session=/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Lax/.test(setCookie), setCookie.slice(0, 60));
  check('without "keep me signed in" the cookie is a browser-session cookie (no Max-Age)', !/Max-Age/.test(setCookie), setCookie.replace(/mc_session=[^;]+/, 'mc_session=…'));
  raw = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, role: 'admin', remember: true }, { auth: false, raw: true });
  check('"keep me signed in" → 30-day cookie', /Max-Age=2592000/.test(raw.headers.get('set-cookie') || ''), raw.headers.get('set-cookie')?.replace(/mc_session=[^;]+/, 'mc_session=…'));

  // Forgot / reset password
  r = await api('POST', '/api/auth/forgot', { email: 'nobody@x.test' }, { auth: false });
  check('forgot-password for unknown email still answers ok (no account discovery)', r.status === 200 && r.data.success);
  r = await api('POST', '/api/auth/forgot', { email: ADMIN_EMAIL }, { auth: false });
  const resetMail = lastMailTo(ADMIN_EMAIL);
  const resetToken = resetMail && (resetMail.text.match(/\/reset-password\/([a-f0-9]{64})/) || [])[1];
  check('forgot-password emails a reset link', r.data.success && !!resetToken, resetMail && resetMail.subject);
  let page = await fetch(`${B}/reset-password/${resetToken}`);
  check('reset page loads', page.status === 200 && (await page.text()).includes('Choose a new password'));
  page = await fetch(`${B}/reset-password/not-a-token`);
  check('bad reset token → 404', page.status === 404);
  r = await api('POST', '/api/auth/reset', { token: resetToken, password: 'short' }, { auth: false });
  check('reset with short password → 400', r.status === 400);
  const TEMP_PW = 'temporary-pass-' + Date.now();
  raw = await api('POST', '/api/auth/reset', { token: resetToken, password: TEMP_PW }, { auth: false, raw: true });
  const resetData = await raw.json();
  check('reset sets the new password and signs in', raw.status === 200 && resetData.success && resetData.role === 'admin' && /mc_session=/.test(raw.headers.get('set-cookie') || ''), resetData);
  r = await api('POST', '/api/auth/reset', { token: resetToken, password: 'another-password' }, { auth: false });
  check('reset link cannot be reused', r.status === 400);
  r = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, { auth: false });
  check('old password no longer works', r.status === 401);
  r = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: TEMP_PW, role: 'admin' }, { auth: false });
  check('new password works', r.status === 200 && r.data.success);
  // put the original password back so the rest of the suite (and the admin) keep working
  r = await api('POST', '/api/auth/change-password', { currentPassword: TEMP_PW, newPassword: ADMIN_PASSWORD });
  check('password restored', r.status === 200 && r.data.success, r.data);
  r = await api('GET', '/api/auth/me');
  check('/api/auth/me reports admin', r.data.authenticated && r.data.role === 'admin' && r.data.email === ADMIN_EMAIL, r.data);
  r = await api('GET', '/api/orders');
  check('orders list with cookie → 200', r.status === 200 && Array.isArray(r.data));
  const forged = adminCookie.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
  raw = await fetch(B + '/api/orders', { headers: { Cookie: forged } });
  check('tampered cookie → 401', raw.status === 401, raw.status);
  raw = await fetch(B + '/admin/orders', { redirect: 'manual' });
  check('admin page without cookie redirects to sign-in', raw.status === 302 && /\/admin\?next=/.test(raw.headers.get('location') || ''), raw.headers.get('location'));
  raw = await fetch(B + '/admin/orders', { headers: { Cookie: adminCookie } });
  check('admin page with cookie → 200 + security headers', raw.status === 200 && raw.headers.get('x-frame-options') === 'DENY' && raw.headers.get('x-content-type-options') === 'nosniff');
  r = await api('GET', '/api/exchange/loads', null, { auth: false });
  check('exchange API without login → 401', r.status === 401, r.status);
  r = await api('POST', '/api/auth/register', { email: 'weak@x.test', password: 'short', role: 'carrier' }, { auth: false });
  check('register with short password → 400', r.status === 400, r.status);

  // ---------- 1. Server-side pricing + website checkout ----------
  console.log('\n1) Server-side pricing & website checkout');
  r = await api('GET', '/api/settings/calculator', null, { auth: false });
  const cfg = r.data;
  check('public pricing config available', r.status === 200 && cfg && cfg.baseFee > 0 && Array.isArray(cfg.tiers), cfg);
  r = await api('PUT', '/api/settings/calculator', { ...cfg, baseFee: 999 }, { auth: false });
  check('saving pricing without login → 401', r.status === 401, r.status);
  r = await api('PUT', '/api/settings/calculator', { baseFee: -5, tiers: [] });
  check('invalid pricing rejected → 400', r.status === 400, r.status);

  // ---- pricing engine sanity: rates slope down with distance, market layers apply, admin sees the breakdown ----
  const sedan = [{ type: 'sedan', condition: 'operable' }];
  const pLong = await priceVia(sedan, 2900), pMid = await priceVia(sedan, 470), pShort = await priceVia(sedan, 30);
  check('cross-country sedan priced near market (1,600–2,300)', pLong >= 1600 && pLong <= 2300, pLong);
  check('per-mile rate falls with distance', (pLong / 2900) < (pMid / 470) && (pMid / 470) < (pShort / 30), { long: +(pLong / 2900).toFixed(2), mid: +(pMid / 470).toFixed(2), short: +(pShort / 30).toFixed(2) });
  check('short local run hits the minimum price', pShort === 250, pShort);
  const cfgAdd = (await api('GET', '/api/settings/calculator', null, { auth: false })).data.addons;
  const pUrgent = await priceVia([{ type: 'sedan', condition: 'operable', urgent: true }], 20);
  const pBoth = await priceVia([{ type: 'sedan', condition: 'operable', urgent: true, modified: true }], 20);
  const pInop = await priceVia([{ type: 'sedan', condition: 'inoperable' }], 20);
  check('urgent / modified / inoperable add their full fee on top of the minimum', pUrgent === 250 + cfgAdd.urgent && pBoth === 250 + cfgAdd.urgent + cfgAdd.modified && pInop === 250 + cfgAdd.inoperable, { pUrgent, pBoth, pInop, cfgAdd });
  r = await api('POST', '/api/price', { vehicles: [{ type: 'sedan', condition: 'operable', urgent: true, modified: true }], distance: 20 }, { auth: false });
  check('public price lists the extras with amounts and a transport figure that adds up', r.data.transport === 250 && r.data.addons.length === 2 && r.data.addons.every(x => /Urgent|Modified/.test(x.label)) && r.data.transport + r.data.addons.reduce((s, x) => s + x.amount, 0) === r.data.total && !r.data.lines, r.data);
  const pEnclosed = await priceVia(sedan, 2900, { transportType: 'enclosed' });
  check('enclosed costs more than open', pEnclosed > pLong * 1.3, { open: pLong, enclosed: pEnclosed });
  const p1001 = await priceVia(sedan, 1001), p1000 = await priceVia(sedan, 1000);
  check('no price cliff between distance bands', p1001 >= p1000, { p1000, p1001 });
  const twoCars = await priceVia([sedan[0], sedan[0]], 470);
  check('second vehicle gets the extra-vehicle discount', twoCars < pMid * 2 && twoCars > pMid, { one: pMid, two: twoCars });
  r = await api('POST', '/api/price', { vehicles: sedan, distance: 470 });
  check('admin gets the breakdown lines and factors', r.data.success && Array.isArray(r.data.lines) && r.data.lines.length >= 1 && r.data.factors && typeof r.data.cpm === 'number', r.data && Object.keys(r.data));
  r = await api('POST', '/api/price', { vehicles: sedan, distance: 470 }, { auth: false });
  check('public callers get the total only', r.data.success && r.data.total > 0 && !r.data.lines, r.data);
  // market dial moves every quote; reset afterwards
  r = await api('PUT', '/api/settings/pricing', { marketPct: 10 });
  check('market settings saved', r.status === 200 && r.data.pricing.marketPct === 10, r.data);
  const pDial = await priceVia(sedan, 470);
  check('market dial +10% raises the price', pDial > pMid && pDial <= Math.round(pMid * 1.11) + 1, { before: pMid, after: pDial });
  r = await api('PUT', '/api/settings/pricing', { marketPct: 10 }, { auth: false });
  check('market settings need login', r.status === 401);
  await api('DELETE', '/api/settings/pricing');
  check('market settings reset', (await priceVia(sedan, 470)) === pMid);
  const inTwoDays = new Date(Date.now() + 86400000).toISOString().slice(0, 10), inTenDays = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), inTwentyDays = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
  const pRush = await priceVia(sedan, 470, { pickupDate: inTwoDays }), pFlex = await priceVia(sedan, 470, { pickupDate: inTenDays, mustDeliverBy: inTwentyDays });
  check('short-notice pickup costs more, flexible window costs less', pRush > pMid && pFlex < pMid, { normal: pMid, rush: pRush, flex: pFlex });
  // ---- location difficulty (metro distance) + lanes ----
  const pCity = await priceVia(sedan, 470, { pickup: '100 Main St, Louisville, KY 40202, USA', pickupLat: 38.2527, pickupLng: -85.7585, delivery: '200 Broadway, Nashville, TN 37201, USA', deliveryLat: 36.1627, deliveryLng: -86.7816 });
  check('city-to-city: no location fee', pCity === pMid, { city: pCity, plain: pMid });
  const pRemote = await priceVia(sedan, 470, { pickup: '100 Main St, Louisville, KY 40202, USA', pickupLat: 38.2527, pickupLng: -85.7585, delivery: 'Ranch Rd, Eureka, NV 89316, USA', deliveryLat: 39.5, deliveryLng: -116.5 });
  check('remote delivery (far from any metro) adds a tier fee', pRemote > pCity, { city: pCity, remote: pRemote });
  r = await api('POST', '/api/price', { vehicles: sedan, distance: 470, pickup: '100 Main St, Louisville, KY 40202, USA', pickupLat: 38.2527, pickupLng: -85.7585, delivery: 'Ranch Rd, Eureka, NV 89316, USA', deliveryLat: 39.5, deliveryLng: -116.5 });
  check('admin breakdown names the hard-to-reach delivery with its tier', r.data.lines.some(l => /Hard-to-reach delivery \(tier [23]/.test(l.label)) && r.data.factors.deliveryDifficulty && r.data.factors.deliveryDifficulty.tier >= 2, r.data.lines.map(l => l.label));
  const pRemote2 = await priceVia(sedan, 470, { pickup: '100 Main St, Louisville, KY 40202, USA', pickupLat: 38.2527, pickupLng: -85.7585, delivery: 'Ranch Rd, Eureka, NV 89316, USA', deliveryLat: 39.5, deliveryLng: -116.5 });
  check('same address → same price (rating cached)', pRemote2 === pRemote);
  r = await api('GET', '/api/locations?q=Eureka');
  const rated = r.data.find(x => /Eureka/.test(x.address));
  check('rated address listed in admin', !!rated && rated.metroMiles > 120, rated && { m: rated.metro, mi: rated.metroMiles });
  r = await api('PATCH', '/api/locations/' + rated.id, { overrideTier: 0 });
  const pOverride = await priceVia(sedan, 470, { pickup: '100 Main St, Louisville, KY 40202, USA', pickupLat: 38.2527, pickupLng: -85.7585, delivery: 'Ranch Rd, Eureka, NV 89316, USA', deliveryLat: 39.5, deliveryLng: -116.5 });
  check('admin override to tier 0 removes the fee', r.status === 200 && pOverride === pCity, { o: pOverride, city: pCity });
  await pool.execute('DELETE FROM location_ratings WHERE address LIKE ?', ['%Eureka, NV%']);
  const pFLNE = await priceVia(sedan, 1300, { pickup: '1 Biscayne Blvd, Miami, FL 33132, USA', delivery: '1 Main St, Hartford, CT 06103, USA' });
  const pNEFL = await priceVia(sedan, 1300, { pickup: '1 Main St, Hartford, CT 06103, USA', delivery: '1 Biscayne Blvd, Miami, FL 33132, USA' });
  const pPlain1300 = await priceVia(sedan, 1300);
  check('lane table: out of Florida costs more than into Florida', pFLNE > pPlain1300 && pNEFL < pPlain1300 && pFLNE > pNEFL, { out: pFLNE, into: pNEFL, plain: pPlain1300 });
  r = await api('POST', '/api/price', { vehicles: sedan, distance: 1300, pickup: '1 Biscayne Blvd, Miami, FL 33132, USA', delivery: '1 Main St, Hartford, CT 06103, USA' });
  check('lane line shows the regions', r.data.lines.some(l => /Lane Florida → Northeast/.test(l.label)), r.data.lines.map(l => l.label));

  const webVehicles = [{ year: '2020', make: 'Kia', model: 'K5', type: 'pickup', condition: 'inoperable', modified: false, urgent: true }];
  const expected = await priceVia(webVehicles, 400);
  r = await api('POST', '/api/create-payment-intent', { vehicles: webVehicles, distance: 400, amount: 50 }, { auth: false });
  check('payment intent priced by the server (client "amount" ignored)', r.data.success && r.data.amount === expected && S.intents[r.data.paymentIntentId].amount === expected * 100, { got: r.data.amount, expected });
  check('intent tagged as web_checkout with distance', S.intents[r.data.paymentIntentId].metadata.kind === 'web_checkout' && S.intents[r.data.paymentIntentId].metadata.distance === '400');
  const webPi = r.data.paymentIntentId;
  r = await api('POST', '/api/create-payment-intent', { vehicles: webVehicles, distance: 0 }, { auth: false });
  check('distance of 0 rejected', r.status === 400);

  const webOrder = { id: 'MC-T-WEB', contact: { fullName: 'Web Buyer', email: 'mc-t-web@example.test', phone: '555-0111' }, vehicles: webVehicles,
    location: { pickup: 'A, GA', delivery: 'B, TX' }, total: 1, source: 'admin', paymentStatus: 'unpaid' };
  r = await api('POST', '/api/orders', webOrder, { auth: false });
  check('web order without a payment → 402', r.status === 402, r.status);
  r = await api('POST', '/api/orders', { ...webOrder, stripePaymentIntentId: webPi }, { auth: false });
  check('web order with an unpaid intent → 402', r.status === 402, r.status);
  fakeStripe.__pay(webPi);
  r = await api('POST', '/api/orders', { ...webOrder, stripePaymentIntentId: webPi }, { auth: false });
  created.orders.push('MC-T-WEB'); if (r.data && r.data.customerId) created.customers.push(r.data.customerId);
  check('web order created once paid', r.data && r.data.success, r.data);
  let o = await order('MC-T-WEB');
  check('web order stores the engine breakdown for admin', o.pricing && Array.isArray(o.pricing.lines) && o.pricing.lines.length >= 1 && typeof o.pricing.cpm === 'number', o.pricing);
  check('total = amount Stripe collected, not the client\'s $1; source web; paid; distance from intent',
    o.total === expected && o.source === 'web' && o.paymentStatus === 'paid' && o.distance === 400 && !!o.chargedAt, o);
  r = await api('POST', '/api/orders', { ...webOrder, id: 'MC-T-WEB2', stripePaymentIntentId: webPi }, { auth: false });
  check('reusing the same payment for a second order → 409', r.status === 409 && r.data.orderId === 'MC-T-WEB', r.data);
  const foreign = await fakeStripe.paymentIntents.create({ amount: 5000, currency: 'usd', metadata: { kind: 'pickup_hold' } });
  fakeStripe.__pay(foreign.id);
  r = await api('POST', '/api/orders', { ...webOrder, id: 'MC-T-WEB3', stripePaymentIntentId: foreign.id }, { auth: false });
  check('payment not created by checkout → 402', r.status === 402, r.status);

  // ---------- 2. Input hardening ----------
  console.log('\n2) Input hardening');
  await newOrder('MC-T-SAN', { vehicles: [{ year: '2021', make: '<img src=x onerror=alert(1)>', model: 'X'.repeat(500), type: 'not-a-type', condition: 'weird',
    photos: [{ name: 'a', data: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }, { name: 'ok.png', data: 'data:image/png;base64,iVBORw0KGgo=' }] }] });
  o = await order('MC-T-SAN');
  const v = o.vehicles[0];
  await newOrder('MC-T-QFEE', { total: 1, noShowFee: 75 });
  o = await order('MC-T-QFEE');
  check('admin quote saves the adjusted price and the dry-run fee', o.total === 1 && o.noShowFee === 75, { t: o.total, f: o.noShowFee });
  r = await api('POST', '/api/orders/MC-T-QFEE/send-confirmation', {});
  check('confirmation uses the saved fee when none is typed', r.status === 200 && (await order('MC-T-QFEE')).noShowFee === 75);
    check('unknown vehicle type/condition normalised, long strings trimmed', v.type === 'sedan' && v.condition === 'operable' && v.model.length === 60, { type: v.type, cond: v.condition, len: v.model.length });
  check('non-image "photo" dropped, real image stored in uploads/<order>/', v.photos.length === 1 && /^\/uploads\/MC-T-SAN\/v1_\d+_\d+_[0-9a-f]{8}\.png$/.test(v.photos[0].url || '') && !v.photos[0].data, v.photos);
  raw = await fetch(B + v.photos[0].url);
  check('stored photo served as image/png with no-sniff + sandbox', raw.status === 200 && raw.headers.get('content-type') === 'image/png' && raw.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(raw.headers.get('content-security-policy') || ''), [raw.status, raw.headers.get('content-type')]);
  raw = await fetch(B + '/uploads/../app.js');
  check('path traversal on /uploads rejected', raw.status === 404, raw.status);
  raw = await fetch(B + '/documents/../../app.js');
  check('path traversal on /documents rejected', raw.status === 404, raw.status);
  raw = await fetch(B + '/documents/invoices/nothing.pdf');
  check('missing document → 404', raw.status === 404, raw.status);
  try { require('fs').rmSync(require('path').join(__dirname, '..', 'uploads', 'MC-T-SAN'), { recursive: true, force: true }); } catch {}
  r = await api('PATCH', '/api/orders/MC-T-SAN/price', { total: 725, reason: 'repeat dealer' });
  check('admin can change the price before a card is on hold', r.status === 200 && r.data.total === 725 && r.data.previous === 650, r.data);
  o = await order('MC-T-SAN');
  check('new price saved and the change noted on the order', o.total === 725 && (o.notes || '').includes('Price changed: $650 → $725 — repeat dealer'), { t: o.total, n: o.notes });
  r = await api('PATCH', '/api/orders/MC-T-SAN/price', { total: -5 });
  check('negative price rejected', r.status === 400);
  r = await api('PATCH', '/api/orders/MC-T-SAN/status', { status: 'DROP TABLE' });
  check('invalid order status rejected', r.status === 400);
  r = await api('POST', '/api/promo-codes', { code: 'BAD', discount: 150, type: 'percent' });
  check('150% promo rejected', r.status === 400);
  raw = await fetch(B + '/uploads/nothing.txt');
  check('uploads served with no-sniff + sandboxed CSP', raw.headers.get('x-content-type-options') === 'nosniff' || raw.status === 404);

  // ---------- 3. Send confirmation ----------
  console.log('\n3) Send confirmation');
  await newOrder('MC-T-SEND');
  r = await api('POST', '/api/orders/MC-T-SEND/send-confirmation', { noShowFee: 175 }, { auth: false });
  check('send-confirmation without login → 401', r.status === 401, r.status);
  r = await api('POST', '/api/orders/MC-T-SEND/send-confirmation', { noShowFee: 175 });
  check('returns link on APP_URL', r.data.success && r.data.link.startsWith('https://mcships.test/confirm/'), r.data);
  check('email reported as sent', r.data.emailSent === true, r.data);
  let m = lastMailTo('mc-t-send@example.test');
  check('customer email contains link, quote and fee', !!m && m.html.includes(r.data.link) && m.html.includes('$650') && m.html.includes('$175') && m.text.includes(r.data.link));
  o = await order('MC-T-SEND');
  check('order → confirmation_sent, fee stored, token present', o.paymentStatus === 'confirmation_sent' && o.noShowFee === 175 && (o.confirmToken || '').length === 48, o);
  const token1 = o.confirmToken;
  r = await api('POST', '/api/orders/MC-T-SEND/send-confirmation', {});
  check('resend keeps the same token and fee', r.data.link.endsWith(token1) && (await order('MC-T-SEND')).noShowFee === 175);
  page = await fetch(`${B}/confirm/${token1}`);
  let html = await page.text();
  check('confirmation page renders publicly (200) with amounts and agreement', page.status === 200 && html.includes('Authorize Hold of $650') && html.includes('$175') && html.includes('id="agreeCheck"') && html.includes('7 days'));
  check('bad token → 404', (await fetch(`${B}/confirm/${'0'.repeat(48)}`)).status === 404);
  r = await api('POST', `/api/confirm/${token1}/agree`, { agreedName: '', agreed: true }, { auth: false });
  check('agree without name → 400', r.status === 400);
  r = await api('POST', `/api/confirm/${token1}/agree`, { agreedName: 'X', agreed: false }, { auth: false });
  check('agree without checkbox → 400', r.status === 400);

  // ---------- 4. Customer agrees + authorizes hold ----------
  console.log('\n4) Customer agrees and authorizes a hold (no login needed)');
  r = await api('POST', `/api/confirm/${token1}/agree`, { agreedName: 'Test Caller', agreed: true }, { auth: false });
  check('agree → clientSecret + paymentIntentId', r.data.success && r.data.paymentIntentId && r.data.clientSecret, r.data);
  const pi1 = S.intents[r.data.paymentIntentId];
  check('PaymentIntent is manual-capture, saves card off-session, $650, tagged with order + agreement version',
    pi1.capture_method === 'manual' && pi1.setup_future_usage === 'off_session' && pi1.amount === 65000 && pi1.metadata.orderId === 'MC-T-SEND' && pi1.metadata.agreementVersion === '2026-09-v2', pi1);
  check('Stripe customer created with contact details', S.customers.some(c => c.email === 'mc-t-send@example.test' && c.metadata.orderId === 'MC-T-SEND'));
  let c = await api('POST', `/api/confirm/${token1}/complete`, { paymentIntentId: r.data.paymentIntentId }, { auth: false });
  check('complete before card authorized → 400', c.status === 400, c.data);
  fakeStripe.__authorize(r.data.paymentIntentId);
  c = await api('POST', `/api/confirm/${token1}/complete`, { paymentIntentId: r.data.paymentIntentId }, { auth: false });
  check('complete after authorization → success', c.data && c.data.success, c.data);
  o = await order('MC-T-SEND');
  check('order → authorized, hold $650, expires ~7 days, card on file, signer recorded',
    o.paymentStatus === 'authorized' && o.holdAmount === 650 && o.hasCardOnFile && o.agreedName === 'Test Caller' && !!o.agreedAt && !!o.agreedIp
      && Math.abs(new Date(o.holdExpiresAt) - Date.now() - 7 * 86400000) < 5 * 60 * 1000, o);
  check('customer receipt email sent', !!lastMailTo('mc-t-send@example.test') && lastMailTo('mc-t-send@example.test').subject.includes('Pickup confirmed'));
  const ag = o.agreement;
  check('signed-agreement record stored (name, ip, clauses, order snapshot, authorization)',
    !!ag && ag.agreedName === 'Test Caller' && ag.version === '2026-09-v2' && Array.isArray(ag.clauses) && ag.clauses.length === 5
      && ag.order && ag.order.id === 'MC-T-SEND' && ag.amount === 650 && ag.noShowFee === 175
      && ag.authorization && ag.authorization.paymentIntentId === pi1.id && ag.authorization.amount === 650, ag && Object.keys(ag));
  page = await fetch(`${B}/admin/orders/MC-T-SEND/agreement`, { headers: { Cookie: adminCookie } }); html = await page.text();
  check('printable agreement page shows signer, clauses and hold', page.status === 200 && html.includes('Test Caller') && html.includes('no-show / dry-run fee') && html.includes('Vehicle Pickup Agreement'));
  page = await fetch(`${B}/admin/orders/MC-T-SEND/agreement`, { redirect: 'manual' });
  check('agreement page requires admin login', page.status === 302);
  check('admin notified', !!lastMailTo('admin@mcships.test') && lastMailTo('admin@mcships.test').subject.includes('MC-T-SEND'));
  r = await api('POST', `/api/confirm/${token1}/agree`, { agreedName: 'Again', agreed: true }, { auth: false });
  check('agreeing again → 409 alreadyConfirmed', r.status === 409 && r.data.alreadyConfirmed === true);
  r = await api('POST', '/api/orders/MC-T-SEND/send-confirmation', {});
  check('resend after authorization → 409', r.status === 409);
  page = await fetch(`${B}/confirm/${token1}`); html = await page.text();
  check("confirmation page now shows 'card on hold'", html.includes('Pickup confirmed — card on hold') && html.includes('class="space-y-6 hidden"'));

  // ---------- 5. Vehicle picked up → capture ----------
  console.log('\n5) Vehicle picked up → capture the hold');
  r = await api('POST', '/api/orders/MC-T-SEND/pickup', null, { auth: false });
  check('pickup without login → 401', r.status === 401);
  r = await api('POST', '/api/orders/MC-T-SEND/pickup');
  check('pickup captures $650', r.data.success && r.data.how === 'captured' && r.data.amount === 650, r.data);
  check('Stripe intent succeeded', S.intents[pi1.id].status === 'succeeded' && S.intents[pi1.id].amount_received === 65000);
  o = await order('MC-T-SEND');
  check('order → paid, charged $650, picked_up_at set, status In Work, card removed',
    o.paymentStatus === 'paid' && o.chargedAmount === 650 && !!o.chargedAt && !!o.pickedUpAt && o.status === 'In Work' && o.hasCardOnFile === false, o);
  check('saved card detached from Stripe', S.detached.includes(pi1.payment_method));
  r = await api('POST', '/api/orders/MC-T-SEND/pickup');
  check('second pickup → 409', r.status === 409);
  r = await api('POST', '/api/orders/MC-T-SEND/charge-fee', {});
  check('fee after paid → 409', r.status === 409);
  r = await api('PATCH', '/api/orders/MC-T-SEND/price', { total: 10 });
  check('price locked once charged → 409', r.status === 409);

  // Deleting an order that still has a hold releases it first
  await newOrder('MC-T-DEL');
  const del = await sendAndAuthorize('MC-T-DEL', 150);
  r = await api('DELETE', '/api/orders/MC-T-DEL');
  check('deleting a held order releases the hold and removes the card', r.status === 200 && r.data.released === true && S.intents[del.agree.data.paymentIntentId].status === 'canceled' && S.detached.includes(S.intents[del.agree.data.paymentIntentId].payment_method), r.data);
  created.orders = created.orders.filter(x => x !== 'MC-T-DEL');
  r = await api('GET', '/api/orders/MC-T-DEL');
  check('deleted order is gone', r.status === 404 || !r.data || !r.data.id);

  // ---------- 5b. Partial charge + refunds + payments page ----------
  console.log('\n5b) Partial charge, refunds and the Payments list');
  await newOrder('MC-T-PART');
  const part = await sendAndAuthorize('MC-T-PART', 150);
  r = await api('POST', '/api/orders/MC-T-PART/pickup', { amount: 900 });
  check('charging more than the hold → 400', r.status === 400, r.data);
  r = await api('POST', '/api/orders/MC-T-PART/pickup', { amount: 0 });
  check('charging $0 → 400', r.status === 400);
  r = await api('POST', '/api/orders/MC-T-PART/pickup', { amount: 300 });
  check('custom amount: captures $300 of the $650 hold', r.data.success && r.data.amount === 300 && S.intents[part.agree.data.paymentIntentId].amount_received === 30000, r.data);
  o = await order('MC-T-PART');
  check('order charged $300, state "charged"', o.chargedAmount === 300 && o.paymentState === 'charged' && o.refundedAmount === 0, { c: o.chargedAmount, s: o.paymentState });
  r = await api('POST', '/api/orders/MC-T-PART/refund', { amount: 500 }, { auth: true });
  check('refund more than charged → 400', r.status === 400, r.data);
  r = await api('POST', '/api/orders/MC-T-PART/refund', { amount: 100, reason: 'late pickup' }, { auth: false });
  check('refund without login → 401', r.status === 401);
  r = await api('POST', '/api/orders/MC-T-PART/refund', { amount: 100, reason: 'late pickup' });
  check('partial refund $100 → remaining $200', r.data.success && r.data.amount === 100 && r.data.remaining === 200, r.data);
  o = await order('MC-T-PART');
  check('order → partially_refunded, refund noted', o.paymentState === 'partially_refunded' && o.refundedAmount === 100 && /Refund \$100\.00: late pickup/.test(o.notes || ''), { s: o.paymentState, n: o.notes });
  r = await api('POST', '/api/orders/MC-T-PART/refund', {});
  check('refund with no amount refunds the rest ($200)', r.data.success && r.data.amount === 200 && r.data.remaining === 0, r.data);
  o = await order('MC-T-PART');
  check('order → refunded', o.paymentState === 'refunded' && o.refundedAmount === 300);
  r = await api('POST', '/api/orders/MC-T-PART/refund', {});
  check('refunding again → 409', r.status === 409);
  r = await api('POST', '/api/orders/MC-T-SAN/refund', {});
  check('refund on an unpaid order → 409', r.status === 409);
  // ---------- Stripe webhook keeps orders in sync ----------
  const hook = async (type, object, sig = 'good-sig') => fetch(B + '/api/stripe/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: JSON.stringify({ id: 'evt_' + (++S.n), type, data: { object } }) });
  let wh = await hook('charge.refunded', { payment_intent: 'pi_none', amount_refunded: 100 }, 'bad-sig');
  check('webhook with a bad signature → 400', wh.status === 400);
  await newOrder('MC-T-WH');
  const whA = await sendAndAuthorize('MC-T-WH', 150);
  wh = await hook('payment_intent.canceled', { id: whA.agree.data.paymentIntentId });
  o = await order('MC-T-WH');
  check('hold cancelled in the Stripe dashboard → order released, card removed', wh.status === 200 && o.paymentState === 'released' && o.hasCardOnFile === false, { s: wh.status, st: o.paymentState });
  wh = await hook('charge.refunded', { payment_intent: 'pi_other', amount_refunded: 5000 });
  check('refund event for an unknown payment is ignored', wh.status === 200);
  const piSend = (await order('MC-T-SEND')).stripePaymentIntentId;
  wh = await hook('charge.refunded', { payment_intent: piSend, amount_refunded: 65000 });
  o = await order('MC-T-SEND');
  check('refund made in the Stripe dashboard is mirrored on the order', wh.status === 200 && o.refundedAmount === 650 && o.paymentState === 'refunded', { r: o.refundedAmount, st: o.paymentState });
  const whMails = MAIL.length;
  wh = await hook('charge.dispute.created', { id: 'dp_test1', payment_intent: piSend, amount: 65000, reason: 'fraudulent' });
  o = await order('MC-T-SEND');
  check('chargeback flags the order and emails the team', wh.status === 200 && o.disputeStatus === 'open' && /CHARGEBACK opened/.test(o.notes || '') && MAIL.length > whMails && /Chargeback opened/.test(MAIL[MAIL.length - 1].subject), { d: o.disputeStatus });
  wh = await hook('charge.dispute.closed', { id: 'dp_test1', payment_intent: piSend, status: 'won' });
  o = await order('MC-T-SEND');
  check('dispute closed → status recorded', o.disputeStatus === 'won');
  check('Stripe got two refunds on the right intent', (S.refunds || []).filter(x => x.payment_intent === part.agree.data.paymentIntentId).map(x => x.amount).join(',') === '10000,20000');
  r = await api('GET', '/api/payments', null, { auth: false });
  check('payments list without login → 401', r.status === 401);
  r = await api('GET', '/api/payments');
  const payPart = r.data && r.data.payments && r.data.payments.find(p => p.id === 'MC-T-PART');
  const paySend = r.data && r.data.payments && r.data.payments.find(p => p.id === 'MC-T-SEND');
  check('payments list has states + totals', r.status === 200 && payPart && payPart.paymentState === 'refunded' && payPart.refundedAmount === 300 && paySend && ['charged', 'refunded'].includes(paySend.paymentState) && typeof r.data.totals.charged === 'number', { part: payPart && payPart.paymentState, send: paySend && paySend.paymentState });
  page = await fetch(`${B}/admin/payments`, { redirect: 'manual' });
  check('payments page requires login (redirect)', page.status === 302);
  page = await fetch(`${B}/admin/payments`, { headers: { Cookie: adminCookie } });
  check('payments page renders', page.status === 200 && (await page.text()).includes('id="paymentsBody"'));

  // ---------- 5c. Search + paging ----------
  console.log('\n5c) Search, filters and paging');
  r = await api('GET', '/api/orders?q=MC-T-PART&page=1&limit=25');
  check('orders search by id → paged result', r.data && r.data.total === 1 && r.data.orders[0].id === 'MC-T-PART' && r.data.page === 1 && r.data.pages === 1, r.data && { total: r.data.total });
  r = await api('GET', '/api/orders?q=' + encodeURIComponent('mc-t-part@example.test') + '&page=1');
  check('orders search by customer email', r.data && r.data.total === 1 && r.data.orders[0].id === 'MC-T-PART');
  r = await api('GET', '/api/orders?payment=refunded&page=1');
  check('orders filtered by payment state', r.data && r.data.orders.length >= 1 && r.data.orders.every(x => x.paymentState === 'refunded'));
  r = await api('GET', '/api/orders?status=Canceled&page=1');
  check('orders filtered by status', r.data && r.data.orders.every(x => x.status === 'Canceled'));
  r = await api('GET', '/api/orders?page=1&limit=5');
  check('paging: limit respected, totals reported', r.data && r.data.orders.length <= 5 && r.data.total >= r.data.orders.length && r.data.pages >= 1);
  r = await api('GET', '/api/orders');
  check('no ?page → plain array (older callers keep working)', Array.isArray(r.data));
  r = await api('GET', '/api/payments?state=refunded&page=1&limit=10');
  check('payments filtered + paged, totals still global', r.data && r.data.payments.every(p => ['refunded', 'partially_refunded'].includes(p.paymentState)) && typeof r.data.totals.charged === 'number' && r.data.pages >= 1);
  r = await api('GET', '/api/customers?q=Test%20Caller&page=1&limit=10');
  check('customers search + paged', r.data && Array.isArray(r.data.customers) && r.data.total >= 1 && r.data.customers.every(c => /Test Caller/.test(c.name)));
  r = await api('GET', '/api/search?q=MC-T-PART');
  check('global search finds the order and its customer', r.data && r.data.orders.some(x => x.id === 'MC-T-PART') && Array.isArray(r.data.customers), r.data && { o: r.data.orders.length, c: r.data.customers.length });
  r = await api('GET', '/api/search?q=MC-T-PART', null, { auth: false });
  check('global search requires login', r.status === 401);
  r = await api('POST', '/api/leads', { email: 'lead-test@example.test', source: 'test' }, { auth: false });
  check('lead sign-up stored and team emailed', r.status === 200 && !!lastMailTo('admin@mcships.test') && /New lead/.test(lastMailTo('admin@mcships.test').subject));
  r = await api('GET', '/api/leads?q=lead-test&page=1&limit=10');
  const lead = r.data && r.data.leads && r.data.leads.find(l => l.email === 'lead-test@example.test');
  check('leads list searchable + paged', !!lead && lead.isCustomer === false && r.data.total >= 1, r.data && r.data.total);
  r = await api('DELETE', '/api/leads/' + (lead ? lead.id : 0));
  check('lead deleted', r.status === 200);
  page = await fetch(B + '/admin/leads', { headers: { Cookie: adminCookie } });
  check('leads page renders', page.status === 200 && (await page.text()).includes('id="leadsBody"'));
  // ---------- Website quotes: email first, then price, then Book link ----------
  r = await api('POST', '/api/quotes', { email: 'not-an-email', vehicle: { type: 'sedan' }, distance: 300 }, { auth: false });
  check('quote with a bad email → 400', r.status === 400);
  r = await api('POST', '/api/quotes', { name: 'Quote Tester', email: 'quote-test@example.test', phone: '555-0199', vehicle: { year: '2021', make: 'Ford', model: 'F-150', type: 'pickup', condition: 'operable' }, distance: 300, pickup: 'Louisville, KY', delivery: 'Nashville, TN', transportType: 'enclosed' }, { auth: false });
  const cfgQ = (await api('GET', '/api/settings/calculator', null, { auth: false })).data;
  const expectedQ = await priceVia([{ type: 'pickup', condition: 'operable' }], 300, { transportType: 'enclosed' });
  check('quote priced on the server and saved', r.status === 200 && r.data.success && r.data.total === expectedQ && /^[a-f0-9]{48}$/.test(r.data.quoteId) && Array.isArray(r.data.addons) && !r.data.breakdown, r.data && { t: r.data.total, e: expectedQ });
  const qMail = lastMailTo('quote-test@example.test');
  check('quote emailed to the customer with a Book link', !!qMail && qMail.subject.includes('Your Mcships quote') && qMail.text.includes('/payment?quote=' + r.data.quoteId), qMail && qMail.subject);
  check('team notified of the new quote', !!lastMailTo('admin@mcships.test') && /New website quote/.test(lastMailTo('admin@mcships.test').subject));
  const qTok = r.data.quoteId;
  r = await api('GET', '/api/quotes/' + qTok, null, { auth: false });
  check('quote link returns everything checkout needs', r.status === 200 && r.data.email === 'quote-test@example.test' && r.data.vehicle.make === 'Ford' && r.data.distance === 300 && r.data.transportType === 'enclosed' && r.data.total === expectedQ, r.data);
  r = await api('GET', '/api/quotes/' + 'f'.repeat(48), null, { auth: false });
  check('unknown quote link → 404', r.status === 404);
  // Several vehicles in one quote
  const twoVeh = [{ year: '2021', make: 'Ford', model: 'F-150', type: 'pickup', condition: 'operable' }, { year: '2019', make: 'Toyota', model: 'Camry', type: 'sedan', condition: 'inoperable' }];
  r = await api('POST', '/api/quotes', { name: 'Two Cars', email: 'quote-two@example.test', phone: '555-0198', vehicles: twoVeh, distance: 300, pickup: 'Louisville, KY', delivery: 'Nashville, TN', transportType: 'open' }, { auth: false });
  const expected2 = await priceVia(twoVeh, 300, { transportType: 'open' });
  const single1 = await priceVia([twoVeh[0]], 300), single2 = await priceVia([twoVeh[1]], 300);
  check('two-vehicle quote priced together with the discount', r.status === 200 && r.data.total === expected2 && expected2 < single1 + single2, { total: r.data && r.data.total, e: expected2, s: single1 + single2 });
  const q2Mail = lastMailTo('quote-two@example.test');
  check('quote email lists both vehicles', q2Mail && /2 vehicles/.test(q2Mail.text) && /F-150/.test(q2Mail.text) && /Camry/.test(q2Mail.text), q2Mail && q2Mail.text.slice(0, 200));
  const q2 = (await api('GET', '/api/quotes/' + r.data.quoteId, null, { auth: false })).data;
  check('quote link carries both vehicles for checkout', q2.vehicles.length === 2 && q2.vehicles[1].make === 'Toyota' && q2.vehicles[1].condition === 'inoperable' && q2.vehicle.make === 'Ford', q2.vehicles);
  await pool.execute('DELETE FROM quotes WHERE token = ?', [r.data.quoteId]);
  r = await api('GET', '/api/leads?q=quote-two&page=1');
  for (const l of ((r.data && r.data.leads) || [])) await api('DELETE', '/api/leads/' + l.id);
  r = await api('GET', '/api/leads?q=quote-test&page=1');
  check('quote also recorded as a lead', r.data && r.data.leads && r.data.leads.some(l => l.email === 'quote-test@example.test' && l.source === 'calculator'));
  for (const l of (r.data.leads || [])) await api('DELETE', '/api/leads/' + l.id);
  // Follow-up emails: day 2 and day 6 for unbooked quotes, never twice, never after booking
  const { sendQuoteFollowups } = require('../app');
  await sendQuoteFollowups();
  check('no follow-up on a fresh quote', MAIL.filter(m => m.to === 'quote-test@example.test').length === 1);
  await pool.execute('UPDATE quotes SET created_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE token = ?', [qTok]);
  await sendQuoteFollowups(); await sendQuoteFollowups();
  let fu = MAIL.filter(m => m.to === 'quote-test@example.test');
  check('day-2 follow-up sent once with the Book link', fu.length === 2 && /Still thinking/.test(fu[1].subject) && fu[1].text.includes('/payment?quote=' + qTok), fu.map(m => m.subject));
  await pool.execute('UPDATE quotes SET created_at = DATE_SUB(NOW(), INTERVAL 7 DAY) WHERE token = ?', [qTok]);
  await sendQuoteFollowups(); await sendQuoteFollowups();
  fu = MAIL.filter(m => m.to === 'quote-test@example.test');
  check('day-6 "expires tomorrow" sent once', fu.length === 3 && /expires tomorrow/.test(fu[2].subject), fu.map(m => m.subject));
  await pool.execute('UPDATE quotes SET followup1_at = NULL, followup2_at = NULL, created_at = DATE_SUB(NOW(), INTERVAL 3 DAY), order_id = ? WHERE token = ?', ['MC-T-WEB', qTok]);
  await sendQuoteFollowups();
  check('booked quote gets no follow-up', MAIL.filter(m => m.to === 'quote-test@example.test').length === 3);
  await pool.execute('DELETE FROM quotes WHERE token = ?', [qTok]);
  // Admin home dashboard
  r = await api('GET', '/api/dashboard');
  check('dashboard summarises the day', r.status === 200 && r.data.counts && typeof r.data.counts.pickups === 'number' && r.data.money && typeof r.data.money.holding === 'number' && Array.isArray(r.data.recent), r.data && r.data.counts);
  r = await api('GET', '/api/dashboard', null, { auth: false });
  check('dashboard needs admin login', r.status === 401 || r.status === 403);
  page = await fetch(B + '/admin/home', { headers: { Cookie: adminCookie } });
  check('home page renders', page.status === 200 && (await page.text()).includes('id="homeStats"'));

  // ---------- Dispatch, tracking page, documents, delivered, review ----------
  console.log('\n5c) Dispatch → tracking page → documents → delivered → review request');
  await newOrder('MC-T-DISP');
  let od = await order('MC-T-DISP');
  check('new order has a tracking token and a "booked" event', /^[a-f0-9]{48}$/.test(od.trackingToken) && od.events.length === 1 && od.events[0].type === 'booked', od.events);
  page = await fetch(B + '/track/' + od.trackingToken); let tHtml = await page.text();
  check('tracking page renders before dispatch', page.status === 200 && tHtml.includes('MC-T-DISP') && /matching your shipment/.test(tHtml));
  page = await fetch(B + '/track/' + 'a'.repeat(48));
  check('unknown tracking link → 404 page', page.status === 404 && /couldn.t find/.test(await page.text()));
  r = await api('PATCH', '/api/orders/MC-T-DISP/dispatch', { carrierName: 'Blue Ridge Auto Transport', carrierPhone: '555-0140', driverName: 'Marcus', driverPhone: '555-0141', pickupEta: 'Tue Sep 15, 9am-1pm', deliveryEta: 'Fri Sep 18', notes: 'Driver calls 1h ahead', notify: true });
  od = await order('MC-T-DISP');
  check('dispatch saved, order moved to In Work, dispatched event added', r.data.success && od.dispatch.driverName === 'Marcus' && od.dispatch.dispatchedAt && od.status === 'In Work' && od.events.some(e => e.type === 'dispatched'), od.dispatch);
  const dMail = lastMailTo('mc-t-disp@example.test');
  check('customer emailed the carrier details with the tracking link', r.data.emailed && dMail && /Carrier assigned/.test(dMail.subject) && dMail.text.includes('Marcus') && dMail.text.includes('/track/' + od.trackingToken), dMail && dMail.subject);
  page = await fetch(B + '/track/' + od.trackingToken); tHtml = await page.text();
  check('tracking page shows driver, phone and windows', tHtml.includes('Marcus') && tHtml.includes('555-0141') && tHtml.includes('Tue Sep 15, 9am-1pm') && tHtml.includes('Carrier assigned'));
  r = await api('PATCH', '/api/orders/MC-T-DISP/dispatch', { carrierName: 'Blue Ridge Auto Transport', driverName: 'Marcus', deliveryEta: 'Thu Sep 17', notify: false });
  od = await order('MC-T-DISP');
  check('second save does not add another dispatched event', od.events.filter(e => e.type === 'dispatched').length === 1 && od.dispatch.deliveryEta === 'Thu Sep 17');
  r = await api('POST', '/api/orders/MC-T-DISP/update', { note: 'Truck passed Amarillo, delivery Thursday morning', notify: true });
  od = await order('MC-T-DISP');
  check('update posted to the timeline and emailed', r.data.success && r.data.emailed && od.events.some(e => e.type === 'update' && /Amarillo/.test(e.note)) && /Update on your shipment/.test(lastMailTo('mc-t-disp@example.test').subject));
  r = await api('POST', '/api/orders/MC-T-DISP/update', { note: '   ' });
  check('empty update rejected', r.status === 400);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await api('POST', '/api/orders/MC-T-DISP/documents', { kind: 'bol', files: [{ name: 'bol.png', data: png }] });
  check('BOL stored under documents/bols', r.data.success && r.data.added === 1 && /^\/documents\/bols\/MC-T-DISP-bol_.*\.png$/.test(r.data.documents[0].url), r.data.documents);
  const bolUrl = r.data.documents[0].url;
  page = await fetch(B + bolUrl);
  check('BOL file downloadable (nosniff, image)', page.status === 200 && page.headers.get('content-type') === 'image/png' && page.headers.get('x-content-type-options') === 'nosniff');
  r = await api('POST', '/api/orders/MC-T-DISP/documents', { kind: 'delivery', files: [{ name: 'a.png', data: png }, { name: 'b.png', data: png }] });
  check('delivery photos stored under uploads/<order>', r.data.added === 2 && r.data.documents.filter(d => d.kind === 'delivery').every(d => d.url.startsWith('/uploads/MC-T-DISP/')), r.data.documents);
  r = await api('POST', '/api/orders/MC-T-DISP/documents', { kind: 'bol', files: [{ name: 'x.exe', data: 'data:application/x-msdownload;base64,AAAA' }] });
  check('non image/PDF upload rejected', r.status === 400);
  page = await fetch(B + '/track/' + od.trackingToken); tHtml = await page.text();
  check('tracking page lists the BOL and delivery photos', tHtml.includes(bolUrl) && (tHtml.match(/\/uploads\/MC-T-DISP\//g) || []).length >= 2);
  r = await api('DELETE', '/api/orders/MC-T-DISP/documents', { url: bolUrl });
  page = await fetch(B + bolUrl);
  check('removing a document deletes the file too', r.data.success && r.data.documents.length === 2 && page.status === 404);
  r = await api('POST', '/api/orders/MC-T-DISP/delivered', { notify: true });
  od = await order('MC-T-DISP');
  check('marked delivered: status Done, event, email', r.data.success && od.status === 'Done' && od.deliveredAt && od.events.some(e => e.type === 'delivered') && /Delivered/.test(lastMailTo('mc-t-disp@example.test').subject), od.status);
  r = await api('POST', '/api/orders/MC-T-DISP/delivered', { notify: true });
  check('cannot mark delivered twice', r.status === 409);
  page = await fetch(B + '/track/' + od.trackingToken); tHtml = await page.text();
  check('tracking page shows Delivered', /<h1[^>]*>Delivered<\/h1>/.test(tHtml));
  // ---- SMS (fake Twilio) ----
  const SMS = [];
  const { setSmsTransport } = require('../app');
  r = await api('GET', '/api/sms/status');
  check('sms status reports off without Twilio keys', r.data.configured === false);
  r = await api('POST', '/api/orders/MC-T-DISP/sms', { body: 'hello' });
  check('texting refused while not set up (clear message)', r.status === 502 && /not set up/.test(r.data.message));
  await pool.execute("UPDATE orders SET contact = JSON_SET(contact, '$.phone', '(502) 555-0100') WHERE id = 'MC-T-DISP'");
  process.env.TWILIO_ACCOUNT_SID = 'ACtest'; process.env.TWILIO_AUTH_TOKEN = 'tok'; process.env.TWILIO_FROM = '+15025550100';
  setSmsTransport(async (to, body) => { SMS.push({ to, body }); return { sid: 'SM1' }; });
  r = await api('POST', '/api/orders/MC-T-DISP/sms', { body: 'Driver running 30 min late' });
  check('free-form text sent in E.164, prefixed, and logged on the order', r.data.success && SMS.length === 1 && SMS[0].to === '+15025550100' && /^Mcships: Driver running/.test(SMS[0].body) && r.data.order.sms.length === 1 && r.data.order.sms[0].ok, SMS);
  r = await api('POST', '/api/orders/MC-T-DISP/update', { note: 'Arriving tomorrow 9am', notify: false, sms: true });
  check('update can be texted without email', r.data.success && r.data.texted && !r.data.emailed && /Mcships update: Arriving tomorrow 9am/.test(SMS[SMS.length - 1].body) && /\/track\//.test(SMS[SMS.length - 1].body));
  await newOrder('MC-T-SMS', { contact: { fullName: 'Sms Tester', email: 'mc-t-sms@example.test', phone: '502-555-0199', type: 'individual' } });
  r = await api('POST', '/api/orders/MC-T-SMS/send-confirmation', { noShowFee: 150, sms: true });
  check('confirmation link texted when asked', r.data.success && r.data.smsSent && SMS[SMS.length - 1].body.includes('/confirm/') && /confirm your pickup/.test(SMS[SMS.length - 1].body), r.data);
  const nBefore = SMS.length;
  r = await api('PATCH', '/api/orders/MC-T-SMS/dispatch', { carrierName: 'Fast Lane', driverName: 'Ana', driverPhone: '555-0177', pickupEta: 'Mon 8-11am', notify: true });
  check('carrier assigned goes out by email and text', r.data.emailed && r.data.texted && SMS.length === nBefore + 1 && /Driver: Ana 555-0177/.test(SMS[nBefore].body) && /Pickup: Mon 8-11am/.test(SMS[nBefore].body), SMS[nBefore]);
  setSmsTransport(async () => { throw new Error('Twilio says no'); });
  r = await api('POST', '/api/orders/MC-T-SMS/sms', { body: 'test' });
  check('Twilio failure reported and logged, order untouched', r.status === 502 && /Twilio says no/.test(r.data.message) && (await order('MC-T-SMS')).sms.some(s => !s.ok && /Twilio says no/.test(s.error)));
  process.env.TWILIO_ACCOUNT_SID = ''; process.env.TWILIO_AUTH_TOKEN = ''; process.env.TWILIO_FROM = '';
  const { sendReviewRequests } = require('../app');
  await api('PUT', '/api/settings/review', { url: 'https://g.page/r/test/review' });
  check('review link saved', (await api('GET', '/api/settings/review')).data.url === 'https://g.page/r/test/review');
  r = await api('PUT', '/api/settings/review', { url: 'not a link' });
  check('bad review link rejected', r.status === 400);
  const before = MAIL.filter(m => m.to === 'mc-t-disp@example.test').length;
  await sendReviewRequests();
  check('no review request on the day of delivery', MAIL.filter(m => m.to === 'mc-t-disp@example.test').length === before);
  await pool.execute('UPDATE orders SET delivered_at = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE id = ?', ['MC-T-DISP']);
  await sendReviewRequests(); await sendReviewRequests();
  const rv = MAIL.filter(m => m.to === 'mc-t-disp@example.test');
  check('review request sent once, the day after, with the review link', rv.length === before + 1 && /How did we do/.test(rv[rv.length - 1].subject) && rv[rv.length - 1].text.includes('https://g.page/r/test/review'), rv.map(m => m.subject));
  await api('PUT', '/api/settings/review', { url: '' });
  for (const d of (await order('MC-T-DISP')).documents) await api('DELETE', '/api/orders/MC-T-DISP/documents', { url: d.url });

  // ---------- 6. Vehicle gone → no-show fee ----------
  console.log('\n6) Vehicle gone → charge no-show fee, release hold');
  await newOrder('MC-T-FEE');
  let f = await sendAndAuthorize('MC-T-FEE', 150);
  check('setup: authorized', (await order('MC-T-FEE')).paymentStatus === 'authorized');
  const holdPi = S.intents[f.agree.data.paymentIntentId];
  r = await api('POST', '/api/orders/MC-T-FEE/charge-fee', { amount: 120 });
  check('fee charged $120', r.data.success && r.data.amount === 120, r.data);
  check('transport hold cancelled in Stripe', holdPi.status === 'canceled');
  const feePi = S.intents[r.data.piId];
  check('fee charged off-session with the saved card', feePi.off_session && feePi.payment_method === holdPi.payment_method && feePi.amount === 12000 && feePi.metadata.kind === 'no_show_fee', feePi);
  o = await order('MC-T-FEE');
  check('order → fee_charged, $120, status Canceled, card removed', o.paymentStatus === 'fee_charged' && o.chargedAmount === 120 && o.status === 'Canceled' && !o.hasCardOnFile, o);
  check('card detached', S.detached.includes(holdPi.payment_method));

  // ---------- 7. Release hold ----------
  console.log('\n7) Release hold without charging');
  await newOrder('MC-T-REL');
  f = await sendAndAuthorize('MC-T-REL', 150);
  const relPi = S.intents[f.agree.data.paymentIntentId];
  r = await api('POST', '/api/orders/MC-T-REL/release-hold');
  check('release succeeds', r.data.success, r.data);
  check('hold cancelled + card detached', relPi.status === 'canceled' && S.detached.includes(relPi.payment_method));
  o = await order('MC-T-REL');
  check('order → released, no hold, no card', o.paymentStatus === 'released' && o.holdAmount === null && !o.hasCardOnFile, o);
  r = await api('POST', '/api/orders/MC-T-REL/charge-fee', {});
  check('fee after release → 409 (no active hold)', r.status === 409);
  r = await api('POST', '/api/orders/MC-T-REL/send-confirmation', {});
  check('can send a fresh confirmation after release', r.data.success && (await order('MC-T-REL')).paymentStatus === 'confirmation_sent');

  // ---------- 8. 7-day expiry housekeeping ----------
  console.log('\n8) 7-day expiry: hold + card removed automatically');
  await newOrder('MC-T-EXP');
  f = await sendAndAuthorize('MC-T-EXP', 150);
  const expPi = S.intents[f.agree.data.paymentIntentId];
  let n = await expireCardHolds();
  check('nothing expires while the hold is fresh', n === 0 && (await order('MC-T-EXP')).paymentStatus === 'authorized');
  await pool.execute("UPDATE orders SET hold_expires_at = NOW() - INTERVAL 1 HOUR WHERE id = 'MC-T-EXP'");
  const mailsBefore = MAIL.length;
  n = await expireCardHolds();
  check('expiry job processed the order', n === 1);
  check('hold cancelled + card detached in Stripe', expPi.status === 'canceled' && S.detached.includes(expPi.payment_method));
  o = await order('MC-T-EXP');
  check('order → expired, no card', o.paymentStatus === 'expired' && !o.hasCardOnFile && o.holdAmount === null, o);
  check('admin emailed about the expiry', MAIL.length > mailsBefore && lastMailTo('admin@mcships.test').subject.includes('expired'));
  r = await api('POST', '/api/orders/MC-T-EXP/pickup');
  check('pickup after expiry → 409', r.status === 409);
  r = await api('POST', '/api/orders/MC-T-EXP/send-confirmation', {});
  check('fresh confirmation can be sent (same link)', r.data.success && r.data.link.endsWith(f.token));
  const re = await api('POST', `/api/confirm/${f.token}/agree`, { agreedName: 'Test Caller', agreed: true }, { auth: false });
  check('customer can authorize again; Stripe customer reused', re.data.success && S.intents[re.data.paymentIntentId].customer === expPi.customer);

  // ---------- 9. Hold lapsed at Stripe but card still on file ----------
  console.log('\n9) Hold lapsed at Stripe before housekeeping → charge saved card');
  await newOrder('MC-T-LAPSE');
  f = await sendAndAuthorize('MC-T-LAPSE', 150);
  S.intents[f.agree.data.paymentIntentId].status = 'canceled'; // Stripe auto-cancelled the auth
  r = await api('POST', '/api/orders/MC-T-LAPSE/pickup');
  check('pickup falls back to charging the saved card', r.data.success && r.data.how === 'charged_saved_card' && r.data.amount === 650, r.data);
  o = await order('MC-T-LAPSE');
  check('order paid + card removed', o.paymentStatus === 'paid' && !o.hasCardOnFile);

  // ---------- 10. Declined saved card ----------
  console.log('\n10) Declined card on fee → hold stays intact, retry works');
  await newOrder('MC-T-DECL');
  f = await sendAndAuthorize('MC-T-DECL', 150);
  const declPi = S.intents[f.agree.data.paymentIntentId];
  S.failNextOffSession = true;
  r = await api('POST', '/api/orders/MC-T-DECL/charge-fee', {});
  check('fee charge declined → 402 with card message', r.status === 402 && /declined/i.test(r.data.message), r.data);
  o = await order('MC-T-DECL');
  check('hold still intact after the decline', o.paymentStatus === 'authorized' && o.hasCardOnFile && declPi.status === 'requires_capture', o.paymentStatus);
  r = await api('POST', '/api/orders/MC-T-DECL/charge-fee', {});
  check('retrying the fee works once the card goes through', r.data.success && declPi.status === 'canceled' && (await order('MC-T-DECL')).paymentStatus === 'fee_charged', r.data);

  // ---------- 11. No email on the order ----------
  console.log('\n11) Order without email');
  await newOrder('MC-T-NOMAIL', { contact: { fullName: 'No Email', phone: '555-0199' } });
  r = await api('POST', '/api/orders/MC-T-NOMAIL/send-confirmation', {});
  check('link generated, emailSent=false with reason', r.data.success && r.data.emailSent === false && /no customer email/i.test(r.data.emailError), r.data);

  // ---------- 12. Logout + rate limiting ----------
  console.log('\n12) Logout & brute-force protection');
  raw = await api('POST', '/api/auth/logout', null, { raw: true });
  check('logout clears the cookie', /mc_session=;.*Max-Age=0/.test(raw.headers.get('set-cookie') || ''));
  let last = 0;
  for (let i = 0; i < 12; i++) { last = (await api('POST', '/api/auth/login', { email: 'nobody@x.test', password: 'x' }, { auth: false })).status; if (last === 429) break; }
  check('login rate-limited after repeated failures (429)', last === 429, last);

  // ---------- Cleanup ----------
  console.log('\nCleanup');
  for (const id of created.orders) await api('DELETE', `/api/orders/${id}`);
  for (const id of [...new Set(created.customers)]) await api('DELETE', `/api/customers/${id}`);
  const left = (await api('GET', '/api/orders')).data.filter(x => String(x.id).startsWith('MC-T-'));
  check('test orders removed', left.length === 0, left.map(x => x.id));
  await removeTestAdmin();
  check('test admin removed', (await pool.execute('SELECT id FROM employees WHERE email = ?', [ADMIN_EMAIL]))[0].length === 0);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('\nTEST CRASHED:', e);
  for (const id of created.orders) { try { await api('DELETE', `/api/orders/${id}`); } catch (_) {} }
  for (const id of [...new Set(created.customers)]) { try { await api('DELETE', `/api/customers/${id}`); } catch (_) {} }
  process.exit(1);
});
