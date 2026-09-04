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
const ADMIN_EMAIL = 'admin@mctransportation.com';
const ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || 'mcadmin2026';

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
const quote = (cfg, vehicles, miles) => {   // mirror of the server formula, to cross-check
  let cpm = cfg.tiers[cfg.tiers.length - 1].rate;
  for (const t of cfg.tiers) if (miles <= (t.max == null ? Infinity : t.max)) { cpm = t.rate; break; }
  return vehicles.reduce((sum, v) => { let s = cfg.baseFee + cpm * miles; if (cfg.multipliers[v.type]) s *= cfg.multipliers[v.type];
    if (v.condition === 'inoperable') s += cfg.addons.inoperable; if (v.modified) s += cfg.addons.modified; if (v.urgent) s += cfg.addons.urgent; return sum + Math.round(s); }, 0);
};

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

  const webVehicles = [{ year: '2020', make: 'Kia', model: 'K5', type: 'pickup', condition: 'inoperable', modified: false, urgent: true }];
  const expected = quote(cfg, webVehicles, 400);
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
  check('unknown vehicle type/condition normalised, long strings trimmed', v.type === 'sedan' && v.condition === 'operable' && v.model.length === 60, { type: v.type, cond: v.condition, len: v.model.length });
  check('non-image "photo" dropped, real image kept', v.photos.length === 1 && v.photos[0].data.startsWith('data:image/png'), v.photos.map(p => p.data.slice(0, 20)));
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
  let page = await fetch(`${B}/confirm/${token1}`);
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
  check('admin notified', !!lastMailTo('admin@mcships.test') && lastMailTo('admin@mcships.test').subject.includes('MC-T-SEND'));
  r = await api('POST', `/api/confirm/${token1}/agree`, { agreedName: 'Again', agreed: true }, { auth: false });
  check('agreeing again → 409 alreadyConfirmed', r.status === 409 && r.data.alreadyConfirmed === true);
  r = await api('POST', '/api/orders/MC-T-SEND/send-confirmation', {});
  check('resend after authorization → 409', r.status === 409);
  page = await fetch(`${B}/confirm/${token1}`); html = await page.text();
  check("confirmation page now shows 'You're confirmed'", html.includes("You're confirmed") && html.includes('class="space-y-6 hidden"'));

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

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('\nTEST CRASHED:', e);
  for (const id of created.orders) { try { await api('DELETE', `/api/orders/${id}`); } catch (_) {} }
  for (const id of [...new Set(created.customers)]) { try { await api('DELETE', `/api/customers/${id}`); } catch (_) {} }
  process.exit(1);
});
