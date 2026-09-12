// app.js
require('dotenv').config();
// Login email of the default admin account (used only when no admin exists yet)
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@mctransportation.com').trim().toLowerCase();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcryptjs');
const Stripe  = require('stripe');
const crypto  = require('crypto');
const nodemailer = require('nodemailer');

// ==================== STRIPE ====================
// Replace with your LIVE secret key when going live
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== MAIL ====================
// Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / MAIL_FROM in .env.
// Without SMTP_HOST nothing is sent — the admin UI still shows the link to copy.
//
// Resend (SMTP_HOST=smtp.resend.com) is sent through Resend's HTTPS API using
// SMTP_PASS as the API key: hosts like Railway block outbound SMTP ports, and the
// API works everywhere. Any other SMTP host goes through nodemailer as usual.
const useResendApi = /(^|\.)resend\.com$/i.test((process.env.SMTP_HOST || '').trim()) && !!process.env.SMTP_PASS;
const mailer = process.env.SMTP_HOST && !useResendApi
  ? nodemailer.createTransport({
      host  : process.env.SMTP_HOST,
      port  : Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth  : process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    })
  : null;
if (useResendApi) console.log('📧 Mail: Resend API');
else if (mailer) console.log(`📧 Mail: SMTP via ${process.env.SMTP_HOST}`);

async function sendViaResend({ from, to, subject, html, text }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: `Bearer ${process.env.SMTP_PASS}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], reply_to: 'sales@mcships.com', subject, html, text })
    });
    if (!r.ok) {
      let msg = `Resend HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.message) msg = j.message; } catch {}
      throw new Error(msg);
    }
  } finally { clearTimeout(timer); }
}

// ---- Gmail API sending (customer email leaves from a real Gmail account → Primary tab) ----
// Connected once from /admin/email; the refresh token lives in the settings table.
// Needs GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET (Google Cloud OAuth client, Web application).
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
let gmailCache = { checkedAt: 0, conn: null, accessToken: null, accessExp: 0 };
function gmailConfigured() { return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET); }
async function gmailConnection(force = false) {
  if (!force && Date.now() - gmailCache.checkedAt < 60000) return gmailCache.conn;
  try {
    const [rows] = await pool.execute("SELECT value FROM settings WHERE name = 'gmail_oauth'");
    gmailCache.conn = rows.length ? safeJson(rows[0].value) : null;
  } catch (e) { gmailCache.conn = null; }
  gmailCache.checkedAt = Date.now();
  return gmailCache.conn;
}
async function gmailAccessToken() {
  const conn = await gmailConnection();
  if (!conn || !conn.refreshToken || !gmailConfigured()) return null;
  if (gmailCache.accessToken && Date.now() < gmailCache.accessExp - 60000) return gmailCache.accessToken;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, refresh_token: conn.refreshToken, grant_type: 'refresh_token' })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Gmail token refresh failed: ' + (j.error_description || j.error || r.status));
  gmailCache.accessToken = j.access_token; gmailCache.accessExp = Date.now() + (j.expires_in || 3600) * 1000;
  return j.access_token;
}
// RFC 2822 message with text + HTML parts, base64url-encoded the way Gmail wants it
function buildMimeMessage({ from, to, replyTo, subject, html, text }) {
  const boundary = 'mc_' + crypto.randomBytes(8).toString('hex');
  const encSubject = '=?UTF-8?B?' + Buffer.from(String(subject), 'utf8').toString('base64') + '?=';
  const lines = [
    `From: ${from}`, `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    replyTo ? `Reply-To: ${replyTo}` : null, `Subject: ${encSubject}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(String(text || html.replace(/<[^>]+>/g, ' ')), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'), '',
    `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(String(html), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'), '',
    `--${boundary}--`
  ].filter(l => l !== null);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
async function sendViaGmail({ from, to, subject, html, text }) {
  const token = await gmailAccessToken();
  if (!token) throw new Error('Gmail is not connected');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildMimeMessage({ from, to, replyTo: 'sales@mcships.com', subject, html, text }) })
  });
  if (!r.ok) {
    let msg = `Gmail HTTP ${r.status}`;
    try { const j = await r.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
    throw new Error(msg);
  }
}

// Customer-facing mail: Gmail when connected (falls back to Resend/SMTP on error).
// Internal alerts (to ADMIN_NOTIFY_EMAIL) always use Resend/SMTP so the Gmail quota is kept for customers.
async function sendMail({ to, subject, html, text }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || 'sales@mcships.com';
  const internal = process.env.ADMIN_NOTIFY_EMAIL && String(to).toLowerCase() === process.env.ADMIN_NOTIFY_EMAIL.toLowerCase();
  if (!internal && process.env.MAIL_DISABLE_GMAIL !== '1' && (await gmailConnection())) {
    try { await sendViaGmail({ from, to, subject, html, text }); return { sent: true, via: 'gmail' }; }
    catch (e) { console.error('Gmail send failed, falling back:', e.message); }
  }
  if (!mailer && !useResendApi) {
    console.log(`📧 [mail not configured] would send "${subject}" to ${to}`);
    return { sent: false, reason: 'Email is not set up yet (add SMTP_HOST, SMTP_USER, SMTP_PASS to .env)' };
  }
  if (useResendApi) await sendViaResend({ from, to, subject, html, text });
  else await mailer.sendMail({ from, to, subject, html, text });
  return { sent: true, via: useResendApi ? 'resend' : 'smtp' };
}

// Public base URL for links in emails (APP_URL in .env, else the request host)
function appUrl(req) {
  return (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

// Never let one bad request take the whole site down; log it and keep serving.
process.on("uncaughtException", (e) => console.error("UNCAUGHT EXCEPTION:", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("UNHANDLED REJECTION:", e && e.stack || e));

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Railway/Heroku-style proxy → correct req.protocol / client IP

// ==================== DB POOL ====================
const pool = mysql.createPool({
  host    : process.env.DB_HOST,
  port    : process.env.DB_PORT     || 3306,
  user    : process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit   : 10,
  ssl: { rejectUnauthorized: false }   // Railway требует SSL
});

// ==================== CUSTOMERS HELPER ====================
// Find-or-create a customer record and return its id.
//  - c.id set          → update that record
//  - else c.email set  → match by email
//  - else              → insert a new record (no way to dedupe without email)
// overwrite=false (web checkout) only fills blank fields on an existing record;
// overwrite=true (admin intake) replaces fields with any non-empty values given.
async function upsertCustomer(db, c, overwrite = false) {
  const name    = (c.name || c.fullName || '').trim();
  const email   = (c.email || '').trim().toLowerCase() || null;
  const phone   = (c.phone || '').trim() || null;
  const company = (c.company || '').trim() || null;
  const type    = (c.type || '').trim() || null;
  const notes   = (c.notes || '').trim() || null;
  if (!c.id && !name && !email && !phone) return null;

  let existingId = c.id ? Number(c.id) : null;
  if (!existingId && email) {
    const [rows] = await db.execute('SELECT id FROM customers WHERE email = ?', [email]);
    if (rows.length) existingId = rows[0].id;
  }

  if (existingId) {
    const sql = overwrite
      ? `UPDATE customers SET
           name    = COALESCE(?, name),
           email   = COALESCE(?, email),
           phone   = COALESCE(?, phone),
           company = COALESCE(?, company),
           type    = COALESCE(?, type),
           notes   = COALESCE(?, notes)
         WHERE id = ?`
      : `UPDATE customers SET
           name    = IF(name IS NULL OR name = '', COALESCE(?, name), name),
           email   = COALESCE(email, ?),
           phone   = COALESCE(phone, ?),
           company = COALESCE(company, ?),
           type    = COALESCE(type, ?),
           notes   = COALESCE(notes, ?)
         WHERE id = ?`;
    await db.execute(sql, [name || null, email, phone, company, type, notes, existingId]);
    return existingId;
  }

  const [result] = await db.execute(
    'INSERT INTO customers (name, email, phone, company, type, notes) VALUES (?,?,?,?,?,?)',
    [name || email || phone || 'Customer', email, phone, company, type || 'individual', notes]
  );
  return result.insertId;
}

// Normalise a DB order row for API responses. Photos are base64 blobs inside the
// vehicles JSON, so list views strip them and only the detail view keeps them.
function mapOrderRow(r, withPhotos = false) {
  const stripPhotos = (v) => {
    if (!v || withPhotos) return v;
    const { photos, ...rest } = v;
    return rest;
  };
  const vehicles = safeJson(r.vehicles);
  const vehicle  = safeJson(r.vehicle) || (vehicles && vehicles.length ? vehicles[0] : null);
  return {
    id            : r.id,
    status        : r.status,
    contact       : safeJson(r.contact) || {},
    vehicle       : stripPhotos(vehicle),
    vehicles      : vehicles ? vehicles.map(stripPhotos) : null,
    location      : safeJson(r.location) || {},
    pickupDate    : r.pickup_date,
    mustDeliverBy : r.must_deliver_by,
    transportType : r.transport_type,
    total         : Number(r.total),
    customerId    : r.customer_id || null,
    source        : r.source || 'web',
    paymentStatus : r.payment_status || 'paid',
    distance      : r.distance != null ? Number(r.distance) : null,
    notes         : r.notes || null,
    // Pickup confirmation + card hold (phone-in orders)
    noShowFee     : r.no_show_fee != null ? Number(r.no_show_fee) : null,
    confirmToken  : r.confirm_token || null,
    confirmSentAt : r.confirm_sent_at || null,
    agreedAt      : r.agreed_at || null,
    agreedName    : r.agreed_name || null,
    agreedIp      : r.agreed_ip || null,
    holdAmount    : r.hold_amount != null ? Number(r.hold_amount) : null,
    holdExpiresAt : r.hold_expires_at || null,
    chargedAt     : r.charged_at || null,
    chargedAmount : r.charged_amount != null ? Number(r.charged_amount) : null,
    refundedAmount: r.refunded_amount != null ? Number(r.refunded_amount) : 0,
    refundedAt    : r.refunded_at || null,
    pickedUpAt    : r.picked_up_at || null,
    hasCardOnFile : !!r.stripe_payment_method_id,
    stripePaymentIntentId: r.stripe_payment_intent_id || null,
    feePaymentIntentId   : r.fee_payment_intent_id || null,
    paymentState  : paymentStateOf(r),
    agreement     : safeJson(r.agreement_json) || null,   // signed pickup agreement record (proof)
    disputeStatus : r.dispute_status || null,               // 'open' while a chargeback is being fought
    pricing       : safeJson(r.pricing_json) || null,         // engine breakdown at the time of the quote (admin)
    // Dispatch & tracking
    dispatch      : { carrierName: r.carrier_name || '', carrierPhone: r.carrier_phone || '', driverName: r.driver_name || '', driverPhone: r.driver_phone || '',
                      pickupEta: r.pickup_eta || '', deliveryEta: r.delivery_eta || '', notes: r.dispatch_notes || '', dispatchedAt: r.dispatched_at || null },
    deliveredAt   : r.delivered_at || null,
    trackingToken : r.tracking_token || null,
    documents     : safeJson(r.documents_json) || [],          // [{ url, name, kind: bol|pickup|delivery|other, mime, size, at }]
    events        : safeJson(r.events_json) || [],             // [{ at, type, note }] shown on the customer tracking page
    reviewSentAt  : r.review_sent_at || null,
    sms           : safeJson(r.sms_json) || [],                // [{ at, to, body, ok, error }] texts sent to the customer
    createdAt     : r.created_at
  };
}
// ---------------------------------------------------------------------------
// SMS via Twilio's REST API (no SDK needed). Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// and TWILIO_FROM (your Twilio number, e.g. +15025550100, or a Messaging Service SID).
// ---------------------------------------------------------------------------
function smsConfigured() { return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM); }
// "(502) 417-8040" → "+15024178040"; anything that isn't a 10/11-digit US number → null
function toE164(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (/^\+\d{11,15}$/.test(String(phone || '').trim())) return String(phone).trim();
  return null;
}
let smsTransport = async (to, body) => {
  const sid = process.env.TWILIO_ACCOUNT_SID.trim(), from = process.env.TWILIO_FROM.trim();
  const params = new URLSearchParams({ To: to, Body: body });
  params.set(/^MG[a-f0-9]{32}$/i.test(from) ? 'MessagingServiceSid' : 'From', from);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN.trim()}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `Twilio error ${r.status}`);
  return { sid: data.sid };
};
function setSmsTransport(fn) { smsTransport = fn; } // tests swap in a fake
// Send one text. Never throws; returns { sent, reason }. Logged on the order when orderId is given.
async function sendSms(phone, body, orderId) {
  const to = toE164(phone);
  let result;
  if (!smsConfigured()) result = { sent: false, reason: 'Texting is not set up yet (add the Twilio keys)' };
  else if (!to) result = { sent: false, reason: 'No valid US mobile number on the order' };
  else {
    try { const r = await smsTransport(to, String(body).slice(0, 1200)); result = { sent: true, sid: r && r.sid }; }
    catch (e) { console.error('SMS failed:', e.message); result = { sent: false, reason: e.message }; }
  }
  if (orderId && to) {
    try {
      const [[row]] = await pool.execute('SELECT sms_json FROM orders WHERE id = ?', [orderId]);
      if (row) {
        const log = safeJson(row.sms_json) || [];
        log.push({ at: new Date().toISOString(), to, body: String(body).slice(0, 1200), ok: result.sent, error: result.sent ? null : result.reason });
        await pool.execute('UPDATE orders SET sms_json = ? WHERE id = ?', [JSON.stringify(log.slice(-50)), orderId]);
      }
    } catch (e) { console.error('sms log:', e.message); }
  }
  return result;
}
const smsFirstName = o => (((o.contact || {}).fullName || '').trim().split(/\s+/)[0]) || 'there';
const smsVehicle = o => vehicleLabel(orderVehicles(o)[0] || {}).replace(/^Vehicle$/, 'vehicle');
function smsText(kind, o, extra = {}) {
  const d = o.dispatch || {};
  switch (kind) {
    case 'confirm':   return `Mcships: Hi ${smsFirstName(o)}, please confirm your pickup for the ${smsVehicle(o)} and add a card here (nothing is charged until pickup): ${extra.link}`;
    case 'dispatch':  return `Mcships: A carrier is assigned for your ${smsVehicle(o)}.${d.driverName ? ' Driver: ' + d.driverName + (d.driverPhone ? ' ' + d.driverPhone : '') + '.' : ''}${d.pickupEta ? ' Pickup: ' + d.pickupEta + '.' : ''} Track: ${extra.track}`;
    case 'picked_up': return `Mcships: Your ${smsVehicle(o)} has been picked up.${d.deliveryEta ? ' Delivery: ' + d.deliveryEta + '.' : ''} Track: ${extra.track}`;
    case 'update':    return `Mcships update: ${extra.note} Track: ${extra.track}`;
    case 'delivered': return `Mcships: Your ${smsVehicle(o)} was delivered. Thank you for shipping with us! Details: ${extra.track}`;
    default:          return String(extra.note || '');
  }
}

// Customer-facing tracking link. Older orders get a token the first time one is needed.
async function ensureTrackingToken(row) {
  if (row.tracking_token) return row.tracking_token;
  const token = crypto.randomBytes(24).toString('hex');
  await pool.execute('UPDATE orders SET tracking_token = ? WHERE id = ? AND tracking_token IS NULL', [token, row.id]);
  const [[fresh]] = await pool.execute('SELECT tracking_token FROM orders WHERE id = ?', [row.id]);
  return (fresh && fresh.tracking_token) || token;
}
const SITE_URL = () => (process.env.APP_URL || 'https://mcships.com').replace(/\/$/, '');
async function trackingUrl(row, req) { return `${req ? appUrl(req) : SITE_URL()}/track/${await ensureTrackingToken(row)}`; }
// Append one line to the order's customer-visible timeline
async function addOrderEvent(id, type, note) {
  const [[row]] = await pool.execute('SELECT events_json FROM orders WHERE id = ?', [id]);
  if (!row) return;
  const events = safeJson(row.events_json) || [];
  events.push({ at: new Date().toISOString(), type, note: note ? String(note).slice(0, 500) : '' });
  await pool.execute('UPDATE orders SET events_json = ? WHERE id = ?', [JSON.stringify(events.slice(-100)), id]);
}

// One word for the money situation, used by the admin Payments page:
//   unpaid → no card yet · pending → confirmation emailed, waiting on customer
//   holding → card authorized, not charged · charged → money collected
//   fee_charged → no-show fee collected · refunded / partially_refunded
//   released → hold cancelled by admin · expired → hold lapsed (card removed)
function paymentStateOf(r) {
  const ps = r.payment_status || 'paid';
  const charged = Number(r.charged_amount) || (ps === 'paid' ? Number(r.total) || 0 : 0);
  const refunded = Number(r.refunded_amount) || 0;
  if ((ps === 'paid' || ps === 'fee_charged') && refunded > 0)
    return refunded >= charged - 0.005 ? 'refunded' : 'partially_refunded';
  if (ps === 'paid') return 'charged';
  if (ps === 'authorized') return 'holding';
  if (ps === 'confirmation_sent') return 'pending';
  return ps; // unpaid, fee_charged, released, expired
}

function mapCustomerRow(r) {
  return {
    id          : r.id,
    name        : r.name,
    email       : r.email,
    phone       : r.phone,
    company     : r.company,
    type        : r.type || 'individual',
    notes       : r.notes,
    orderCount  : Number(r.order_count) || 0,
    totalSpent  : Number(r.total_spent) || 0,
    lastOrderAt : r.last_order_at || null,
    createdAt   : r.created_at,
    updatedAt   : r.updated_at
  };
}

// ==================== PRICING (server-side source of truth) ====================
// The calculator config is stored in the `settings` table and edited from the
// admin Calculator page. Both the public pages and the Stripe amount use it, so
// a customer cannot change the price from the browser.
// Rate per mile falls with distance (a 2,900-mile run is ~$0.60/mi, a 100-mile
// run ~$2.20/mi). Rates BLEND between the distance points below — no cliffs.
const DEFAULT_CALCULATOR_CONFIG = {
  baseFee: 95,
  tiers: [
    { max: 100,  rate: 2.35 },
    { max: 300,  rate: 1.55 },
    { max: 600,  rate: 1.12 },
    { max: 1000, rate: 0.88 },
    { max: 1500, rate: 0.76 },
    { max: 2200, rate: 0.69 },
    { max: null, rate: 0.65 }   // null = everything beyond the last point
  ],
  multipliers: { 'sedan': 1.00, 'mid-suv': 1.10, 'full-suv': 1.20, 'pickup': 1.15, 'cargo-van': 1.25, 'passenger-van': 1.25, 'mini-van': 1.00, 'other': 1.20 },
  addons: { inoperable: 75, modified: 100, urgent: 100 }
};

function sanitizeCalculatorConfig(v) {
  if (!v || typeof v !== 'object') return null;
  const num = (x, min, max) => { const n = Number(x); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const baseFee = num(v.baseFee, 0, 100000);
  if (baseFee == null) return null;
  if (!Array.isArray(v.tiers) || !v.tiers.length || v.tiers.length > 20) return null;
  const tiers = [];
  for (const t of v.tiers) {
    const rate = num(t && t.rate, 0, 1000);
    if (rate == null) return null;
    const max = (t.max == null || t.max === Infinity || t.max === '∞' || t.max === '') ? null : num(t.max, 0, 100000);
    if (max === null && t.max != null && t.max !== Infinity && t.max !== '∞' && t.max !== '') return null;
    tiers.push({ max, rate });
  }
  tiers.sort((a, b) => (a.max == null ? Infinity : a.max) - (b.max == null ? Infinity : b.max));
  const multipliers = {};
  for (const k of VEHICLE_TYPES) multipliers[k] = num(v.multipliers && v.multipliers[k], 0.1, 10) ?? DEFAULT_CALCULATOR_CONFIG.multipliers[k];
  const addons = {};
  for (const k of ['inoperable', 'modified', 'urgent']) addons[k] = num(v.addons && v.addons[k], 0, 100000) ?? DEFAULT_CALCULATOR_CONFIG.addons[k];
  return { baseFee, tiers, multipliers, addons };
}

async function getCalculatorConfig() {
  try {
    const [rows] = await pool.execute("SELECT value FROM settings WHERE name = 'calculator'");
    if (rows.length) {
      const cfg = sanitizeCalculatorConfig(safeJson(rows[0].value));
      if (cfg) return cfg;
    }
  } catch (e) { console.error('getCalculatorConfig:', e.message); }
  return DEFAULT_CALCULATOR_CONFIG;
}

// Rate per mile for a distance: linear blend between the tier points (no cliffs)
function cpmForDistance(cfg, miles) {
  const pts = cfg.tiers.filter(t => t.max != null).sort((a, b) => a.max - b.max);
  const tail = cfg.tiers.find(t => t.max == null);
  if (!pts.length) return tail ? tail.rate : 0;
  if (miles <= pts[0].max) return pts[0].rate;
  for (let i = 1; i < pts.length; i++) {
    if (miles <= pts[i].max) {
      const a = pts[i - 1], b = pts[i];
      return a.rate + (b.rate - a.rate) * ((miles - a.max) / (b.max - a.max));
    }
  }
  return tail ? tail.rate : pts[pts.length - 1].rate;
}

// ==================== MARKET LAYERS ====================
// Everything here sits on top of the base curve. Stored in settings 'pricing',
// edited on the admin Calculator page. Customers only ever see the total.
const DEFAULT_PRICING = {
  minimumPrice: 250,            // floor per order
  enclosedMultiplier: 1.45,     // enclosed trailer vs open
  multiVehicleDiscountPct: 5,   // off each extra vehicle on the same route
  fuel: { enabled: true, baselineDiesel: 5.95, pctPerQuarter: 3, minPct: -10, maxPct: 25 },   // % per $0.25 of diesel vs the price on the day the curve was calibrated (Sep 2026)
  season: { 1: 1.06, 2: 1.04, 3: 1.02, 4: 1.00, 5: 1.03, 6: 1.06, 7: 1.06, 8: 1.04, 9: 1.00, 10: 1.02, 11: 1.04, 12: 1.06 },
  timing: { shortNoticeDays: 2, shortNoticePct: 8, flexibleDays: 5, flexiblePct: -3 },
  marketPct: 0,                 // your hand on the wheel: +/- % on everything
  // Hard-to-reach pickup/delivery: tier from distance to the nearest metro and/or the AI check
  difficulty: { enabled: true, aiEnabled: true, fees: { 1: 75, 2: 150, 3: 300 }, metroMiles: { 1: 60, 2: 120, 3: 220 } },
  // Region-to-region multipliers ("FROM>TO"); anything not listed is 1.00
  lanes: { 'FL>NE': 1.08, 'FL>MW': 1.06, 'FL>MA': 1.06, 'NE>FL': 0.96, 'MW>FL': 0.96, 'MA>FL': 0.97, 'MT>PW': 1.04, 'PW>MT': 1.04, 'CE>NE': 1.05, 'NE>CE': 1.05, 'CE>PW': 1.04, 'PW>CE': 1.04, 'TX>PW': 0.98, 'PW>TX': 0.98 }
};
// Regions used by the lane table (by state)
const REGION_OF_STATE = {
  CT:'NE', MA:'NE', ME:'NE', NH:'NE', RI:'NE', VT:'NE', NY:'NE', NJ:'NE', PA:'NE',
  DE:'MA', MD:'MA', DC:'MA', VA:'MA', WV:'MA',
  NC:'SE', SC:'SE', GA:'SE', AL:'SE', MS:'SE', TN:'SE', KY:'SE',
  FL:'FL',
  OH:'MW', IN:'MW', IL:'MW', MI:'MW', WI:'MW', MN:'MW', IA:'MW', MO:'MW',
  ND:'CE', SD:'CE', NE:'CE', KS:'CE', OK:'CE', AR:'CE',
  TX:'TX', LA:'TX',
  MT:'MT', ID:'MT', WY:'MT', CO:'MT', UT:'MT', NV:'MT', AZ:'MT', NM:'MT',
  WA:'PW', OR:'PW', CA:'PW',
  AK:'AK', HI:'HI'
};
const REGION_NAMES = { NE: 'Northeast', MA: 'Mid-Atlantic', SE: 'Southeast', FL: 'Florida', MW: 'Midwest', CE: 'Central Plains', TX: 'Texas / Louisiana', MT: 'Mountain West', PW: 'Pacific', AK: 'Alaska', HI: 'Hawaii' };
const STATE_NAMES = { alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA', hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND', ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC', 'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY' };
function stateFromAddress(addr) {
  const a = String(addr || '');
  const m = a.match(/\b([A-Z]{2})\b(?:\s+\d{5})?(?:,\s*(?:USA|United States))?\s*$/) || a.match(/,\s*([A-Z]{2})\s+\d{5}/) || a.match(/,\s*([A-Z]{2})\b/);
  if (m && REGION_OF_STATE[m[1]]) return m[1];
  const low = a.toLowerCase();
  for (const [name, abbr] of Object.entries(STATE_NAMES)) if (low.includes(name)) return abbr;
  return null;
}
function regionOf(addr) { const st = stateFromAddress(addr); return st ? REGION_OF_STATE[st] || null : null; }

// ---- Metro distance ----
const METROS = require('./data/metros.json');
function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toR = d => d * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function nearestMetro(lat, lng) {
  let best = null;
  for (const m of METROS) { const d = haversineMiles(lat, lng, m.lat, m.lng); if (!best || d < best.miles) best = { name: m.name, miles: Math.round(d) }; }
  return best;
}

// ---- AI difficulty check (Claude) — answers a fixed JSON shape; cached per address ----
async function aiAssessLocation(address, lat, lng, metro) {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'claude-sonnet-5', max_tokens: 300,
        system: 'You rate how hard a U.S. address is for an open car-hauler truck (75 ft, needs paved access and room to turn) to reach. Reply with JSON only, no prose: {"tier":0|1|2|3,"reasons":["..."],"flags":{"island":bool,"noRoad":bool,"ferry":bool,"mountain":bool,"unpaved":bool,"gated":bool}}. Tier 0 = normal city/suburb/highway-adjacent. Tier 1 = small town or outer suburb, some detour. Tier 2 = rural, unpaved or narrow roads, far from interstates, or difficult terrain. Tier 3 = island, ferry-only, no road access, extreme remoteness (rural Alaska), or a place a car hauler realistically cannot reach. Base the answer on the place itself, not the customer. Keep reasons to 2 short phrases.',
        messages: [{ role: 'user', content: `Address: ${address}${lat != null ? ` (lat ${lat}, lng ${lng})` : ''}${metro ? `. Nearest major metro: ${metro.name}, ${metro.miles} miles away.` : ''}` }]
      })
    });
    const j = await r.json();
    const text = j && j.content && j.content[0] && j.content[0].text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in AI reply');
    const out = JSON.parse(m[0]);
    const tier = Math.max(0, Math.min(3, parseInt(out.tier, 10) || 0));
    return { tier, reasons: Array.isArray(out.reasons) ? out.reasons.slice(0, 3).map(x => String(x).slice(0, 120)) : [], flags: out.flags && typeof out.flags === 'object' ? out.flags : {} };
  } catch (e) { console.error('aiAssessLocation:', e.message); return null; }
  finally { clearTimeout(timer); }
}

// One assessment per address, cached in location_ratings. Tier = max(metro-distance tier, AI tier), unless an admin override is set.
async function assessLocation(P, address, lat, lng) {
  address = str(address, 500);
  if (!address) return null;
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  const keyStr = hasCoords ? `${(+lat).toFixed(3)},${(+lng).toFixed(3)}` : address.toLowerCase().replace(/\s+/g, ' ').trim();
  const key = crypto.createHash('sha256').update(keyStr).digest('hex');
  let row = null;
  try { const [rows] = await pool.execute('SELECT * FROM location_ratings WHERE rating_key = ?', [key]); row = rows[0] || null; } catch (e) {}
  const metro = hasCoords ? nearestMetro(+lat, +lng) : null;
  let ai = row ? { tier: row.ai_tier, reasons: safeJson(row.ai_reasons) || [], flags: safeJson(row.ai_flags) || {} } : null;
  if (!row) {
    ai = P.difficulty.aiEnabled ? await aiAssessLocation(address, hasCoords ? +lat : null, hasCoords ? +lng : null, metro) : null;
    try {
      await pool.execute(
        'INSERT IGNORE INTO location_ratings (rating_key, address, lat, lng, metro_name, metro_miles, ai_tier, ai_reasons, ai_flags) VALUES (?,?,?,?,?,?,?,?,?)',
        [key, address, hasCoords ? +lat : null, hasCoords ? +lng : null, metro ? metro.name : null, metro ? metro.miles : null, ai ? ai.tier : null, JSON.stringify(ai ? ai.reasons : []), JSON.stringify(ai ? ai.flags : {})]);
    } catch (e) { console.error('location_ratings insert:', e.message); }
  }
  let metroTier = 0;
  if (metro) { const mm = P.difficulty.metroMiles; metroTier = metro.miles >= mm[3] ? 3 : metro.miles >= mm[2] ? 2 : metro.miles >= mm[1] ? 1 : 0; }
  const aiTier = ai && ai.tier != null ? ai.tier : 0;
  let tier = Math.max(metroTier, aiTier);
  const override = row && row.override_tier != null ? Number(row.override_tier) : null;
  if (override != null) tier = override;
  const reasons = [];
  if (metro) reasons.push(`${metro.miles} mi from ${metro.name}`);
  if (ai && ai.reasons && ai.reasons.length) reasons.push(...ai.reasons);
  const flags = (ai && ai.flags) || {};
  return { key, address, tier, metroTier, aiTier, override, metro, reasons, flags, noRoad: !!(flags.island || flags.noRoad || flags.ferry) };
}
// Region/lane helper used by the engine
function laneMultiplier(P, pickup, delivery) {
  const a = regionOf(pickup), b = regionOf(delivery);
  if (!a || !b) return { mult: 1, from: a, to: b };
  const mult = Number(P.lanes && P.lanes[`${a}>${b}`]) || 1;
  return { mult, from: a, to: b };
}
function sanitizePricing(v) {
  if (!v || typeof v !== 'object') return null;
  const num = (x, min, max, d) => { const n = Number(x); return Number.isFinite(n) && n >= min && n <= max ? n : d; };
  const D = DEFAULT_PRICING, f = v.fuel || {}, t = v.timing || {}, se = v.season || {};
  const season = {};
  for (let m = 1; m <= 12; m++) season[m] = num(se[m], 0.5, 2, D.season[m]);
  return {
    minimumPrice: num(v.minimumPrice, 0, 100000, D.minimumPrice),
    enclosedMultiplier: num(v.enclosedMultiplier, 1, 3, D.enclosedMultiplier),
    multiVehicleDiscountPct: num(v.multiVehicleDiscountPct, 0, 50, D.multiVehicleDiscountPct),
    fuel: { enabled: f.enabled !== false && f.enabled !== 'false', baselineDiesel: num(f.baselineDiesel, 1, 10, D.fuel.baselineDiesel), pctPerQuarter: num(f.pctPerQuarter, 0, 20, D.fuel.pctPerQuarter), minPct: num(f.minPct, -50, 0, D.fuel.minPct), maxPct: num(f.maxPct, 0, 100, D.fuel.maxPct) },
    season,
    timing: { shortNoticeDays: num(t.shortNoticeDays, 0, 30, D.timing.shortNoticeDays), shortNoticePct: num(t.shortNoticePct, 0, 50, D.timing.shortNoticePct), flexibleDays: num(t.flexibleDays, 0, 60, D.timing.flexibleDays), flexiblePct: num(t.flexiblePct, -30, 0, D.timing.flexiblePct) },
    marketPct: num(v.marketPct, -50, 100, D.marketPct),
    difficulty: {
      enabled: !(v.difficulty && (v.difficulty.enabled === false || v.difficulty.enabled === 'false')),
      aiEnabled: !(v.difficulty && (v.difficulty.aiEnabled === false || v.difficulty.aiEnabled === 'false')),
      fees: { 1: num(v.difficulty && v.difficulty.fees && v.difficulty.fees[1], 0, 5000, D.difficulty.fees[1]), 2: num(v.difficulty && v.difficulty.fees && v.difficulty.fees[2], 0, 5000, D.difficulty.fees[2]), 3: num(v.difficulty && v.difficulty.fees && v.difficulty.fees[3], 0, 10000, D.difficulty.fees[3]) },
      metroMiles: { 1: num(v.difficulty && v.difficulty.metroMiles && v.difficulty.metroMiles[1], 1, 2000, D.difficulty.metroMiles[1]), 2: num(v.difficulty && v.difficulty.metroMiles && v.difficulty.metroMiles[2], 1, 2000, D.difficulty.metroMiles[2]), 3: num(v.difficulty && v.difficulty.metroMiles && v.difficulty.metroMiles[3], 1, 3000, D.difficulty.metroMiles[3]) }
    },
    lanes: (() => { const out = {}; const src = v.lanes && typeof v.lanes === 'object' ? v.lanes : D.lanes; for (const [k, val] of Object.entries(src)) { if (/^[A-Z]{2}>[A-Z]{2}$/.test(k)) { const n = num(val, 0.5, 2, null); if (n != null && n !== 1) out[k] = n; } } return out; })()
  };
}
async function getPricing() {
  try {
    const [rows] = await pool.execute("SELECT value FROM settings WHERE name = 'pricing'");
    if (rows.length) { const p = sanitizePricing(safeJson(rows[0].value)); if (p) return p; }
  } catch (e) { console.error('getPricing:', e.message); }
  return DEFAULT_PRICING;
}

// ---- Fuel index: U.S. average diesel ($/gal) from the EIA weekly series ----
let fuelCache = { checkedAt: 0, idx: null };
async function getFuelIndex() {
  if (Date.now() - fuelCache.checkedAt < 10 * 60 * 1000) return fuelCache.idx;
  try {
    const [rows] = await pool.execute("SELECT value FROM settings WHERE name = 'fuel_index'");
    fuelCache = { checkedAt: Date.now(), idx: rows.length ? safeJson(rows[0].value) : null };
  } catch (e) { fuelCache = { checkedAt: Date.now(), idx: null }; }
  return fuelCache.idx;
}
async function refreshFuelIndex(force = false) {
  const key = (process.env.EIA_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'EIA_API_KEY not set' };
  const cur = await getFuelIndex();
  if (!force && cur && cur.fetchedAt && Date.now() - new Date(cur.fetchedAt).getTime() < 6 * 86400000) return { ok: true, idx: cur, skipped: true };
  try {
    const url = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/?' + new URLSearchParams({
      api_key: key, frequency: 'weekly', 'data[0]': 'value', 'facets[series][0]': 'EMD_EPD2D_PTE_NUS_DPG',
      'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: '1'
    });
    const r = await fetch(url); const j = await r.json();
    const row = j && j.response && j.response.data && j.response.data[0];
    if (!row || !(Number(row.value) > 0)) throw new Error('no data in EIA response');
    const idx = { price: Number(row.value), period: row.period, fetchedAt: new Date().toISOString(), source: 'EIA weekly U.S. No 2 diesel retail' };
    await pool.execute("INSERT INTO settings (name, value) VALUES ('fuel_index', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(idx)]);
    fuelCache = { checkedAt: Date.now(), idx };
    console.log(`⛽ Diesel index updated: $${idx.price}/gal (week of ${idx.period})`);
    return { ok: true, idx };
  } catch (e) { console.error('refreshFuelIndex:', e.message); return { ok: false, reason: e.message }; }
}

async function getPricingContext() {
  const [cfg, pricing, fuel] = await Promise.all([getCalculatorConfig(), getPricing(), getFuelIndex()]);
  return { cfg, pricing, fuel };
}

// The engine. Returns { total, subtotal, lines:[{label, amount}], factors }.
// input: { vehicles, distance, transportType, pickupDate, mustDeliverBy, when }
function priceQuote(ctx, input) {
  const { cfg, pricing: P, fuel } = ctx;
  const miles = Math.max(0, Number(input.distance) || 0);
  const cpm = cpmForDistance(cfg, miles);
  const enclosed = input.transportType === 'enclosed';
  const lines = [];
  const addons = [];   // flat per-vehicle extras the customer chose; added after the minimum price
  let subtotal = 0;
  const nVeh = (input.vehicles || []).length;
  (input.vehicles || []).forEach((v, i) => {
    let base = cfg.baseFee + cpm * miles;
    const mult = cfg.multipliers[v.type] || 1;
    base *= mult;
    if (enclosed) base *= P.enclosedMultiplier;
    let price = base;
    if (i > 0 && P.multiVehicleDiscountPct) price *= (1 - P.multiVehicleDiscountPct / 100);
    price = Math.round(price);
    const label = [v.year, v.make, v.model].filter(Boolean).join(' ') || (v.type || 'vehicle');
    lines.push({ label: `Vehicle ${i + 1}: ${label} — ${miles.toLocaleString()} mi × $${cpm.toFixed(2)} + base $${cfg.baseFee}${mult !== 1 ? ', ×' + mult + ' size' : ''}${enclosed ? ', ×' + P.enclosedMultiplier + ' enclosed' : ''}${i > 0 && P.multiVehicleDiscountPct ? ', −' + P.multiVehicleDiscountPct + '% extra vehicle' : ''}`, amount: price });
    subtotal += price;
    const add = (key, text, amt) => { amt = Math.round(Number(amt) || 0); if (amt > 0) addons.push({ vehicle: i, key, label: (nVeh > 1 ? `Vehicle ${i + 1}: ` : '') + text, amount: amt }); };
    if (v.condition === 'inoperable') add('inoperable', 'Inoperable (winch loading)', cfg.addons.inoperable);
    if (v.modified) add('modified', 'Modified / custom vehicle', cfg.addons.modified);
    if (v.urgent)   add('urgent', 'Urgent delivery', cfg.addons.urgent);
  });

  // market layers (each a %; applied multiplicatively)
  const factors = {};
  if (P.fuel.enabled && fuel && fuel.price > 0) {
    const pct = Math.max(P.fuel.minPct, Math.min(P.fuel.maxPct, ((fuel.price - P.fuel.baselineDiesel) / 0.25) * P.fuel.pctPerQuarter));
    factors.fuel = { pct: Math.round(pct * 10) / 10, diesel: fuel.price, baseline: P.fuel.baselineDiesel };
  }
  const when = input.when ? new Date(input.when) : new Date();
  const pickup = input.pickupDate && /^\d{4}-\d{2}-\d{2}$/.test(input.pickupDate) ? new Date(input.pickupDate + 'T12:00:00') : null;
  const month = (pickup && !isNaN(pickup) ? pickup : when).getMonth() + 1;
  factors.season = { pct: Math.round((P.season[month] - 1) * 1000) / 10, month };
  if (pickup && !isNaN(pickup)) {
    const daysOut = Math.round((pickup - when) / 86400000);
    if (daysOut <= P.timing.shortNoticeDays) factors.shortNotice = { pct: P.timing.shortNoticePct, daysOut };
    const deliverBy = input.mustDeliverBy && /^\d{4}-\d{2}-\d{2}$/.test(input.mustDeliverBy) ? new Date(input.mustDeliverBy + 'T12:00:00') : null;
    if (deliverBy && !isNaN(deliverBy)) {
      const windowDays = Math.round((deliverBy - pickup) / 86400000);
      if (windowDays >= P.timing.flexibleDays && !(daysOut <= P.timing.shortNoticeDays)) factors.flexible = { pct: P.timing.flexiblePct, windowDays };
    }
  }
  if (P.marketPct) factors.market = { pct: P.marketPct };
  const lane = laneMultiplier(P, input.pickup, input.delivery);
  if (lane.mult !== 1) factors.lane = { pct: Math.round((lane.mult - 1) * 1000) / 10, from: lane.from, to: lane.to };

  let total = subtotal;
  const apply = (key, label) => {
    const f = factors[key]; if (!f || !f.pct) return;
    const amt = Math.round(total * f.pct / 100);
    lines.push({ label, amount: amt });
    total += amt;
  };
  apply('fuel', `Fuel surcharge (diesel $${factors.fuel ? factors.fuel.diesel.toFixed(2) : ''} vs $${P.fuel.baselineDiesel.toFixed(2)} baseline, ${factors.fuel ? (factors.fuel.pct > 0 ? '+' : '') + factors.fuel.pct : 0}%)`);
  apply('season', `Season (month ${month}, ${factors.season.pct > 0 ? '+' : ''}${factors.season.pct}%)`);
  apply('shortNotice', `Short notice (pickup within ${P.timing.shortNoticeDays} days, +${P.timing.shortNoticePct}%)`);
  apply('flexible', `Flexible dates (${factors.flexible ? factors.flexible.windowDays : ''}-day window, ${P.timing.flexiblePct}%)`);
  apply('lane', `Lane ${factors.lane ? (REGION_NAMES[factors.lane.from] || factors.lane.from) + ' → ' + (REGION_NAMES[factors.lane.to] || factors.lane.to) : ''} (${factors.lane && factors.lane.pct > 0 ? '+' : ''}${factors.lane ? factors.lane.pct : 0}%)`);
  apply('market', `Market adjustment (${P.marketPct > 0 ? '+' : ''}${P.marketPct}%)`);
  if (total < P.minimumPrice && nVeh) { lines.push({ label: `Minimum order price`, amount: Math.round(P.minimumPrice - total) }); total = P.minimumPrice; }
  const transport = Math.max(0, Math.round(total));
  total = transport;
  // Flat fees on top of the transport price (never absorbed by the minimum):
  // hard-to-reach locations by tier, then the extras chosen per vehicle
  const fees = [];
  for (const [end, loc] of [['pickup', input.pickupLoc], ['delivery', input.deliveryLoc]]) {
    if (!P.difficulty.enabled || !loc || !loc.tier) continue;
    const fee = P.difficulty.fees[loc.tier] || 0;
    if (!fee) continue;
    lines.push({ label: `Hard-to-reach ${end} (tier ${loc.tier}${loc.reasons.length ? ': ' + loc.reasons.slice(0, 2).join('; ') : ''})`, amount: fee });
    fees.push({ key: end, label: `Hard-to-reach ${end} location`, amount: fee });
    total += fee;
    factors[end + 'Difficulty'] = { tier: loc.tier, fee, reasons: loc.reasons };
  }
  for (const ad of addons) { lines.push({ label: ad.label, amount: ad.amount }); total += ad.amount; }
  total = Math.max(0, Math.round(total));
  const requiresCall = !!((input.pickupLoc && input.pickupLoc.noRoad) || (input.deliveryLoc && input.deliveryLoc.noRoad));
  return { total, transport, subtotal: Math.round(subtotal), cpm: Math.round(cpm * 100) / 100, lines, factors, requiresCall, addons, fees };
}

// Back-compat: price with market layers loaded from settings
async function computeQuoteLive(vehicles, distance, opts = {}) {
  const ctx = await getPricingContext();
  const input = { vehicles, distance, ...opts };
  if (ctx.pricing.difficulty.enabled && opts.assessLocations !== false) {
    const [pl, dl] = await Promise.all([
      opts.pickup ? assessLocation(ctx.pricing, opts.pickup, opts.pickupLat, opts.pickupLng) : null,
      opts.delivery ? assessLocation(ctx.pricing, opts.delivery, opts.deliveryLat, opts.deliveryLng) : null
    ]);
    input.pickupLoc = pl; input.deliveryLoc = dl;
  }
  return priceQuote(ctx, input);
}
// Address/coordinate fields from a request body, sanitized
function locationOpts(b) {
  const n = (x) => { const v = Number(x); return Number.isFinite(v) ? v : undefined; };
  return { pickup: str(b.pickup, 500), delivery: str(b.delivery, 500), pickupLat: n(b.pickupLat), pickupLng: n(b.pickupLng), deliveryLat: n(b.deliveryLat), deliveryLng: n(b.deliveryLng) };
}

async function findActivePromo(code) {
  const clean = String(code || '').toUpperCase().trim();
  if (!clean) return null;
  const [rows] = await pool.execute('SELECT * FROM promo_codes WHERE code = ? AND active = 1', [clean]);
  return rows.length ? rows[0] : null;
}
function promoDiscount(promo, subtotal) {
  if (!promo) return 0;
  const d = Number(promo.discount) || 0;
  return promo.type === 'percent' ? Math.round(subtotal * d / 100) : Math.min(d, subtotal);
}

// ==================== DB INIT ====================
async function initDB() {
  const conn = await pool.getConnection();
  try {
    // Таблица заказов
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id          VARCHAR(20)  PRIMARY KEY,
        status      VARCHAR(20)  NOT NULL DEFAULT 'New',
        contact     JSON         NOT NULL,
        vehicle     JSON,
        vehicles    JSON,
        location    JSON,
        pickup_date VARCHAR(20),
        must_deliver_by VARCHAR(20),
        transport_type VARCHAR(20),
        total       DECIMAL(10,2) DEFAULT 0,
        customer_id INT,
        source      VARCHAR(20)  NOT NULL DEFAULT 'web',
        payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
        distance    INT,
        notes       TEXT,
        confirm_token   VARCHAR(64),
        confirm_sent_at DATETIME,
        no_show_fee     DECIMAL(10,2),
        agreed_at       DATETIME,
        agreed_name     VARCHAR(255),
        agreed_ip       VARCHAR(64),
        stripe_customer_id       VARCHAR(64),
        stripe_payment_method_id VARCHAR(64),
        stripe_payment_intent_id VARCHAR(64),
        fee_payment_intent_id    VARCHAR(64),
        hold_amount     DECIMAL(10,2),
        hold_expires_at DATETIME,
        charged_at      DATETIME,
        charged_amount  DECIMAL(10,2),
        picked_up_at    DATETIME,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate older orders tables (customer link, phone-in fields, pickup confirmation + card hold)
    const orderExtraCols = [
      ['customer_id', 'INT'],
      ['source', "VARCHAR(20) NOT NULL DEFAULT 'web'"],
      ['payment_status', "VARCHAR(20) NOT NULL DEFAULT 'paid'"],
      ['distance', 'INT'],
      ['notes', 'TEXT'],
      ['confirm_token', 'VARCHAR(64)'],
      ['confirm_sent_at', 'DATETIME'],
      ['no_show_fee', 'DECIMAL(10,2)'],
      ['agreed_at', 'DATETIME'],
      ['agreed_name', 'VARCHAR(255)'],
      ['agreed_ip', 'VARCHAR(64)'],
      ['stripe_customer_id', 'VARCHAR(64)'],
      ['stripe_payment_method_id', 'VARCHAR(64)'],
      ['stripe_payment_intent_id', 'VARCHAR(64)'],
      ['fee_payment_intent_id', 'VARCHAR(64)'],
      ['hold_amount', 'DECIMAL(10,2)'],
      ['hold_expires_at', 'DATETIME'],
      ['refunded_amount', 'DECIMAL(10,2)'],
      ['refunded_at', 'DATETIME'],
      ['dispute_status', 'VARCHAR(30)'],
      ['pricing_json', 'JSON'],
      ['agreement_json', 'MEDIUMTEXT'],
      ['charged_at', 'DATETIME'],
      ['charged_amount', 'DECIMAL(10,2)'],
      ['picked_up_at', 'DATETIME'],
      // Dispatch + tracking (drivers have no app; the team relays updates)
      ['carrier_name', 'VARCHAR(255)'], ['carrier_phone', 'VARCHAR(40)'], ['driver_name', 'VARCHAR(255)'], ['driver_phone', 'VARCHAR(40)'],
      ['pickup_eta', 'VARCHAR(80)'], ['delivery_eta', 'VARCHAR(80)'], ['dispatch_notes', 'TEXT'], ['dispatched_at', 'DATETIME'],
      ['delivered_at', 'DATETIME'], ['tracking_token', 'VARCHAR(64)'], ['documents_json', 'MEDIUMTEXT'], ['events_json', 'MEDIUMTEXT'],
      ['review_sent_at', 'DATETIME'],
      ['sms_json', 'MEDIUMTEXT'],
    ];
    for (const [col, def] of orderExtraCols) {
      try { await conn.execute(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
    }

    // Таблица сотрудников
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS employees (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(255) UNIQUE NOT NULL,
        password   VARCHAR(255)        NOT NULL,
        role       VARCHAR(50)         NOT NULL DEFAULT 'admin',
        name       VARCHAR(255),
        company    VARCHAR(255),
        created_at DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const [col, def] of [['name', 'VARCHAR(255)'], ['company', 'VARCHAR(255)'], ['reset_token_hash', 'VARCHAR(64)'], ['reset_expires', 'DATETIME']]) {
      try { await conn.execute(`ALTER TABLE employees ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
    }

    // Таблица промокодов
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        code       VARCHAR(50) UNIQUE NOT NULL,
        discount   DECIMAL(5,2) NOT NULL,
        type       ENUM('percent','fixed') NOT NULL DEFAULT 'percent',
        active     TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица email-подписчиков / лидов
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS leads (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(255) UNIQUE NOT NULL,
        source     VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Location difficulty ratings (metro distance + AI), one row per address
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS location_ratings (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        rating_key    VARCHAR(64) UNIQUE NOT NULL,
        address       VARCHAR(500),
        lat           DECIMAL(9,6),
        lng           DECIMAL(9,6),
        metro_name    VARCHAR(100),
        metro_miles   INT,
        ai_tier       TINYINT,
        ai_reasons    JSON,
        ai_flags      JSON,
        override_tier TINYINT,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Website quotes: saved when a visitor gives their email on the calculator.
    // The token goes in the quote email's "Book" link and prefills checkout.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS quotes (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        token          VARCHAR(64) UNIQUE NOT NULL,
        email          VARCHAR(255) NOT NULL,
        name           VARCHAR(255),
        phone          VARCHAR(50),
        vehicle_json   JSON,
        distance       INT,
        pickup         VARCHAR(500),
        delivery       VARCHAR(500),
        transport_type VARCHAR(20),
        total          DECIMAL(10,2) NOT NULL,
        breakdown_json JSON,
        order_id       VARCHAR(20),
        emailed_at     DATETIME,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const [col, def] of [['pickup_lat', 'DECIMAL(9,6)'], ['pickup_lng', 'DECIMAL(9,6)'], ['delivery_lat', 'DECIMAL(9,6)'], ['delivery_lng', 'DECIMAL(9,6)'], ['followup1_at', 'DATETIME'], ['followup2_at', 'DATETIME']]) {
      try { await conn.execute(`ALTER TABLE quotes ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
    }

    // Таблица клиентов (CRM) — orders link to a customer by contact.email
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS customers (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        email      VARCHAR(255) UNIQUE,
        phone      VARCHAR(50),
        company    VARCHAR(255),
        type       VARCHAR(30)  NOT NULL DEFAULT 'individual',
        notes      TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Exchange: listings (load board)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS listings (
        id            VARCHAR(20) PRIMARY KEY,
        origin_city   VARCHAR(100) NOT NULL,
        origin_state  VARCHAR(10)  NOT NULL,
        dest_city     VARCHAR(100) NOT NULL,
        dest_state    VARCHAR(10)  NOT NULL,
        vehicle_label VARCHAR(255) NOT NULL,
        vehicle_count INT          NOT NULL DEFAULT 1,
        price         DECIMAL(10,2) NOT NULL,
        miles         INT          NOT NULL DEFAULT 0,
        pickup_label  VARCHAR(50)  DEFAULT 'Available Now',
        deliver_date  VARCHAR(20),
        status        VARCHAR(20)  NOT NULL DEFAULT 'Available',
        shipper_email VARCHAR(255),
        origin_address TEXT,
        dest_address   TEXT,
        vehicles_json  JSON,
        pickup_notes   TEXT,
        dropoff_notes  TEXT,
        attachments_json JSON,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrate extra columns for existing DBs
    const listingExtraCols = [
      ['origin_address', 'TEXT'],
      ['dest_address', 'TEXT'],
      ['vehicles_json', 'JSON'],
      ['pickup_notes', 'TEXT'],
      ['dropoff_notes', 'TEXT'],
      ['attachments_json', 'JSON']
    ];
    for (const [col, def] of listingExtraCols) {
      try { await conn.execute(`ALTER TABLE listings ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
    }

    // Exchange: bids
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bids (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        listing_id        VARCHAR(20)  NOT NULL,
        carrier_email     VARCHAR(255) NOT NULL,
        amount            DECIMAL(10,2) NOT NULL,
        contact_name      VARCHAR(255),
        contact_email     VARCHAR(255),
        contact_phone     VARCHAR(50),
        pickup_estimate   VARCHAR(50),
        delivery_estimate VARCHAR(50),
        created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_bid_listing_carrier (listing_id, carrier_email)
      )
    `);

    // Exchange: carrier contacts
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS contacts (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        carrier_email VARCHAR(255) NOT NULL,
        name          VARCHAR(255) NOT NULL,
        email         VARCHAR(255),
        phone         VARCHAR(50),
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_contact_carrier (carrier_email)
      )
    `);

    // Exchange: instant bookings / carrier loads
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS bookings (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        listing_id    VARCHAR(20)  NOT NULL,
        carrier_email VARCHAR(255) NOT NULL,
        amount        DECIMAL(10,2) NOT NULL,
        status        VARCHAR(30)  NOT NULL DEFAULT 'Booked',
        driver_name   VARCHAR(255),
        picked_up_at  DATETIME,
        dropped_off_at DATETIME,
        pickup_eta    VARCHAR(50),
        dropoff_eta   VARCHAR(50),
        origin_city   VARCHAR(100),
        origin_state  VARCHAR(10),
        dest_city     VARCHAR(100),
        dest_state    VARCHAR(10),
        vehicle_label VARCHAR(255),
        vehicle_count INT DEFAULT 1,
        miles         INT DEFAULT 0,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_booking_carrier (carrier_email),
        INDEX idx_booking_status (status)
      )
    `);

    // Migrate older bookings tables that lack the new columns
    const bookingCols = [
      ['status', "VARCHAR(30) NOT NULL DEFAULT 'Booked'"],
      ['driver_name', 'VARCHAR(255)'],
      ['invoice_url', 'VARCHAR(500)'],
      ['bol_url', 'VARCHAR(500)'],
      ['carrier_docs_json', 'JSON'],
      ['picked_up_at', 'DATETIME'],
      ['dropped_off_at', 'DATETIME'],
      ['pickup_eta', 'VARCHAR(50)'],
      ['dropoff_eta', 'VARCHAR(50)'],
      ['origin_city', 'VARCHAR(100)'],
      ['origin_state', 'VARCHAR(10)'],
      ['dest_city', 'VARCHAR(100)'],
      ['dest_state', 'VARCHAR(10)'],
      ['vehicle_label', 'VARCHAR(255)'],
      ['vehicle_count', 'INT DEFAULT 1'],
      ['miles', 'INT DEFAULT 0'],
    ];
    for (const [col, def] of bookingCols) {
      try {
        await conn.execute(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
      } catch (e) {
        // column already exists
      }
    }

    // Site settings (calculator pricing lives here so the server can price quotes itself)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        name       VARCHAR(50) PRIMARY KEY,
        value      JSON NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Default admin (only if no admin exists). Password from ADMIN_DEFAULT_PASSWORD, else the
    // historical default — change it right after first login (POST /api/auth/change-password).
    const [admins] = await conn.execute("SELECT id FROM employees WHERE role = 'admin' LIMIT 1");
    if (admins.length === 0) {
      const pw = process.env.ADMIN_DEFAULT_PASSWORD || 'mcadmin2026';
      await conn.execute(
        'INSERT INTO employees (email, password, role) VALUES (?, ?, ?)',
        [ADMIN_EMAIL, await bcrypt.hash(pw, 10), 'admin']
      );
      console.log(`✅ Default admin created: ${ADMIN_EMAIL} (change the password after first login)`);
    }

    // Demo carrier/shipper accounts + sample listings only when explicitly requested
    const seedDemo = process.env.SEED_DEMO_DATA === 'true';
    if (seedDemo) {
      for (const u of [
        { email: 'carrier@mctransportation.com', password: 'carrier2026', role: 'carrier' },
        { email: 'shipper@mctransportation.com', password: 'shipper2026', role: 'shipper' },
      ]) {
        const [existing] = await conn.execute('SELECT id FROM employees WHERE email = ?', [u.email]);
        if (existing.length === 0) {
          await conn.execute('INSERT INTO employees (email, password, role) VALUES (?, ?, ?)',
            [u.email, await bcrypt.hash(u.password, 10), u.role]);
          console.log(`✅ Demo ${u.role} created: ${u.email}`);
        }
      }
    }

    // Seed exchange listings if empty (demo data)
    const [listingRows] = await conn.execute('SELECT id FROM listings LIMIT 1');
    if (seedDemo && listingRows.length === 0) {
      const seedListings = [
        ['HX-2001','Detroit','MI','Springfield','MO','2 Vehicle Load',2,1500,725,'Available Now','05/28/26'],
        ['HX-2002','Atlanta','GA','Littlerock','AR','2023 Kia K5',1,770,511,'Available Now','05/23/26'],
        ['HX-2003','Atlanta','GA','Denver','CO','2023 Mercedes-Benz E-Class',1,1110,1402,'Available Now','05/23/26'],
        ['HX-2004','Atlanta','GA','Charlotte','NC','2 Vehicles',2,385,245,'Available Now','05/23/26'],
        ['HX-2005','Miami','FL','Houston','TX','2024 Toyota Camry',1,620,1190,'Available Now','05/24/26'],
        ['HX-2006','Phoenix','AZ','Los Angeles','CA','2022 Ford F-150',1,340,373,'Available Now','05/24/26'],
        ['HX-2007','Chicago','IL','Dallas','TX','2021 BMW X5',1,1450,925,'Available Now','05/26/26'],
      ];
      for (const l of seedListings) {
        await conn.execute(
          `INSERT INTO listings
             (id, origin_city, origin_state, dest_city, dest_state,
              vehicle_label, vehicle_count, price, miles, pickup_label, deliver_date)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          l
        );
      }
      console.log('✅ Exchange listings seeded');
    }

    // Seed demo contacts for the demo carrier
    const [contactRows] = await conn.execute('SELECT id FROM contacts LIMIT 1');
    if (seedDemo && contactRows.length === 0) {
      const seedContacts = [
        ['carrier@mctransportation.com', 'John Smith', 'john@carrier.com', '555-0101'],
        ['carrier@mctransportation.com', 'Mike Johnson', 'mike@carrier.com', '555-0102'],
        ['carrier@mctransportation.com', 'Dispatch Team', 'dispatch@carrier.com', '555-0103'],
      ];
      for (const c of seedContacts) {
        await conn.execute(
          'INSERT INTO contacts (carrier_email, name, email, phone) VALUES (?,?,?,?)',
          c
        );
      }
      console.log('✅ Demo contacts seeded');
    }

    // Backfill: link pre-existing orders to customer records by contact email (idempotent)
    const [unlinked] = await conn.execute('SELECT id, contact FROM orders WHERE customer_id IS NULL');
    let linked = 0;
    for (const o of unlinked) {
      const contact = safeJson(o.contact) || {};
      const cid = await upsertCustomer(conn, {
        name: contact.fullName, email: contact.email, phone: contact.phone, company: contact.company
      });
      if (cid) {
        await conn.execute('UPDATE orders SET customer_id = ? WHERE id = ?', [cid, o.id]);
        linked++;
      }
    }
    if (linked) console.log(`✅ Linked ${linked} existing orders to customers`);

    console.log('✅ Database initialized');
  } finally {
    conn.release();
  }
}

// ==================== MIDDLEWARE ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Baseline security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// File storage (vehicle photos, invoices, BOLs, listing attachments)
// AWS S3 when AWS_S3_BUCKET is set; otherwise folders next to app.js.
// The bucket stays private — files are always served through the site.
//
// Layout (same in S3 and on disk):
//   uploads/<order id>/<file>        vehicle photos, one folder per order
//   documents/invoices/<file>        carrier invoices
//   documents/bols/<file>            bills of lading
//   documents/attachments/<file>     files attached to load listings
// ---------------------------------------------------------------------------
const STORAGE_ROOT = __dirname;
const FILE_FOLDERS = { photos: 'uploads', invoices: 'documents/invoices', bols: 'documents/bols', attachments: 'documents/attachments' };

const S3_BUCKET = (process.env.AWS_S3_BUCKET || '').trim();
let s3 = null;
if (S3_BUCKET) {
  const { S3Client } = require('@aws-sdk/client-s3');
  // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY automatically
  s3 = new S3Client({ region: (process.env.AWS_REGION || 'us-east-1').trim() });
  console.log(`📦 File storage: S3 bucket "${S3_BUCKET}"`);
} else {
  console.log('📦 File storage: local uploads/ and documents/ folders (set AWS_S3_BUCKET to use S3)');
}

const UPLOAD_TYPES = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf'
};
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', pdf: 'application/pdf' };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
// Storage key: uploads/<order>/<file>, documents/<kind>/<file>, or legacy uploads/<file>
const FILE_KEY_RE = /^(uploads|documents)(\/[A-Za-z0-9_-]{1,80}){0,2}\/[A-Za-z0-9_-]{1,120}\.(jpg|png|webp|gif|heic|pdf)$/;
const safeSegment = (s) => String(s || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 80);

async function storeFile(key, buf, mime) {
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buf, ContentType: mime }));
  } else {
    const file = path.join(STORAGE_ROOT, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
  }
}

// Decode a base64 data-URL (images / PDF only, size-capped) and store it in
// `folder` under a server-chosen name (never the client's). Returns null when rejected.
async function storeBase64Upload(dataUrl, folder, prefix) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = UPLOAD_TYPES[mime];
  if (!ext) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return null;
  const safeName = `${safeSegment(prefix).slice(0, 60) || 'file'}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const key = `${folder}/${safeName}`;
  if (!FILE_KEY_RE.test(key)) return null;
  await storeFile(key, buf, MIME_BY_EXT[ext]);
  return { url: `/${key}`, mime: MIME_BY_EXT[ext], name: safeName, size: buf.length };
}

// Vehicle photos arrive as base64 inside the vehicles array. Store each one in
// uploads/<order id>/ and keep only {name, url} in the database.
async function storeVehiclePhotos(vehicles, orderId) {
  const folder = `${FILE_FOLDERS.photos}/${safeSegment(orderId) || 'order'}`;
  for (let i = 0; i < vehicles.length; i++) {
    const photos = Array.isArray(vehicles[i].photos) ? vehicles[i].photos : [];
    const stored = [];
    for (let k = 0; k < photos.length; k++) {
      const p = photos[k];
      if (p && typeof p.url === 'string' && FILE_KEY_RE.test(p.url.replace(/^\//, ''))) { stored.push({ name: p.name || '', url: p.url }); continue; }
      const saved = await storeBase64Upload(p && p.data, folder, `v${i + 1}_${k + 1}`);
      if (saved) stored.push({ name: str(p.name, 120) || saved.name, url: saved.url });
    }
    vehicles[i].photos = stored;
  }
  return vehicles;
}

// Serve stored files as inert documents (no scripts, sandboxed) from S3 or disk.
async function serveStoredFile(req, res) {
  const key = req.path.replace(/^\/+/, '');
  if (!FILE_KEY_RE.test(key)) return res.status(404).end();
  const ext = key.slice(key.lastIndexOf('.') + 1);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (s3) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      res.setHeader('Content-Type', obj.ContentType || MIME_BY_EXT[ext]);
      if (obj.ContentLength) res.setHeader('Content-Length', String(obj.ContentLength));
      obj.Body.on('error', () => res.destroy()).pipe(res);
      return;
    } catch (e) {
      if (e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404)) {
        // fall through to disk for files saved before S3 was switched on
      } else {
        console.error('S3 read error:', e.message);
        return res.status(502).end();
      }
    }
  }
  const file = path.join(STORAGE_ROOT, key);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', MIME_BY_EXT[ext]);
  fs.createReadStream(file).pipe(res);
}
app.get(['/uploads/*', '/documents/*'], serveStoredFile);

// ---------------------------------------------------------------------------
// Stripe webhook: keeps orders in sync with things done outside the site
// (refunds/cancellations from the Stripe dashboard, chargebacks). Needs the raw
// body for signature checking, so it is registered before the JSON parser.
// Set STRIPE_WEBHOOK_SECRET (whsec_...) from Stripe → Developers → Webhooks.
// ---------------------------------------------------------------------------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!secret) return res.status(503).send('Webhook secret not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (e) {
    console.error('Stripe webhook signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    await handleStripeEvent(event);
    res.json({ received: true });
  } catch (e) {
    console.error(`Stripe webhook ${event.type}:`, e);
    res.status(500).send('handler error');
  }
});

async function orderRowForIntent(piId) {
  if (!piId) return null;
  const [rows] = await pool.execute('SELECT * FROM orders WHERE stripe_payment_intent_id = ? OR fee_payment_intent_id = ? LIMIT 1', [piId, piId]);
  return rows[0] || null;
}
async function notifyAdmin(subject, html, text) {
  if (!process.env.ADMIN_NOTIFY_EMAIL) return;
  await sendMail({ to: process.env.ADMIN_NOTIFY_EMAIL, subject, html: emailShell(html), text }).catch(e => console.error('admin notify:', e.message));
}
async function handleStripeEvent(event) {
  const obj = event.data.object || {};
  switch (event.type) {
    // Refund issued (from the site or the Stripe dashboard) → mirror the running total
    case 'charge.refunded': {
      const row = await orderRowForIntent(obj.payment_intent);
      if (!row) return;
      const refunded = (obj.amount_refunded || 0) / 100;
      if (Math.abs((Number(row.refunded_amount) || 0) - refunded) < 0.005) return; // already recorded by the site
      await pool.execute('UPDATE orders SET refunded_amount = ?, refunded_at = NOW() WHERE id = ?', [refunded, row.id]);
      console.log(`↩️  Stripe refund synced for ${row.id}: ${money(refunded)}`);
      return;
    }
    // Hold cancelled outside the site (dashboard) → mark released
    case 'payment_intent.canceled': {
      const row = await orderRowForIntent(obj.id);
      if (!row || row.payment_status !== 'authorized') return;
      await pool.execute("UPDATE orders SET payment_status = 'released', hold_amount = NULL, hold_expires_at = NULL WHERE id = ?", [row.id]);
      await detachCard(row);
      console.log(`🔓 Hold on ${row.id} cancelled in Stripe → released`);
      return;
    }
    // Captured outside the site (dashboard) → mark charged
    case 'payment_intent.succeeded': {
      const row = await orderRowForIntent(obj.id);
      if (!row || row.payment_status !== 'authorized') return;
      const amount = (obj.amount_received || 0) / 100;
      await pool.execute(
        `UPDATE orders SET payment_status = 'paid', charged_at = NOW(), charged_amount = ?, picked_up_at = COALESCE(picked_up_at, NOW()),
                notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE '\n' END, 'Captured from the Stripe dashboard') WHERE id = ?`,
        [amount, row.id]);
      await detachCard(row);
      console.log(`💳 ${row.id} captured in Stripe → charged ${money(amount)}`);
      return;
    }
    // Chargeback opened / closed → flag the order and tell the team
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const row = await orderRowForIntent(obj.payment_intent);
      if (!row) return;
      const opened = event.type === 'charge.dispute.created';
      const amount = (obj.amount || 0) / 100;
      const line = opened
        ? `⚠️ CHARGEBACK opened by the customer's bank for ${money(amount)} (reason: ${obj.reason || 'unknown'}, Stripe dispute ${obj.id})`
        : `Chargeback ${obj.id} closed: ${obj.status}`;
      await pool.execute(
        `UPDATE orders SET dispute_status = ?, notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE '\n' END, ?) WHERE id = ?`,
        [opened ? 'open' : (obj.status || 'closed'), line, row.id]);
      const c = safeJson(row.contact) || {};
      await notifyAdmin(
        `${opened ? '⚠️ Chargeback opened' : 'Chargeback closed'} – order ${row.id}`,
        `<p>${escHtml(line)}</p><p>Customer: <strong>${escHtml(c.fullName || '')}</strong> · ${escHtml(c.email || '')}</p>${opened ? '<p>Open the order in the admin panel and use <strong>View signed agreement</strong> for the evidence to submit to Stripe. Disputes usually must be answered within 7 days.</p>' : ''}`,
        `${line}\nCustomer: ${c.fullName || ''} ${c.email || ''}`);
      return;
    }
    default:
      return; // other events are ignored
  }
}

// Bodies carry base64 vehicle photos, so the limit is generous but bounded
app.use(express.urlencoded({ extended: true, limit: '30mb' }));
app.use(express.json({ limit: '30mb' }));

// ==================== SESSIONS (signed, httpOnly cookie) ====================
// Login sets a cookie signed with SESSION_SECRET. The payload (user id, email,
// role, expiry) is readable but cannot be forged without the secret.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set in .env — everyone is logged out whenever the server restarts.');
}
// Changes on every deploy (Railway sets the commit SHA) so browsers fetch fresh scripts
const ASSET_VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8) || Date.now().toString(36);
const SESSION_COOKIE = 'mc_session';
const SESSION_TTL_SECONDS = { admin: 24 * 3600, carrier: 7 * 24 * 3600, shipper: 7 * 24 * 3600 };
const REMEMBER_TTL_SECONDS = 30 * 24 * 3600; // "Keep me signed in"

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function createSessionToken(user, ttl) {
  ttl = ttl || SESSION_TTL_SECONDS[user.role] || 24 * 3600;
  const payload = Buffer.from(JSON.stringify({
    uid: user.id, email: user.email, role: user.role, exp: Date.now() + ttl * 1000
  })).toString('base64url');
  return `${payload}.${signSession(payload)}`;
}
function readSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(SESSION_COOKIE + '='));
  if (!cookie) return null;
  const [payload, sig] = cookie.slice(SESSION_COOKIE.length + 1).split('.');
  if (!payload || !sig) return null;
  const expected = signSession(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!s || !s.exp || s.exp < Date.now() || !s.role || !s.email) return null;
    return s;
  } catch (e) { return null; }
}
// remember=true → 30-day cookie that survives closing the browser; otherwise the
// cookie lasts for the browser session (and the token itself for the role's TTL).
function setSessionCookie(req, res, user, remember = false) {
  const ttl = remember ? REMEMBER_TTL_SECONDS : (SESSION_TTL_SECONDS[user.role] || 24 * 3600);
  const maxAge = remember ? `; Max-Age=${ttl}` : '';
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${createSessionToken(user, ttl)}; Path=/; HttpOnly; SameSite=Lax${maxAge}${req.secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
app.use((req, res, next) => { req.session = readSession(req); next(); });

// Values every template can use (keys live in .env, not in the page source files)
app.use((req, res, next) => {
  res.locals.googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
  res.locals.assetVersion  = ASSET_VERSION; // cache-buster for /js and /css after each deploy
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ success: false, message: 'Please sign in' });
    if (roles.length && !roles.includes(req.session.role)) return res.status(403).json({ success: false, message: 'Not allowed' });
    next();
  };
}
const requireAuth     = requireRole();
const requireAdmin    = requireRole('admin');
const requireCarrier  = requireRole('carrier', 'admin');
const requireShipper  = requireRole('shipper', 'admin');
const requireExchange = requireRole('carrier', 'shipper', 'admin');
// For exchange routes: act as yourself; admins may act on behalf of an email they pass
const actingEmail = (req, requested) =>
  (req.session.role === 'admin' && requested) ? String(requested).trim().toLowerCase() : req.session.email;

// ==================== RATE LIMITING (in-memory, per IP + route) ====================
const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${clientIp(req)}|${req.method} ${req.path}`;
    const now = Date.now();
    let b = rateBuckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; rateBuckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
      return res.status(429).json({ success: false, message: 'Too many requests — please try again in a few minutes' });
    }
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of rateBuckets) if (b.reset < now) rateBuckets.delete(k); }, 60 * 1000).unref();
const loginLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const publicLimiter   = rateLimit({ windowMs: 60 * 60 * 1000, max: 60 });

// ==================== INPUT SANITIZING ====================
const VEHICLE_TYPES = ['sedan', 'mid-suv', 'mini-van', 'full-suv', 'pickup', 'cargo-van', 'passenger-van', 'other'];
const MAX_VEHICLES = 10, MAX_PHOTOS = 8, MAX_PHOTO_CHARS = 2_000_000; // ~1.5 MB per photo (base64)

const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max);
const bool = v => v === true || v === 'true' || v === 1 || v === '1';

function sanitizeContact(c) {
  c = c && typeof c === 'object' ? c : {};
  const email = str(c.email, 254).toLowerCase();
  return {
    fullName: str(c.fullName, 120),
    email   : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
    phone   : str(c.phone, 40),
    company : str(c.company, 120),
    type    : CUSTOMER_TYPES.includes(c.type) ? c.type : undefined
  };
}

function sanitizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.slice(0, MAX_PHOTOS).filter(p => p && typeof p.data === 'string'
      && p.data.length <= MAX_PHOTO_CHARS
      && /^data:image\/(jpeg|jpg|png|webp|gif|heic|heif);base64,[A-Za-z0-9+/=]+$/.test(p.data))
    .map(p => ({ name: str(p.name, 120), data: p.data }));
}

function sanitizeVehicles(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_VEHICLES).filter(v => v && typeof v === 'object').map(v => ({
    year          : str(v.year, 4),
    make          : str(v.make, 60),
    model         : str(v.model, 60),
    vin           : str(v.vin, 17).toUpperCase(),
    type          : VEHICLE_TYPES.includes(v.type) ? v.type : 'sedan',
    condition     : v.condition === 'inoperable' ? 'inoperable' : 'operable',
    runsAndDrives : v.runsAndDrives !== false && v.runsAndDrives !== 'no',
    hasKeys       : v.hasKeys !== false && v.hasKeys !== 'no',
    modified      : bool(v.modified),
    modDescription: str(v.modDescription, 1000),
    urgent        : bool(v.urgent),
    damages       : str(v.damages, 1000),
    photos        : sanitizePhotos(v.photos)
  }));
}

// ==================== PAGE ROUTES ====================

// Sitemap for search engines: every public marketing page (robots.txt in /public points here)
const SITEMAP_PAGES = [
  ['/', 'weekly', '1.0'], ['/calculator', 'weekly', '0.9'], ['/dealers', 'monthly', '0.8'], ['/auctions', 'monthly', '0.8'],
  ['/oems', 'monthly', '0.7'], ['/fleet', 'monthly', '0.7'], ['/individuals', 'monthly', '0.8'], ['/decision', 'monthly', '0.6'],
  ['/haul-with-mc', 'monthly', '0.7'], ['/payment-tracker', 'monthly', '0.5'], ['/team', 'monthly', '0.5'], ['/careers', 'monthly', '0.5'],
  ['/blog', 'weekly', '0.6'], ['/contact', 'monthly', '0.7'], ['/extension', 'monthly', '0.4'], ['/terms', 'yearly', '0.3'], ['/privacy', 'yearly', '0.3']
];
app.get('/sitemap.xml', (req, res) => {
  const base = (process.env.APP_URL || 'https://mcships.com').replace(/\/$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_PAGES.map(([p, freq, pri]) =>
    `  <url><loc>${base}${p}</loc><lastmod>${today}</lastmod><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
});

app.get('/',               (req, res) => res.render('index'));

// Legal pages: content lives in legal/*.html (plain HTML with <%= phone %>), wrapped by views/legal.ejs
const LEGAL_UPDATED = 'September 5, 2026';
function legalPage(file, meta) {
  return (req, res) => {
    const raw = fs.readFileSync(path.join(__dirname, 'legal', file), 'utf8');
    const body = require('ejs').render(raw, { phone: COMPANY_PHONE });
    res.render('legal', { ...meta, body, phone: COMPANY_PHONE, updated: LEGAL_UPDATED });
  };
}
app.get('/terms', legalPage('terms.html', {
  title: 'Terms of Service',
  description: 'The terms that apply to quotes, bookings, payments, card holds, cancellations and the MC Exchange on mcships.com.',
  summary: 'You get a quote, we move your vehicle. Phone-in bookings put a hold on your card and only charge once the vehicle is picked up. If the vehicle is not there when our carrier arrives, a dry-run fee applies. Inspect the vehicle at delivery and note anything on the Bill of Lading.'
}));
app.get('/privacy', legalPage('privacy.html', {
  title: 'Privacy Policy',
  description: 'What information mcships.com collects, why, who it is shared with, and how long it is kept.',
  summary: 'We collect what we need to move your vehicle and take payment. Cards are handled by Stripe and removed within 7 days of a pickup confirmation. We never sell your information.'
}));
app.get('/calculator',     (req, res) => res.render('calculator'));
app.get('/payment',        (req, res) => res.render('payment'));
app.get('/quote-success',  (req, res) => res.render('quote-success'));

app.get('/auctions',       (req, res) => res.render('auctions'));
app.get('/dealers',        (req, res) => res.render('dealers'));
app.get('/oems',           (req, res) => res.render('oems'));
app.get('/fleet',          (req, res) => res.render('fleet'));
app.get('/individuals',    (req, res) => res.render('individuals'));
app.get('/contact',        (req, res) => res.render('contact'));
app.get('/decision',       (req, res) => res.render('decision'));

app.get('/haul-with-mc',   (req, res) => res.render('haul'));
app.get('/payment-tracker',(req, res) => res.render('payment-tracker'));

app.get('/team',           (req, res) => res.render('team'));
app.get('/careers',        (req, res) => res.render('careers'));
app.get('/blog',           (req, res) => res.render('blog'));
app.get('/extension',      (req, res) => res.render('extension'));

// Admin panel — sign-in page plus one page per section (views/admin/*). Pages are
// served only with a valid admin session; otherwise redirect to sign-in and come back after.
const requireAdminPage = (req, res, next) =>
  (req.session && req.session.role === 'admin') ? next() : res.redirect('/admin?next=' + encodeURIComponent(req.originalUrl));
app.get('/admin',             (req, res) => res.render('admin/login'));
app.get('/admin/home',        requireAdminPage, (req, res) => res.render('admin/home'));
app.get('/admin/orders',      requireAdminPage, (req, res) => res.render('admin/orders'));
app.get('/admin/customers',   requireAdminPage, (req, res) => res.render('admin/customers'));
app.get('/admin/promo-codes', requireAdminPage, (req, res) => res.render('admin/promo-codes'));
app.get('/admin/calculator',  requireAdminPage, (req, res) => res.render('admin/calculator'));
app.get('/admin/payments',    requireAdminPage, (req, res) => res.render('admin/payments'));
app.get('/admin/leads',       requireAdminPage, (req, res) => res.render('admin/leads'));
app.get('/admin/email',       requireAdminPage, (req, res) => res.render('admin/email'));
app.get('/admin/search',      requireAdminPage, (req, res) => res.render('admin/search', { searchQuery: str(req.query.q, 100) }));

// ---- Gmail connection (admin) ----
const gmailRedirect = (req) => `${appUrl(req)}/admin/gmail/callback`;
app.get('/admin/gmail/connect', requireAdminPage, (req, res) => {
  if (!gmailConfigured()) return res.status(400).send('Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first.');
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `mc_gmail_state=${state}; Path=/admin/gmail; HttpOnly; SameSite=Lax; Max-Age=600${req.secure ? '; Secure' : ''}`);
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID, redirect_uri: gmailRedirect(req), response_type: 'code',
    scope: GMAIL_SCOPE + ' https://www.googleapis.com/auth/userinfo.email', access_type: 'offline', prompt: 'consent', state
  });
  res.redirect(url);
});
app.get('/admin/gmail/callback', requireAdminPage, async (req, res) => {
  try {
    const cookieState = ((req.headers.cookie || '').match(/mc_gmail_state=([a-f0-9]+)/) || [])[1];
    if (!req.query.code || !req.query.state || req.query.state !== cookieState) return res.status(400).send('Sign-in did not complete. Go back and try Connect again.');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: String(req.query.code), client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET, redirect_uri: gmailRedirect(req), grant_type: 'authorization_code' })
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) return res.status(400).send('Google did not return a refresh token: ' + (j.error_description || j.error || 'unknown') + '. Remove mcships from your Google account permissions and connect again.');
    let email = null;
    try { const u = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + j.access_token } })).json(); email = u.email || null; } catch {}
    await pool.execute("INSERT INTO settings (name, value) VALUES ('gmail_oauth', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [JSON.stringify({ refreshToken: j.refresh_token, email, connectedAt: new Date().toISOString(), by: req.session.email })]);
    gmailCache = { checkedAt: 0, conn: null, accessToken: null, accessExp: 0 };
    res.redirect('/admin/email?connected=1');
  } catch (err) {
    console.error('gmail callback:', err);
    res.status(500).send('Could not finish connecting Gmail: ' + err.message);
  }
});
app.get('/api/email/status', requireAdmin, async (req, res) => {
  const conn = await gmailConnection(true);
  res.json({
    gmailConfigured: gmailConfigured(), gmailConnected: !!(conn && conn.refreshToken), gmailEmail: conn ? conn.email : null, gmailConnectedAt: conn ? conn.connectedAt : null,
    fallback: useResendApi ? 'Resend' : (mailer ? 'SMTP' : 'none'), from: process.env.MAIL_FROM || process.env.SMTP_USER || '', redirectUri: gmailRedirect(req)
  });
});
app.post('/api/email/disconnect', requireAdmin, async (req, res) => {
  await pool.execute("DELETE FROM settings WHERE name = 'gmail_oauth'");
  gmailCache = { checkedAt: 0, conn: null, accessToken: null, accessExp: 0 };
  res.json({ success: true });
});
app.post('/api/email/test', requireAdmin, async (req, res) => {
  const to = str(req.body.to, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ success: false, message: 'Enter a valid email' });
  try {
    const r = await sendMail({ to, subject: 'Test email from mcships.com', html: emailShell('<p>This is a test email from the mcships.com admin. If you can read this, sending works.</p>'), text: 'This is a test email from the mcships.com admin. If you can read this, sending works.' });
    res.json({ success: !!r.sent, via: r.via || null, message: r.sent ? `Sent via ${r.via}` : r.reason });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
// Printable record of the customer's signed pickup agreement (proof for disputes)
app.get('/admin/orders/:id/agreement', requireAdminPage, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).render('404');
    const order = mapOrderRow(row, false);
    res.render('admin/agreement', { order, agreement: order.agreement, money, phone: COMPANY_PHONE });
  } catch (err) {
    console.error('GET /admin/orders/:id/agreement:', err);
    res.status(500).send('Server error');
  }
});
app.get('/sign-in',        (req, res) => res.render('sign-in'));
app.get('/register',       (req, res) => res.render('register'));

app.get('/exchange/listings',  (req, res) => res.render('exchange/listings'));
app.get('/exchange/shipments', (req, res) => res.render('exchange/shipments'));

// ==================== API: ORDERS ====================

// GET all orders (photos stripped — only loaded in detail view)
const ORDER_STATUSES = ['New', 'In Work', 'Done', 'Canceled'];

// Shared search for orders: id, contact (name/email/phone/company), vehicle
// (make/model/VIN), route. Returns SQL fragment + params.
function orderSearchWhere(q, status) {
  const clauses = [], params = [];
  if (q) {
    const like = `%${q}%`;
    clauses.push('(id LIKE ? OR contact LIKE ? OR vehicle LIKE ? OR vehicles LIKE ? OR location LIKE ? OR notes LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  if (status && ORDER_STATUSES.includes(status)) { clauses.push('status = ?'); params.push(status); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
function pageParams(req, defaultLimit = 50) {
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(5, parseInt(req.query.limit, 10) || defaultLimit));
  return { page, limit, paged: req.query.page != null };
}
function paginate(list, page, limit) {
  const total = list.length, pages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(page, pages);
  return { slice: list.slice((p - 1) * limit, p * limit), total, page: p, pages };
}

// GET orders — ?q=&status=&payment=<paymentState>&page=&limit=
// Without ?page it returns the plain array (older callers); with ?page → {orders,total,page,pages}
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const q = str(req.query.q, 100), status = str(req.query.status, 20), payment = str(req.query.payment, 30);
    const { where, params } = orderSearchWhere(q, status);
    const [rows] = await pool.execute(`SELECT * FROM orders ${where} ORDER BY created_at DESC`, params);
    let list = rows.map(r => mapOrderRow(r));
    if (payment) list = list.filter(o => o.paymentState === payment);
    const { page, limit, paged } = pageParams(req);
    if (!paged) return res.json(list);
    const pg = paginate(list, page, limit);
    res.json({ orders: pg.slice, total: pg.total, page: pg.page, pages: pg.pages });
  } catch (err) {
    console.error('GET /api/orders:', err);
    res.json([]);
  }
});

// Global admin search box: a few best matches from orders and customers
// ?full=1 → up to 50 of each plus leads (results page); otherwise the top 6 for the dropdown
app.get('/api/search', requireAdmin, async (req, res) => {
  const q = str(req.query.q, 100);
  if (!q) return res.json({ orders: [], customers: [], leads: [] });
  const full = req.query.full === '1';
  const lim = full ? 50 : 6;
  try {
    const { where, params } = orderSearchWhere(q, '');
    const [orders] = await pool.execute(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ${lim}`, params);
    const like = `%${q}%`;
    const [customers] = await pool.execute(
      `SELECT c.*, COUNT(o.id) AS order_count, COALESCE(SUM(o.total),0) AS total_spent, MAX(o.created_at) AS last_order_at
         FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        WHERE c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.company LIKE ?
        GROUP BY c.id ORDER BY last_order_at DESC LIMIT ${lim}`, [like, like, like, like]);
    let leads = [];
    if (full) {
      const [ls] = await pool.execute('SELECT * FROM leads WHERE email LIKE ? OR source LIKE ? ORDER BY created_at DESC LIMIT 50', [like, like]);
      leads = ls.map(l => ({ id: l.id, email: l.email, source: l.source, createdAt: l.created_at }));
    }
    res.json({
      orders: orders.map(r => { const o = mapOrderRow(r); const loc = o.location || {}; return { id: o.id, customer: (o.contact || {}).fullName || '', email: (o.contact || {}).email || '', phone: (o.contact || {}).phone || '', vehicle: o.vehicle ? [o.vehicle.year, o.vehicle.make, o.vehicle.model].filter(Boolean).join(' ') : '', vin: o.vehicle && o.vehicle.vin || '', pickup: loc.pickup || '', delivery: loc.delivery || '', total: o.total, status: o.status, paymentState: o.paymentState, source: o.source, createdAt: o.createdAt }; }),
      customers: customers.map(mapCustomerRow),
      leads
    });
  } catch (err) {
    console.error('GET /api/search:', err);
    res.json({ orders: [], customers: [], leads: [] });
  }
});

// GET single order WITH photos (for detail modal)
app.get('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM orders WHERE id = ?', [req.params.id]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false });
    res.json(mapOrderRow(rows[0], true));
  } catch (err) {
    console.error('GET /api/orders/:id', err);
    res.status(500).json({ success: false });
  }
});

// POST create order.
//  - Signed-in admin  → phone-in intake: unpaid quote, admin sets the price.
//  - Anyone else      → web checkout: must reference a Stripe PaymentIntent that this
//                       server created (kind=web_checkout) and that has succeeded. The
//                       amount Stripe actually collected becomes the order total, so the
//                       browser cannot decide the price.
app.post('/api/orders', publicLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const isAdmin = !!(req.session && req.session.role === 'admin');

    const contact  = sanitizeContact(b.contact);
    const vehicles = sanitizeVehicles(b.vehicles) || (b.vehicle ? sanitizeVehicles([b.vehicle]) : null);
    if (!vehicles || !vehicles.length)
      return res.status(400).json({ success: false, message: 'At least one vehicle is required' });
    if (!contact.fullName || (!contact.phone && !contact.email))
      return res.status(400).json({ success: false, message: 'Contact name and phone or email are required' });

    const loc = b.location && typeof b.location === 'object' ? b.location : {};
    const location = { pickup: str(loc.pickup, 500), delivery: str(loc.delivery, 500) };
    const pickupDate    = str(b.pickupDate, 20) || null;
    const mustDeliverBy = str(b.mustDeliverBy, 20) || null;
    const transportType = b.transportType === 'enclosed' ? 'enclosed' : 'open';
    const notes = str(b.notes, 2000) || null;

    let id = str(b.id, 20);
    if (!/^MC-[A-Z0-9-]{4,16}$/i.test(id)) id = 'MC-' + Date.now().toString().slice(-6);

    // Move base64 vehicle photos out of the request and into file storage
    try {
      await storeVehiclePhotos(vehicles, id);
    } catch (e) {
      console.error(`File storage error (${e.name}): ${e.message}`);
      return res.status(502).json({ success: false, message: `Photo storage is not working (${e.name || "error"}). Check the AWS S3 settings.` });
    }

    let total, distance, source, paymentStatus, stripePiId = null;
    if (isAdmin) {
      source = 'admin';
      paymentStatus = 'unpaid';
      total = Math.max(0, Math.round(Number(b.total) || 0));
      distance = Number(b.distance) > 0 ? Math.round(Number(b.distance)) : null;
    } else {
      const piId = str(b.stripePaymentIntentId, 64);
      if (!/^pi_[A-Za-z0-9]+$/.test(piId))
        return res.status(402).json({ success: false, message: 'Payment is required before an order can be created' });
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== 'succeeded' || !pi.metadata || pi.metadata.kind !== 'web_checkout')
        return res.status(402).json({ success: false, message: 'Payment has not been completed' });
      const [dupe] = await pool.execute('SELECT id FROM orders WHERE stripe_payment_intent_id = ?', [pi.id]);
      if (dupe.length)
        return res.status(409).json({ success: false, message: `This payment already belongs to order ${dupe[0].id}`, orderId: dupe[0].id });
      source = 'web';
      paymentStatus = 'paid';
      total = pi.amount_received / 100;
      distance = Number(pi.metadata.distance) > 0 ? Math.round(Number(pi.metadata.distance)) : null;
      stripePiId = pi.id;
    }

    // Link the order to a customer record (never fatal for the order itself)
    let customerId = isAdmin && b.customerId ? Number(b.customerId) : null;
    try {
      customerId = await upsertCustomer(pool, {
        id: customerId,
        name: contact.fullName, email: contact.email, phone: contact.phone,
        company: contact.company, type: contact.type, notes: isAdmin ? str(b.customerNotes, 2000) : ''
      }, isAdmin);
    } catch (e) {
      console.error('POST /api/orders customer upsert:', e.message);
    }

    // Pricing record: the engine's breakdown for this order (web: recomputed from the same inputs; admin: sent by the wizard)
    let pricingJson = null;
    try {
      if (isAdmin && b.pricing && typeof b.pricing === 'object') pricingJson = JSON.stringify({ lines: Array.isArray(b.pricing.lines) ? b.pricing.lines.slice(0, 30) : [], factors: b.pricing.factors || {}, cpm: b.pricing.cpm, quotedTotal: total });
      else if (!isAdmin) {
        const rec = await computeQuoteLive(vehicles, distance || 0, { transportType, pickupDate, mustDeliverBy, pickup: location.pickup, delivery: location.delivery, pickupLat: Number(loc.pickupLat), pickupLng: Number(loc.pickupLng), deliveryLat: Number(loc.deliveryLat), deliveryLng: Number(loc.deliveryLng) });
        pricingJson = JSON.stringify({ lines: rec.lines, factors: rec.factors, cpm: rec.cpm, quotedTotal: total });
      }
    } catch (e) { console.error('pricing record:', e.message); }

    // No-show / dry-run fee: admin can set it at quote time; otherwise the default applies
    const noShowFee = isAdmin && b.noShowFee != null && b.noShowFee !== '' && Number(b.noShowFee) >= 0
      ? Math.round(Number(b.noShowFee) * 100) / 100 : null;

    await pool.execute(
      `INSERT INTO orders
         (id, status, contact, vehicle, vehicles, location,
          pickup_date, must_deliver_by, transport_type, total,
          customer_id, source, payment_status, distance, notes, no_show_fee, pricing_json,
          stripe_payment_intent_id, charged_at, charged_amount, tracking_token, events_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        id, 'New',
        JSON.stringify(contact),
        JSON.stringify(vehicles[0]),
        JSON.stringify(vehicles),
        JSON.stringify(location),
        pickupDate, mustDeliverBy, transportType, total,
        customerId, source, paymentStatus, distance, notes, noShowFee, pricingJson,
        stripePiId, stripePiId ? new Date() : null, stripePiId ? total : null,
        crypto.randomBytes(24).toString('hex'),
        JSON.stringify([{ at: new Date().toISOString(), type: 'booked', note: isAdmin ? 'Order created by our team' : 'Booked and paid on mcships.com' }])
      ]
    );
    console.log(`New order: ${id}${isAdmin ? ' (admin intake)' : ` (web, ${money(total)} paid)`}`);
    res.json({ success: true, orderId: id, customerId, total });

    // Link the website quote this order came from (if any)
    const quoteToken = str(b.quoteToken, 64);
    if (/^[a-f0-9]{48}$/.test(quoteToken))
      pool.execute('UPDATE quotes SET order_id = ? WHERE token = ? AND order_id IS NULL', [id, quoteToken]).catch(() => {});

    // Website orders: receipt + tracking link to the customer, alert to the team
    if (!isAdmin && process.env.ADMIN_NOTIFY_EMAIL) {
      const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]).catch(() => [[]]);
      const order = rows && rows[0] ? mapOrderRow(rows[0], false) : null;
      if (order && contact.email) trackingUrl(rows[0], req).then(u => sendMail({ to: contact.email, ...bookingEmail(order, u) })).catch(e => console.error('booking mail:', e.message));
      if (order) sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `🚗 New website order ${id} – ${money(total)} paid – ${contact.fullName}`,
        html: emailShell(`<p><strong>${escHtml(contact.fullName)}</strong> just booked and paid <strong>${money(total)}</strong> on the website.</p>${summaryTableHtml(order)}<p><a href="${appUrl(req)}/admin/orders?open=${encodeURIComponent(id)}" style="background:#ff6a3d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Open order ${escHtml(id)}</a></p>`),
        text: `${contact.fullName} booked and paid ${money(total)} on the website.\n\n${summaryText(order)}\n\nOpen: ${appUrl(req)}/admin/orders?open=${encodeURIComponent(id)}`
      }).catch(e => console.error('new order notify mail:', e.message));
    }
  } catch (err) {
    console.error('POST /api/orders:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH update payment status (manual override for website orders)
app.patch('/api/orders/:id/payment', requireAdmin, async (req, res) => {
  const allowed = ['paid', 'unpaid'];
  const status = allowed.includes(req.body.paymentStatus) ? req.body.paymentStatus : null;
  if (!status) return res.status(400).json({ success: false, message: 'paymentStatus must be paid or unpaid' });
  try {
    const [result] = await pool.execute(
      'UPDATE orders SET payment_status = ? WHERE id = ?',
      [status, req.params.id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH payment:', err);
    res.status(500).json({ success: false });
  }
});

// PATCH update status
app.patch('/api/orders/:id/status', requireAdmin, async (req, res) => {
  const allowed = ORDER_STATUSES;
  if (!allowed.includes(req.body.status))
    return res.status(400).json({ success: false, message: 'Invalid status' });
  try {
    const [result] = await pool.execute(
      'UPDATE orders SET status = ? WHERE id = ?',
      [req.body.status, req.params.id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH status:', err);
    res.status(500).json({ success: false });
  }
});

// DELETE order
// Delete an order. If a card hold is still active it is released first (and the
// saved card removed) so nothing stays reserved on the customer's card.
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Not found' });
    let released = false;
    if (row.payment_status === 'authorized' && row.stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
        if (['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status)) {
          await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' });
          released = true;
        }
      } catch (e) { console.error(`delete order ${row.id}: release hold:`, e.message); }
    }
    if (row.stripe_payment_method_id) await detachCard(row).catch(() => {});
    await pool.execute('DELETE FROM orders WHERE id = ?', [row.id]);
    res.json({ success: true, released });
  } catch (err) {
    console.error('DELETE order:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ==================== PICKUP CONFIRMATION + CARD HOLD ====================
// Phone-in orders: admin emails the customer a link → the customer agrees to the
// pickup terms (incl. a no-show fee) and authorizes a card hold. The hold is a
// manual-capture PaymentIntent; the card is also saved for off-session use so
// the charge still works if the 7-day authorization window lapses.
// Admin then captures ("picked up"), charges the fee ("vehicle gone"), or releases.

const AGREEMENT_VERSION  = '2026-09-v2';
const DEFAULT_NO_SHOW_FEE = 150;
const HOLD_DAYS = 7; // hold + saved card lifetime (also the card-network authorization window)
const COMPANY_PHONE = '(502) 417-8040';

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function vehicleLabel(v) { return [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'; }
function orderVehicles(order) {
  return order.vehicles && order.vehicles.length ? order.vehicles : [order.vehicle || {}];
}
function orderFee(order) { return order.noShowFee != null ? order.noShowFee : DEFAULT_NO_SHOW_FEE; }

// The agreement the customer accepts. Keep AGREEMENT_VERSION in step with edits.
function agreementClauses(order) {
  const fee = money(orderFee(order));
  const total = money(order.total);
  return [
    `I authorize MC Transportation LLC ("MC") and its assigned carrier to pick up the vehicle(s) listed above from the pickup address on or after the first available pickup date, and to transport and deliver them to the delivery address.`,
    `I agree to pay MC the quoted amount of ${total} for this transport. By entering my card I authorize a temporary hold for ${total}. My card will only be charged once the vehicle(s) have been picked up.`,
    `I understand MC will dispatch a carrier and a truck will be sent to the pickup location. If the vehicle(s) are not available when the carrier arrives — including because they were released to another transport company, sold, or moved — or if I cancel with less than 24 hours' notice, I agree to pay a no-show / dry-run fee of ${fee}, which MC may charge to the card on file.`,
    `I confirm that I am the owner of the vehicle(s) or am authorized by the owner to arrange this transport, and that the vehicle, address, and contact details above are accurate.`,
    `I authorize MC to keep my payment method securely on file with its payment processor (Stripe) for up to ${HOLD_DAYS} days for this pickup, and to charge it for the amounts described above without further action on my part. After ${HOLD_DAYS} days, or once the transport or fee has been charged, my card details are removed automatically.`
  ];
}

// Remove the saved card from Stripe and clear it on the order (best effort)
async function detachCard(row) {
  if (row.stripe_payment_method_id) {
    try { await stripe.paymentMethods.detach(row.stripe_payment_method_id); }
    catch (e) { console.error(`detach card for ${row.id}:`, e.message); }
  }
  await pool.execute('UPDATE orders SET stripe_payment_method_id = NULL WHERE id = ?', [row.id]);
}

// Housekeeping: a hold and its saved card live for HOLD_DAYS. After that the
// authorization is cancelled, the card is deleted from Stripe, and the order is
// marked 'expired' so admin knows to send a fresh confirmation. Runs at boot and hourly.
async function expireCardHolds() {
  const [rows] = await pool.execute(
    `SELECT * FROM orders
      WHERE payment_status = 'authorized' AND hold_expires_at IS NOT NULL AND hold_expires_at < NOW()`
  );
  for (const row of rows) {
    try {
      if (row.stripe_payment_intent_id) {
        try {
          const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
          if (pi.status === 'requires_capture') await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'abandoned' });
        } catch (e) { console.error(`expire hold ${row.id}: cancel:`, e.message); }
      }
      await detachCard(row);
      await pool.execute(
        "UPDATE orders SET payment_status = 'expired', hold_amount = NULL WHERE id = ? AND payment_status = 'authorized'",
        [row.id]
      );
      console.log(`⏰ Card hold expired for order ${row.id} — card removed`);

      if (process.env.ADMIN_NOTIFY_EMAIL) {
        const order = mapOrderRow(row, false);
        const name = (order.contact || {}).fullName || 'the customer';
        sendMail({
          to: process.env.ADMIN_NOTIFY_EMAIL,
          subject: `⏰ Card hold expired – order ${order.id}`,
          html: emailShell(`<p>The ${HOLD_DAYS}-day card hold for <strong>${escHtml(name)}</strong> (order ${escHtml(order.id)}) expired before pickup. The card was removed automatically.</p><p>If the pickup is still on, open the order in the admin panel and send a new confirmation.</p>${summaryTableHtml(order)}`),
          text: `The ${HOLD_DAYS}-day card hold for ${name} (order ${order.id}) expired before pickup and the card was removed. Send a new confirmation if the pickup is still on.`
        }).catch(e => console.error('expire notify mail:', e.message));
      }
    } catch (e) {
      console.error(`expireCardHolds ${row.id}:`, e.message);
    }
  }
  return rows.length;
}

async function findOrderByToken(token) {
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  const [rows] = await pool.execute('SELECT * FROM orders WHERE confirm_token = ?', [token]);
  return rows.length ? rows[0] : null;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || null;
}

// ---- Email templates ----
function emailShell(bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:Inter,Arial,Helvetica,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden">
  <tr><td style="background:#0D1117;padding:20px 28px;color:#ffffff;font-weight:700;font-size:18px">
    MC <span style="color:#FF6A3D">&bull;</span> <span style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#8B949E">Transportation</span>
  </td></tr>
  <tr><td style="padding:28px;color:#111827;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
  <tr><td style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px">MC Transportation LLC &middot; Louisville, KY &middot; ${COMPANY_PHONE}</td></tr>
</table></td></tr></table></body></html>`;
}

function orderSummaryRows(order) {
  const loc = order.location || {};
  const vehicles = orderVehicles(order).map(v =>
    escHtml(vehicleLabel(v)) + (v.type ? ' &middot; ' + escHtml(v.type) : '') + (v.condition === 'inoperable' ? ' &middot; inoperable' : ''));
  return [
    ['Order', escHtml(order.id)],
    ['Vehicle' + (vehicles.length > 1 ? 's' : ''), vehicles.join('<br>')],
    ['Pickup', escHtml(loc.pickup || '—')],
    ['Delivery', escHtml(loc.delivery || '—')],
    ['First available pickup', escHtml(order.pickupDate || '—')],
    ['Must deliver by', escHtml(order.mustDeliverBy || '—')],
    ['Transport', escHtml(order.transportType || 'open')],
    ['Quoted price', `<strong>${money(order.total)}</strong>`],
    ['No-show / dry-run fee', money(orderFee(order))],
  ];
}
function summaryTableHtml(order) {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:18px 0">` +
    orderSummaryRows(order).map(([k, v]) =>
      `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f3f4f6">${k}</td>` +
      `<td style="padding:8px 12px;color:#111827;font-size:14px;border-bottom:1px solid #f3f4f6">${v}</td></tr>`).join('') +
    `</table>`;
}
function summaryText(order) {
  return orderSummaryRows(order).map(([k, v]) => `${k}: ${v.replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&amp;/g, '&')}`).join('\n');
}

function confirmationEmail(order, link) {
  const name = (order.contact || {}).fullName || 'there';
  const total = money(order.total);
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Please confirm your vehicle pickup</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Thanks for calling MC Transportation. Here is the transport we discussed. Please review the details, read the pickup agreement, and enter a card to authorize a hold of <strong>${total}</strong>. <strong>You will not be charged until your vehicle is picked up.</strong></p>
    ${summaryTableHtml(order)}
    <p style="text-align:center;margin:26px 0">
      <a href="${escHtml(link)}" style="display:inline-block;background:#FF6A3D;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px">Review &amp; Confirm Pickup</a>
    </p>
    <p style="font-size:13px;color:#6b7280">Or copy this link into your browser:<br><a href="${escHtml(link)}" style="color:#2563eb;word-break:break-all">${escHtml(link)}</a></p>
    <p style="font-size:13px;color:#6b7280">Questions? Reply to this email or call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nThanks for calling MC Transportation. Please review the transport below, read the pickup agreement, and authorize a card hold of ${total}. You will not be charged until your vehicle is picked up.\n\n${summaryText(order)}\n\nReview & confirm here:\n${link}\n\nQuestions? Call ${COMPANY_PHONE}.`;
  return { subject: `Please confirm your vehicle pickup – order ${order.id}`, html, text };
}

function trackButton(url, label) {
  return url ? `<p style="text-align:center;margin:22px 0"><a href="${url}" style="display:inline-block;background:#FF6A3D;color:#ffffff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:8px">${label || 'Track your shipment'}</a></p>` : '';
}
function bookingEmail(order, trackUrl) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Booking received</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Thanks for booking with Mcships. We're assigning a carrier now and will email you the driver's details and pickup window as soon as it's set.</p>
    ${summaryTableHtml(order)}
    ${trackButton(trackUrl)}
    <p style="font-size:13px;color:#6b7280">Keep this link: it shows every update on your shipment, the driver's contact once assigned, and your Bill of Lading after pickup. Questions? Call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nThanks for booking with Mcships. We'll email the driver's details and pickup window once assigned.\n\n${summaryText(order)}\n\nTrack your shipment: ${trackUrl}\n\nQuestions? Call ${COMPANY_PHONE}.`;
  return { subject: `Booking received – order ${order.id}`, html, text };
}
function dispatchEmail(order, trackUrl) {
  const d = order.dispatch || {}, name = (order.contact || {}).fullName || 'there';
  const rows = [['Carrier', d.carrierName], ['Driver', d.driverName], ['Driver phone', d.driverPhone], ['Pickup window', d.pickupEta], ['Delivery window', d.deliveryEta]].filter(r => r[1]);
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Your carrier is assigned</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Good news: a carrier has been assigned to move your ${escHtml(vehicleLabel(orderVehicles(order)[0] || {}))} (order ${escHtml(order.id)}).</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:18px 0">${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;white-space:nowrap;border-bottom:1px solid #f3f4f6">${k}</td><td style="padding:8px 12px;color:#111827;font-size:14px;border-bottom:1px solid #f3f4f6">${escHtml(v)}</td></tr>`).join('')}</table>
    ${d.notes ? `<p style="font-size:14px"><strong>Note from us:</strong> ${escHtml(d.notes)}</p>` : ''}
    <p style="font-size:14px">Please have the keys ready and make sure the vehicle is accessible. The driver will call ahead before arriving.</p>
    ${trackButton(trackUrl)}
    <p style="font-size:13px;color:#6b7280">Questions? Reply to this email or call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nA carrier has been assigned to order ${order.id}.\n${rows.map(([k, v]) => k + ': ' + v).join('\n')}${d.notes ? '\nNote: ' + d.notes : ''}\n\nTrack: ${trackUrl}\n\nQuestions? Call ${COMPANY_PHONE}.`;
  return { subject: `Carrier assigned – order ${order.id}`, html, text };
}
function pickedUpEmail(order, trackUrl) {
  const name = (order.contact || {}).fullName || 'there', d = order.dispatch || {};
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Your vehicle is on its way</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Your ${escHtml(vehicleLabel(orderVehicles(order)[0] || {}))} has been picked up and is heading to ${escHtml((order.location || {}).delivery || 'the delivery address')}.${d.deliveryEta ? ` Expected delivery: <strong>${escHtml(d.deliveryEta)}</strong>.` : ''}</p>
    <p style="font-size:14px">The card on file has been charged ${money(order.chargedAmount || order.total)}. At delivery, walk around the vehicle with the driver and note anything on the Bill of Lading before signing.</p>
    ${trackButton(trackUrl)}
    <p style="font-size:13px;color:#6b7280">Questions? Call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nYour vehicle has been picked up (order ${order.id}).${d.deliveryEta ? ' Expected delivery: ' + d.deliveryEta + '.' : ''}\n\nTrack: ${trackUrl}\n\nQuestions? Call ${COMPANY_PHONE}.`;
  return { subject: `Picked up – order ${order.id}`, html, text };
}
function updateEmail(order, note, trackUrl) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Shipment update</h1>
    <p>Hi ${escHtml(name)},</p>
    <p style="font-size:16px;padding:14px 16px;background:#f9fafb;border-left:4px solid #FF6A3D;border-radius:6px">${escHtml(note)}</p>
    ${trackButton(trackUrl)}
    <p style="font-size:13px;color:#6b7280">Order ${escHtml(order.id)}. Questions? Call ${COMPANY_PHONE}.</p>`);
  return { subject: `Update on your shipment – order ${order.id}`, html, text: `Hi ${name},\n\n${note}\n\nTrack: ${trackUrl}\n\nOrder ${order.id}. Questions? Call ${COMPANY_PHONE}.` };
}
function deliveredEmail(order, trackUrl) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Delivered</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Your ${escHtml(vehicleLabel(orderVehicles(order)[0] || {}))} has been delivered. Thank you for shipping with Mcships.</p>
    <p style="font-size:14px">Your signed Bill of Lading and delivery photos are on your tracking page. If anything about the delivery isn't right, call us within 24 hours so we can help.</p>
    ${trackButton(trackUrl, 'View delivery details')}
    <p style="font-size:13px;color:#6b7280">Order ${escHtml(order.id)} · ${COMPANY_PHONE}</p>`);
  return { subject: `Delivered – order ${order.id}`, html, text: `Hi ${name},\n\nYour vehicle has been delivered (order ${order.id}). Thank you for shipping with Mcships.\n\nDelivery details: ${trackUrl}\n\n${COMPANY_PHONE}` };
}
function reviewEmail(order, reviewUrl) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">How did we do?</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Your ${escHtml(vehicleLabel(orderVehicles(order)[0] || {}))} was delivered yesterday. We'd really appreciate a quick review: it takes a minute and helps other people find a transporter they can trust.</p>
    ${reviewUrl ? trackButton(reviewUrl, 'Leave a review') : '<p style="font-size:14px">Just reply to this email and tell us how it went.</p>'}
    <p style="font-size:13px;color:#6b7280">If something wasn't right, reply here first and we'll make it right. Thank you, from the Mcships team. ${COMPANY_PHONE}</p>`);
  return { subject: `How did we do? – order ${order.id}`, html, text: `Hi ${name},\n\nYour vehicle was delivered yesterday. We'd appreciate a quick review${reviewUrl ? ': ' + reviewUrl : ' - just reply to this email'}.\n\nIf something wasn't right, reply here first. Thank you, the Mcships team. ${COMPANY_PHONE}` };
}
function receiptEmail(order, holdAmount, trackUrl) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">You're confirmed</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Thank you — your pickup is confirmed. A temporary hold of <strong>${money(holdAmount)}</strong> has been placed on your card. <strong>You will only be charged once the vehicle is picked up.</strong></p>
    ${summaryTableHtml(order)}
    ${trackButton(trackUrl)}
    <p style="font-size:13px;color:#6b7280">Reminder: if the vehicle is not available when our carrier arrives, or the pickup is cancelled with less than 24 hours' notice, the no-show fee of ${money(orderFee(order))} applies as agreed.</p>
    <p style="font-size:13px;color:#6b7280">Need to change anything? Call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nYour pickup is confirmed. A temporary hold of ${money(holdAmount)} has been placed on your card. You will only be charged once the vehicle is picked up.\n\n${summaryText(order)}\n\n${trackUrl ? 'Track your shipment: ' + trackUrl + '\n\n' : ''}Questions? Call ${COMPANY_PHONE}.`;
  return { subject: `Pickup confirmed – order ${order.id}`, html, text };
}

// ---- Public: confirmation page ----
app.get('/confirm/:token', publicLimiter, async (req, res) => {
  try {
    const row = await findOrderByToken(req.params.token);
    if (!row) {
      return res.status(404).render('confirm', { notFound: true, order: null, clauses: [], stripePk: '', token: '', money, phone: COMPANY_PHONE });
    }
    const order = mapOrderRow(row, false);
    res.render('confirm', {
      notFound: false, order, clauses: agreementClauses(order),
      stripePk: process.env.STRIPE_PUBLISHABLE_KEY || '', token: req.params.token, money, phone: COMPANY_PHONE
    });
  } catch (err) {
    console.error('GET /confirm/:token:', err);
    res.status(500).render('404');
  }
});

// ---- Public: customer agreed → create the hold PaymentIntent ----
app.post('/api/confirm/:token/agree', publicLimiter, async (req, res) => {
  const { agreedName, agreed } = req.body;
  if (!agreed || !agreedName || !String(agreedName).trim())
    return res.status(400).json({ success: false, message: 'Please type your full name and accept the agreement' });
  try {
    const row = await findOrderByToken(req.params.token);
    if (!row) return res.status(404).json({ success: false, message: 'This confirmation link is not valid' });
    const order = mapOrderRow(row, false);
    if (['authorized', 'paid', 'fee_charged'].includes(order.paymentStatus))
      return res.status(409).json({ success: false, message: 'This order has already been confirmed', alreadyConfirmed: true });

    const amountCents = Math.round(Number(order.total) * 100);
    if (!(amountCents >= 50))
      return res.status(400).json({ success: false, message: 'The order amount is not valid for a card hold' });

    // One Stripe customer per order (reused for the fee / late charge)
    let stripeCustomerId = row.stripe_customer_id;
    if (!stripeCustomerId) {
      const c = order.contact || {};
      const cust = await stripe.customers.create({
        name    : c.fullName || String(agreedName).trim(),
        email   : c.email || undefined,
        phone   : c.phone || undefined,
        metadata: { orderId: order.id, mcCustomerId: order.customerId ? String(order.customerId) : '' }
      });
      stripeCustomerId = cust.id;
    }

    const pi = await stripe.paymentIntents.create({
      amount              : amountCents,
      currency            : 'usd',
      customer            : stripeCustomerId,
      capture_method      : 'manual',          // hold now, charge at pickup
      setup_future_usage  : 'off_session',     // keep the card for the fee / after the hold lapses
      payment_method_types: ['card'],
      description         : `Mcships – pickup authorization for order ${order.id}`,
      metadata            : { orderId: order.id, kind: 'pickup_hold', agreementVersion: AGREEMENT_VERSION }
    });

    // Proof of agreement: exactly what the customer saw and accepted, frozen at this moment
    const signedName = String(agreedName).trim().slice(0, 255);
    const agreement = {
      version     : AGREEMENT_VERSION,
      agreedAt    : new Date().toISOString(),
      agreedName  : signedName,
      ip          : clientIp(req),
      userAgent   : str(req.headers['user-agent'], 300) || null,
      amount      : order.total,
      noShowFee   : orderFee(order),
      clauses     : agreementClauses(order),
      order       : {
        id: order.id, contact: order.contact, location: order.location,
        pickupDate: order.pickupDate, mustDeliverBy: order.mustDeliverBy, transportType: order.transportType,
        vehicles: (order.vehicles || (order.vehicle ? [order.vehicle] : [])).map(v => ({ year: v.year, make: v.make, model: v.model, vin: v.vin, type: v.type, condition: v.condition }))
      },
      stripe      : { customerId: stripeCustomerId, paymentIntentId: pi.id }
    };
    await pool.execute(
      `UPDATE orders SET stripe_customer_id = ?, stripe_payment_intent_id = ?,
              agreed_name = ?, agreed_ip = ?, agreed_at = NOW(), agreement_json = ?
       WHERE id = ?`,
      [stripeCustomerId, pi.id, signedName, clientIp(req), JSON.stringify(agreement), order.id]
    );
    res.json({ success: true, clientSecret: pi.client_secret, paymentIntentId: pi.id });
  } catch (err) {
    console.error('POST /api/confirm/:token/agree:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Public: card authorized on the client → verify with Stripe and record the hold ----
app.post('/api/confirm/:token/complete', publicLimiter, async (req, res) => {
  try {
    const row = await findOrderByToken(req.params.token);
    if (!row) return res.status(404).json({ success: false, message: 'This confirmation link is not valid' });
    const piId = req.body.paymentIntentId || row.stripe_payment_intent_id;
    if (!piId) return res.status(400).json({ success: false, message: 'No payment authorization to verify' });

    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['payment_method'] });
    if (!pi.metadata || pi.metadata.orderId !== row.id)
      return res.status(400).json({ success: false, message: 'Payment does not belong to this order' });
    if (pi.status !== 'requires_capture')
      return res.status(400).json({ success: false, message: `Card authorization not completed (status: ${pi.status})` });

    const paymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method && pi.payment_method.id) || null;
    const holdExpires = new Date(pi.created * 1000 + HOLD_DAYS * 86400000);
    // Add the card + authorization details to the signed-agreement record
    const card = pi.payment_method && pi.payment_method.card ? pi.payment_method.card : null;
    const agreement = safeJson(row.agreement_json) || {};
    agreement.authorization = {
      authorizedAt: new Date().toISOString(), paymentIntentId: pi.id, amount: pi.amount / 100,
      holdExpiresAt: holdExpires.toISOString(),
      card: card ? { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year, funding: card.funding } : null
    };
    await pool.execute(
      `UPDATE orders SET payment_status = 'authorized', stripe_payment_intent_id = ?,
              stripe_payment_method_id = ?, hold_amount = ?, hold_expires_at = ?, agreement_json = ?
       WHERE id = ?`,
      [pi.id, paymentMethodId, pi.amount / 100, holdExpires, JSON.stringify(agreement), row.id]
    );

    // Best-effort notifications (never fail the confirmation because of email)
    const order = mapOrderRow(row, false);
    const c = order.contact || {};
    try {
      await addOrderEvent(row.id, 'confirmed', 'Pickup terms accepted and card authorized');
      if (c.email) await sendMail({ to: c.email, ...receiptEmail(order, pi.amount / 100, await trackingUrl(row, req)) });
      if (process.env.ADMIN_NOTIFY_EMAIL) {
        await sendMail({
          to: process.env.ADMIN_NOTIFY_EMAIL,
          subject: `✅ ${c.fullName || 'Customer'} confirmed pickup – order ${order.id}`,
          html: emailShell(`<p><strong>${escHtml(c.fullName || 'Customer')}</strong> agreed to the pickup terms and authorized a hold of <strong>${money(pi.amount / 100)}</strong> for order ${escHtml(order.id)}.</p>${summaryTableHtml(order)}<p>Open the admin panel to mark it picked up when the carrier has the vehicle.</p>`),
          text: `${c.fullName || 'Customer'} confirmed pickup for order ${order.id} (hold ${money(pi.amount / 100)}).\n\n${summaryText(order)}`
        });
      }
    } catch (e) { console.error('confirmation notification mail:', e.message); }

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/confirm/:token/complete:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

async function loadOrderRow(id) {
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [id]);
  return rows.length ? rows[0] : null;
}
function stripeErrorStatus(err) { return err && err.type === 'StripeCardError' ? 402 : 500; }

// ---- Admin: send (or re-send) the confirmation email; the link is returned either way ----
app.post('/api/orders/:id/send-confirmation', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['authorized', 'paid', 'fee_charged'].includes(row.payment_status))
      return res.status(409).json({ success: false, message: 'This order is already confirmed' });

    const feeInput = req.body.noShowFee;
    const fee = feeInput != null && feeInput !== ''
      ? Number(feeInput)
      : (row.no_show_fee != null ? Number(row.no_show_fee) : DEFAULT_NO_SHOW_FEE);
    if (!(fee >= 0)) return res.status(400).json({ success: false, message: 'Invalid no-show fee' });

    const token = row.confirm_token || crypto.randomBytes(24).toString('hex');
    const link  = `${appUrl(req)}/confirm/${token}`;

    await pool.execute(
      `UPDATE orders SET confirm_token = ?, no_show_fee = ?, confirm_sent_at = NOW(),
              payment_status = CASE WHEN payment_status IN ('unpaid','confirmation_sent','released','expired')
                                    THEN 'confirmation_sent' ELSE payment_status END
       WHERE id = ?`,
      [token, fee, row.id]
    );

    const order = mapOrderRow({ ...row, confirm_token: token, no_show_fee: fee }, false);
    const email = (order.contact || {}).email;
    let mail = { sent: false, reason: 'The order has no customer email — copy the link and send it yourself' };
    if (email) {
      try { mail = await sendMail({ to: email, ...confirmationEmail(order, link) }); }
      catch (e) { console.error('send-confirmation mail:', e); mail = { sent: false, reason: e.message }; }
    }
    let sms = { sent: false };
    if (req.body && req.body.sms && (order.contact || {}).phone) sms = await sendSms(order.contact.phone, smsText('confirm', order, { link }), order.id);
    res.json({ success: true, link, emailSent: mail.sent, emailError: mail.sent ? null : mail.reason, sentTo: email || null, smsSent: sms.sent, smsError: sms.sent ? null : (sms.reason || null) });
  } catch (err) {
    console.error('POST /api/orders/:id/send-confirmation:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Admin: vehicle picked up → capture the hold (or charge the saved card if the hold lapsed) ----
app.post('/api/orders/:id/pickup', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (row.payment_status !== 'authorized')
      return res.status(409).json({ success: false, message: `Order payment status is "${row.payment_status}", not "authorized"` });
    // Optional custom amount (e.g. a partial charge) — never more than what was held
    const requested = req.body && req.body.amount != null && req.body.amount !== '' ? Number(req.body.amount) : null;
    if (requested != null && !(requested > 0)) return res.status(400).json({ success: false, message: 'Invalid charge amount' });
    const heldAmount = row.hold_amount != null ? Number(row.hold_amount) : Number(row.total);
    if (requested != null && requested > heldAmount + 0.005)
      return res.status(400).json({ success: false, message: `You can charge up to $${heldAmount.toFixed(2)} (the amount on hold)` });
    const amountCents = Math.round((requested != null ? requested : Number(row.total)) * 100);
    if (amountCents < 50) return res.status(400).json({ success: false, message: 'Charge amount is too small' });

    let charged = null; // { piId, amount, how }
    if (row.stripe_payment_intent_id) {
      const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
      if (pi.status === 'requires_capture') {
        const captured = await stripe.paymentIntents.capture(pi.id, { amount_to_capture: Math.min(amountCents, pi.amount) });
        charged = { piId: captured.id, amount: captured.amount_received / 100, how: 'captured' };
      } else if (pi.status === 'succeeded') {
        charged = { piId: pi.id, amount: pi.amount_received / 100, how: 'already_captured' };
      }
    }
    if (!charged) {
      // Hold expired/cancelled → charge the card on file
      if (!row.stripe_customer_id || !row.stripe_payment_method_id)
        return res.status(409).json({ success: false, message: 'The card hold has expired and no card is on file. Send a new confirmation to the customer.' });
      const pi = await stripe.paymentIntents.create({
        amount: amountCents, currency: 'usd',
        customer: row.stripe_customer_id, payment_method: row.stripe_payment_method_id,
        off_session: true, confirm: true,
        description: `Mcships – vehicle transport, order ${row.id}`,
        metadata: { orderId: row.id, kind: 'pickup_charge' }
      });
      if (pi.status !== 'succeeded')
        return res.status(402).json({ success: false, message: `Charge not completed (status: ${pi.status})` });
      charged = { piId: pi.id, amount: pi.amount_received / 100, how: 'charged_saved_card' };
    }

    await pool.execute(
      `UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = ?,
              charged_at = NOW(), charged_amount = ?, picked_up_at = COALESCE(picked_up_at, NOW()),
              status = CASE WHEN status = 'New' THEN 'In Work' ELSE status END
       WHERE id = ?`,
      [charged.piId, charged.amount, row.id]
    );
    await detachCard(row); // charged — no reason to keep the card
    res.json({ success: true, ...charged });
    try {
      await addOrderEvent(row.id, 'picked_up', 'Vehicle picked up by the carrier');
      const fresh = await loadOrderRow(row.id); const o = mapOrderRow(fresh, false); const c = o.contact || {};
      const tUrl = await trackingUrl(fresh, req);
      if (c.email) await sendMail({ to: c.email, ...pickedUpEmail(o, tUrl) });
      if (c.phone && smsConfigured()) await sendSms(c.phone, smsText('picked_up', o, { track: tUrl }), o.id);
    } catch (e) { console.error('pickup notice:', e.message); }
  } catch (err) {
    console.error('POST /api/orders/:id/pickup:', err);
    res.status(stripeErrorStatus(err)).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Admin: vehicle gone / no-show → release the hold and charge the no-show fee ----
app.post('/api/orders/:id/charge-fee', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (row.payment_status !== 'authorized')
      return res.status(409).json({ success: false, message: `Order payment status is "${row.payment_status}" — the fee can only be charged while the customer's card hold is active` });
    if (!row.stripe_customer_id || !row.stripe_payment_method_id)
      return res.status(409).json({ success: false, message: 'No card on file for this order' });

    const amtInput = req.body.amount;
    const fee = amtInput != null && amtInput !== ''
      ? Number(amtInput)
      : (row.no_show_fee != null ? Number(row.no_show_fee) : DEFAULT_NO_SHOW_FEE);
    if (!(fee > 0)) return res.status(400).json({ success: false, message: 'Invalid fee amount' });

    // Charge the fee first; if the card declines, the transport hold stays intact
    // so admin can retry, capture instead, or release manually.
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(fee * 100), currency: 'usd',
      customer: row.stripe_customer_id, payment_method: row.stripe_payment_method_id,
      off_session: true, confirm: true,
      description: `Mcships – no-show / dry-run fee, order ${row.id}`,
      metadata: { orderId: row.id, kind: 'no_show_fee' }
    });
    if (pi.status !== 'succeeded')
      return res.status(402).json({ success: false, message: `Fee charge not completed (status: ${pi.status})` });

    // Fee collected → release the transport hold
    if (row.stripe_payment_intent_id) {
      try {
        const hold = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
        if (hold.status === 'requires_capture') await stripe.paymentIntents.cancel(hold.id, { cancellation_reason: 'abandoned' });
      } catch (e) { console.error('release hold after fee:', e.message); }
    }

    await pool.execute(
      `UPDATE orders SET payment_status = 'fee_charged', fee_payment_intent_id = ?,
              charged_at = NOW(), charged_amount = ?, hold_amount = NULL, hold_expires_at = NULL,
              status = 'Canceled'
       WHERE id = ?`,
      [pi.id, fee, row.id]
    );
    await detachCard(row);
    res.json({ success: true, amount: fee, piId: pi.id });
  } catch (err) {
    console.error('POST /api/orders/:id/charge-fee:', err);
    res.status(stripeErrorStatus(err)).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Admin: release the hold without charging (card is removed too) ----
app.post('/api/orders/:id/release-hold', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (row.payment_status !== 'authorized')
      return res.status(409).json({ success: false, message: 'There is no active hold on this order' });
    if (row.stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
        if (['requires_capture', 'requires_payment_method', 'requires_confirmation', 'requires_action', 'processing'].includes(pi.status))
          await stripe.paymentIntents.cancel(pi.id, { cancellation_reason: 'requested_by_customer' });
      } catch (e) { console.error('release hold:', e.message); }
    }
    await pool.execute(
      "UPDATE orders SET payment_status = 'released', hold_amount = NULL, hold_expires_at = NULL WHERE id = ?",
      [row.id]
    );
    await detachCard(row); // deal is off — don't keep the card
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/orders/:id/release-hold:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Admin: change the quoted price before any card is on hold ----
app.patch('/api/orders/:id/price', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['authorized', 'paid', 'fee_charged'].includes(row.payment_status))
      return res.status(409).json({ success: false, message: 'The price is locked once a card hold or charge exists. Release the hold first, then change the price and send a new confirmation.' });
    const total = Math.round(Number(req.body.total));
    if (!(total >= 0) || total > 1000000) return res.status(400).json({ success: false, message: 'Enter a valid price' });
    const reason = str(req.body.reason, 200);
    const old = Number(row.total);
    if (total === old) return res.json({ success: true, total });
    const line = `Price changed: $${old.toLocaleString()} → $${total.toLocaleString()}${reason ? ' — ' + reason : ''} (${new Date().toLocaleDateString('en-US')})`;
    await pool.execute(
      `UPDATE orders SET total = ?, notes = CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE '\n' END, ?) WHERE id = ?`,
      [total, line, row.id]
    );
    res.json({ success: true, total, previous: old });
  } catch (err) {
    console.error('PATCH /api/orders/:id/price:', err);
    res.status(500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Admin: refund part or all of what was charged (transport charge or no-show fee) ----
app.post('/api/orders/:id/refund', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['paid', 'fee_charged'].includes(row.payment_status))
      return res.status(409).json({ success: false, message: 'Nothing has been charged on this order yet' });
    const piId = row.payment_status === 'fee_charged' ? row.fee_payment_intent_id : row.stripe_payment_intent_id;
    if (!piId) return res.status(409).json({ success: false, message: 'No Stripe payment is linked to this order, so it cannot be refunded here' });

    const charged = row.charged_amount != null ? Number(row.charged_amount) : Number(row.total);
    const alreadyRefunded = Number(row.refunded_amount) || 0;
    const remaining = Math.round((charged - alreadyRefunded) * 100) / 100;
    if (remaining <= 0) return res.status(409).json({ success: false, message: 'This order is already fully refunded' });

    const requested = req.body && req.body.amount != null && req.body.amount !== '' ? Number(req.body.amount) : remaining;
    if (!(requested > 0)) return res.status(400).json({ success: false, message: 'Invalid refund amount' });
    if (requested > remaining + 0.005)
      return res.status(400).json({ success: false, message: `You can refund up to $${remaining.toFixed(2)}` });
    const amountCents = Math.round(requested * 100);
    const reason = str(req.body.reason, 200) || null;

    const refund = await stripe.refunds.create({
      payment_intent: piId, amount: amountCents,
      metadata: { orderId: row.id, reason: reason || '' }
    });
    if (refund.status && !['succeeded', 'pending'].includes(refund.status))
      return res.status(402).json({ success: false, message: `Refund not completed (status: ${refund.status})` });

    const newTotal = Math.round((alreadyRefunded + amountCents / 100) * 100) / 100;
    await pool.execute(
      `UPDATE orders SET refunded_amount = ?, refunded_at = NOW(),
              notes = CASE WHEN ? IS NULL THEN notes ELSE CONCAT(COALESCE(notes, ''), CASE WHEN notes IS NULL OR notes = '' THEN '' ELSE '\n' END, ?) END
       WHERE id = ?`,
      [newTotal, reason, reason ? `Refund $${(amountCents / 100).toFixed(2)}: ${reason}` : null, row.id]
    );
    res.json({ success: true, refundId: refund.id, amount: amountCents / 100, refundedTotal: newTotal, remaining: Math.round((charged - newTotal) * 100) / 100 });
  } catch (err) {
    console.error('POST /api/orders/:id/refund:', err);
    res.status(stripeErrorStatus(err)).json({ success: false, message: err.message || 'Server error' });
  }
});

// ---- Dispatch: carrier / driver / windows on the order, documents, updates, delivered ----
app.patch('/api/orders/:id/dispatch', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    const b = req.body || {}; const s = (v, n) => v == null ? '' : String(v).trim().slice(0, n);
    const d = { carrierName: s(b.carrierName, 255), carrierPhone: s(b.carrierPhone, 40), driverName: s(b.driverName, 255), driverPhone: s(b.driverPhone, 40), pickupEta: s(b.pickupEta, 80), deliveryEta: s(b.deliveryEta, 80), notes: s(b.notes, 2000) };
    const firstAssign = !row.dispatched_at && (d.carrierName || d.driverName);
    await pool.execute(`UPDATE orders SET carrier_name = ?, carrier_phone = ?, driver_name = ?, driver_phone = ?, pickup_eta = ?, delivery_eta = ?, dispatch_notes = ?,
        dispatched_at = ${firstAssign ? 'NOW()' : 'dispatched_at'}, status = CASE WHEN status = 'New' AND ? THEN 'In Work' ELSE status END WHERE id = ?`,
      [d.carrierName || null, d.carrierPhone || null, d.driverName || null, d.driverPhone || null, d.pickupEta || null, d.deliveryEta || null, d.notes || null, firstAssign ? 1 : 0, row.id]);
    if (firstAssign) await addOrderEvent(row.id, 'dispatched', `Carrier assigned${d.carrierName ? ': ' + d.carrierName : ''}${d.pickupEta ? ' · pickup ' + d.pickupEta : ''}`);
    let emailed = false;
    const fresh = await loadOrderRow(row.id); const o = mapOrderRow(fresh, false); const c = o.contact || {};
    let texted = false;
    if (b.notify) {
      const tUrl = await trackingUrl(fresh, req);
      if (c.email) { const m = await sendMail({ to: c.email, ...dispatchEmail(o, tUrl) }).catch(e => ({ sent: false, reason: e.message })); emailed = !!m.sent; }
      if (c.phone && b.sms !== false && smsConfigured()) texted = (await sendSms(c.phone, smsText('dispatch', o, { track: tUrl }), o.id)).sent;
      if (emailed || texted) await addOrderEvent(row.id, 'update', `Carrier details ${[emailed ? 'emailed' : '', texted ? 'texted' : ''].filter(Boolean).join(' and ')} to the customer`);
    }
    res.json({ success: true, emailed, texted, order: mapOrderRow(await loadOrderRow(row.id), false) });
  } catch (err) { console.error('PATCH /api/orders/:id/dispatch:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
// Post a plain-language update to the timeline ("Truck is in Amarillo, delivery Thursday"), optionally emailed
app.post('/api/orders/:id/update', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    const note = String((req.body || {}).note || '').trim().slice(0, 500);
    if (!note) return res.status(400).json({ success: false, message: 'Write the update first' });
    await addOrderEvent(row.id, 'update', note);
    let emailed = false;
    const o = mapOrderRow(row, false); const c = o.contact || {};
    let texted = false;
    const tUrl = (req.body.notify || req.body.sms) ? await trackingUrl(row, req) : '';
    if (req.body.notify && c.email) { const m = await sendMail({ to: c.email, ...updateEmail(o, note, tUrl) }).catch(e => ({ sent: false })); emailed = !!m.sent; }
    if (req.body.sms && c.phone) texted = (await sendSms(c.phone, smsText('update', o, { note, track: tUrl }), o.id)).sent;
    res.json({ success: true, emailed, texted, order: mapOrderRow(await loadOrderRow(row.id), false) });
  } catch (err) { console.error('POST /api/orders/:id/update:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
// Documents: BOL (documents/bols), pickup/delivery photos (uploads/<order>), anything else (documents/attachments)
const DOC_KINDS = { bol: 'bol', pickup: 'pickup', delivery: 'delivery', other: 'other' };
app.post('/api/orders/:id/documents', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    const kind = DOC_KINDS[(req.body || {}).kind] || 'other';
    const files = Array.isArray(req.body.files) ? req.body.files.slice(0, 12) : [];
    if (!files.length) return res.status(400).json({ success: false, message: 'No files' });
    const folder = kind === 'bol' ? FILE_FOLDERS.bols : (kind === 'pickup' || kind === 'delivery') ? `${FILE_FOLDERS.photos}/${safeSegment(row.id)}` : FILE_FOLDERS.attachments;
    const docs = safeJson(row.documents_json) || [];
    let added = 0;
    for (const f of files) {
      const stored = await storeBase64Upload(f && f.data, folder, `${row.id}-${kind}`);
      if (!stored) continue;
      docs.push({ url: stored.url, name: String((f && f.name) || stored.name).slice(0, 120), kind, mime: stored.mime, size: stored.size, at: new Date().toISOString() });
      added++;
    }
    if (!added) return res.status(400).json({ success: false, message: 'Only images and PDFs up to 8 MB can be uploaded' });
    await pool.execute('UPDATE orders SET documents_json = ? WHERE id = ?', [JSON.stringify(docs), row.id]);
    const label = { bol: 'Bill of Lading', pickup: 'pickup photos', delivery: 'delivery photos', other: 'documents' }[kind];
    await addOrderEvent(row.id, 'update', `${added} ${added === 1 && kind !== 'bol' ? label.replace(/s$/, '') : label} added`);
    res.json({ success: true, added, documents: docs });
  } catch (err) { console.error('POST /api/orders/:id/documents:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
async function deleteStoredFile(key) {
  if (!FILE_KEY_RE.test(key)) return;
  if (s3) { const { DeleteObjectCommand } = require('@aws-sdk/client-s3'); await s3.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => {}); }
  try { fs.unlinkSync(path.join(STORAGE_ROOT, key)); } catch (_) {}
}
app.delete('/api/orders/:id/documents', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    const url = String((req.body || {}).url || '');
    const docs = safeJson(row.documents_json) || [];
    const keep = docs.filter(d => d.url !== url);
    if (keep.length === docs.length) return res.status(404).json({ success: false, message: 'Document not found' });
    await pool.execute('UPDATE orders SET documents_json = ? WHERE id = ?', [JSON.stringify(keep), row.id]);
    await deleteStoredFile(url.replace(/^\/+/, ''));
    res.json({ success: true, documents: keep });
  } catch (err) { console.error('DELETE /api/orders/:id/documents:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/orders/:id/delivered', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    if (row.delivered_at) return res.status(409).json({ success: false, message: 'Already marked delivered' });
    await pool.execute("UPDATE orders SET delivered_at = NOW(), status = 'Done', picked_up_at = COALESCE(picked_up_at, NOW()) WHERE id = ?", [row.id]);
    await addOrderEvent(row.id, 'delivered', 'Delivered');
    let emailed = false;
    const fresh = await loadOrderRow(row.id); const o = mapOrderRow(fresh, false); const c = o.contact || {};
    let texted = false;
    if ((req.body || {}).notify !== false) {
      const tUrl = await trackingUrl(fresh, req);
      if (c.email) { const m = await sendMail({ to: c.email, ...deliveredEmail(o, tUrl) }).catch(e => ({ sent: false })); emailed = !!m.sent; }
      if (c.phone && smsConfigured()) texted = (await sendSms(c.phone, smsText('delivered', o, { track: tUrl }), o.id)).sent;
    }
    res.json({ success: true, emailed, texted, order: mapOrderRow(await loadOrderRow(row.id), false) });
  } catch (err) { console.error('POST /api/orders/:id/delivered:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.post('/api/orders/:id/sms', requireAdmin, async (req, res) => {
  try {
    const row = await loadOrderRow(req.params.id);
    if (!row) return res.status(404).json({ success: false, message: 'Order not found' });
    const body = String((req.body || {}).body || '').trim().slice(0, 1200);
    if (!body) return res.status(400).json({ success: false, message: 'Write the text first' });
    const o = mapOrderRow(row, false); const phone = (o.contact || {}).phone;
    if (!phone) return res.status(400).json({ success: false, message: 'The order has no phone number' });
    const r = await sendSms(phone, body.startsWith('Mcships') ? body : `Mcships: ${body}`, o.id);
    if (!r.sent) return res.status(502).json({ success: false, message: r.reason });
    res.json({ success: true, order: mapOrderRow(await loadOrderRow(row.id), false) });
  } catch (err) { console.error('POST /api/orders/:id/sms:', err); res.status(500).json({ success: false, message: 'Server error' }); }
});
app.get('/api/sms/status', requireAdmin, (req, res) => res.json({ configured: smsConfigured(), from: smsConfigured() ? process.env.TWILIO_FROM.trim() : null }));
app.post('/api/sms/test', requireAdmin, async (req, res) => {
  const r = await sendSms((req.body || {}).to, 'Mcships: test text from your website. Texting works.');
  if (!r.sent) return res.status(502).json({ success: false, message: r.reason });
  res.json({ success: true });
});
app.get('/api/orders/:id/tracking-link', requireAdmin, async (req, res) => {
  try { const row = await loadOrderRow(req.params.id); if (!row) return res.status(404).json({ success: false }); res.json({ success: true, url: await trackingUrl(row, req) }); }
  catch (err) { res.status(500).json({ success: false }); }
});

// ---- Public: customer tracking page ----
app.get('/track/:token', publicLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    const [rows] = /^[a-f0-9]{48}$/.test(token) ? await pool.execute('SELECT * FROM orders WHERE tracking_token = ?', [token]) : [[]];
    if (!rows.length) return res.status(404).render('track', { notFound: true, order: null, phone: COMPANY_PHONE });
    const o = mapOrderRow(rows[0], false);
    const step = o.deliveredAt ? 4 : o.pickedUpAt ? 3 : (o.dispatch.dispatchedAt ? 2 : (o.agreedAt || o.source === 'web' || o.paymentState === 'charged') ? 1 : 0);
    const docs = (o.documents || []).filter(d => d.kind === 'bol' || d.kind === 'delivery' || d.kind === 'pickup');
    res.render('track', {
      notFound: false, phone: COMPANY_PHONE, step,
      order: { id: o.id, status: o.status, vehicles: orderVehicles(o).map(vehicleLabel), pickup: (o.location || {}).pickup || '', delivery: (o.location || {}).delivery || '',
        pickupDate: o.pickupDate, mustDeliverBy: o.mustDeliverBy, transportType: o.transportType, dispatch: o.dispatch, pickedUpAt: o.pickedUpAt, deliveredAt: o.deliveredAt,
        events: (o.events || []).slice().reverse(), documents: docs, firstName: ((o.contact || {}).fullName || '').split(' ')[0] }
    });
  } catch (err) { console.error('GET /track/:token:', err); res.status(500).render('404'); }
});

// ---- Review request: one email, the day after delivery ----
async function getReviewUrl() {
  try { const [rows] = await pool.execute("SELECT value FROM settings WHERE name = 'review_url'"); if (rows.length) { const v = safeJson(rows[0].value); if (v && v.url) return String(v.url); } } catch (_) {}
  return (process.env.REVIEW_URL || '').trim();
}
app.get('/api/settings/review', requireAdmin, async (req, res) => res.json({ url: await getReviewUrl() }));
app.put('/api/settings/review', requireAdmin, async (req, res) => {
  try {
    const url = String((req.body || {}).url || '').trim().slice(0, 500);
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, message: 'The review link must start with http:// or https://' });
    await pool.execute("INSERT INTO settings (name, value) VALUES ('review_url', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify({ url })]);
    res.json({ success: true, url });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});
async function sendReviewRequests() {
  try {
    const [rows] = await pool.execute(`SELECT * FROM orders WHERE delivered_at IS NOT NULL AND review_sent_at IS NULL
      AND delivered_at <= DATE_SUB(NOW(), INTERVAL 1 DAY) AND delivered_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) LIMIT 50`);
    if (!rows.length) return;
    const reviewUrl = await getReviewUrl();
    for (const r of rows) {
      const o = mapOrderRow(r, false); const c = o.contact || {};
      await pool.execute('UPDATE orders SET review_sent_at = NOW() WHERE id = ?', [r.id]); // mark first: never send twice
      if (!c.email) continue;
      const m = await sendMail({ to: c.email, ...reviewEmail(o, reviewUrl) }).catch(e => ({ sent: false, reason: e.message }));
      if (m.sent) console.log(`⭐ Review request sent for ${r.id}`);
    }
  } catch (e) { console.error('sendReviewRequests:', e.message); }
}

// ---- Admin home: what needs attention today ----
app.get('/api/dashboard', requireAdmin, async (req, res) => {
  try {
    const [orders] = await pool.execute('SELECT * FROM orders ORDER BY created_at DESC');
    const all = orders.map(r => mapOrderRow(r, false));
    const now = new Date(), day = 86400000;
    const todayStr = now.toISOString().slice(0, 10);
    const soonStr = new Date(now.getTime() + 2 * day).toISOString().slice(0, 10);
    const open = all.filter(o => !['Done', 'Canceled'].includes(o.status));
    const pickups = open.filter(o => o.pickupDate && o.pickupDate <= soonStr && !o.pickedUpAt).sort((x, y) => String(x.pickupDate).localeCompare(String(y.pickupDate)));
    const holdsExpiring = all.filter(o => o.paymentState === 'holding' && o.holdExpiresAt && new Date(o.holdExpiresAt) - now < 2 * day);
    const awaitingCard = all.filter(o => o.paymentState === 'pending');
    const inTransit = open.filter(o => o.pickedUpAt && o.status === 'In Work');
    const weekAgo = new Date(now.getTime() - 7 * day);
    const charged7 = all.filter(o => o.chargedAt && new Date(o.chargedAt) >= weekAgo).reduce((s, o) => s + (o.chargedAmount || 0), 0);
    const refunded7 = all.filter(o => o.refundedAt && new Date(o.refundedAt) >= weekAgo).reduce((s, o) => s + (o.refundedAmount || 0), 0);
    const holding = all.filter(o => o.paymentState === 'holding').reduce((s, o) => s + (o.holdAmount || o.total || 0), 0);
    const newOrders7 = all.filter(o => new Date(o.createdAt) >= weekAgo).length;
    const [quotes] = await pool.execute('SELECT token, email, name, phone, vehicle_json, pickup, delivery, distance, total, created_at, followup1_at, followup2_at FROM quotes WHERE order_id IS NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 14 DAY) ORDER BY created_at DESC LIMIT 25');
    const [[leads7]] = await pool.execute('SELECT COUNT(*) n FROM leads WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');
    const brief = o => ({ id: o.id, customer: (o.contact || {}).fullName || '', phone: (o.contact || {}).phone || '', vehicle: o.vehicle ? [o.vehicle.year, o.vehicle.make, o.vehicle.model].filter(Boolean).join(' ') : '', pickup: (o.location || {}).pickup || '', delivery: (o.location || {}).delivery || '', pickupDate: o.pickupDate, total: o.total, status: o.status, paymentState: o.paymentState, holdExpiresAt: o.holdExpiresAt, confirmSentAt: o.confirmSentAt });
    res.json({
      today: todayStr,
      counts: { pickups: pickups.length, holdsExpiring: holdsExpiring.length, awaitingCard: awaitingCard.length, inTransit: inTransit.length, unbookedQuotes: quotes.length, newOrders7, leads7: leads7.n },
      money: { holding, charged7, refunded7 },
      pickups: pickups.slice(0, 15).map(brief), holdsExpiring: holdsExpiring.map(brief), awaitingCard: awaitingCard.slice(0, 15).map(brief), inTransit: inTransit.slice(0, 15).map(brief),
      quotes: quotes.map(q => { return { token: q.token, email: q.email, name: q.name, phone: q.phone, vehicle: quoteVehiclesLabel(quoteVehicles(q.vehicle_json)), pickup: q.pickup, delivery: q.delivery, distance: q.distance, total: Number(q.total), createdAt: q.created_at, followups: (q.followup1_at ? 1 : 0) + (q.followup2_at ? 1 : 0) }; }),
      recent: all.slice(0, 8).map(brief)
    });
  } catch (err) { console.error('GET /api/dashboard:', err); res.status(500).json({ success: false }); }
});

// ---- Quote follow-ups: day 2 "still thinking?", day 6 "expires tomorrow" (only unbooked quotes that were emailed) ----
function followupEmail(q, bookUrl, second) {
  const label = quoteVehiclesLabel(q.vehicles);
  const html = emailShell(second ? `
    <h1 style="margin:0 0 12px;font-size:22px">Your quote expires tomorrow</h1>
    <p>Hi ${escHtml(q.name || 'there')},</p>
    <p>Quick heads-up: the <strong>${money(q.total)}</strong> quote to move your ${escHtml(label)} from ${escHtml(q.pickup || 'pickup')} to ${escHtml(q.delivery || 'delivery')} is good through tomorrow. After that, fuel and carrier rates may move it.</p>
    <p style="text-align:center;margin:26px 0"><a href="${bookUrl}" style="display:inline-block;background:#FF6A3D;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px">Lock in ${money(q.total)}</a></p>
    <p style="font-size:13px;color:#6b7280">Dates not set yet? Book now and we'll work around your schedule. Questions: reply to this email or call ${COMPANY_PHONE}.</p>` : `
    <h1 style="margin:0 0 12px;font-size:22px">Still thinking about shipping your ${escHtml(label)}?</h1>
    <p>Hi ${escHtml(q.name || 'there')},</p>
    <p>A couple of days ago you priced a transport from ${escHtml(q.pickup || 'pickup')} to ${escHtml(q.delivery || 'delivery')} at <strong>${money(q.total)}</strong>. That price is still good, and booking takes about two minutes: pick your dates, enter a card, done. Nothing is charged until the vehicle is picked up.</p>
    <p style="text-align:center;margin:26px 0"><a href="${bookUrl}" style="display:inline-block;background:#FF6A3D;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:8px">Book this transport</a></p>
    <p style="font-size:13px;color:#6b7280">Have a question first, or want to talk it through? Reply to this email or call ${COMPANY_PHONE}. We're happy to help.</p>`);
  const text = second
    ? `Hi ${q.name || 'there'}, your ${money(q.total)} quote for ${label} (${q.pickup} → ${q.delivery}) is good through tomorrow. Book: ${bookUrl}\n\nQuestions? Call ${COMPANY_PHONE}.`
    : `Hi ${q.name || 'there'}, your ${money(q.total)} quote for ${label} (${q.pickup} → ${q.delivery}) is still good. Book in two minutes: ${bookUrl}\n\nQuestions? Call ${COMPANY_PHONE}.`;
  return { subject: second ? `Your Mcships quote expires tomorrow` : `Still thinking about shipping your ${label}?`, html, text };
}
async function sendQuoteFollowups() {
  try {
    const base = (process.env.APP_URL || 'https://mcships.com').replace(/\/$/, '');
    const [due1] = await pool.execute(`SELECT * FROM quotes WHERE order_id IS NULL AND emailed_at IS NOT NULL AND followup1_at IS NULL
      AND created_at <= DATE_SUB(NOW(), INTERVAL 2 DAY) AND created_at >= DATE_SUB(NOW(), INTERVAL 5 DAY) LIMIT 50`);
    const [due2] = await pool.execute(`SELECT * FROM quotes WHERE order_id IS NULL AND emailed_at IS NOT NULL AND followup2_at IS NULL
      AND created_at <= DATE_SUB(NOW(), INTERVAL 6 DAY) AND created_at >= DATE_SUB(NOW(), INTERVAL 8 DAY) LIMIT 50`);
    for (const [rows, second] of [[due1, false], [due2, true]]) {
      for (const r of rows) {
        const q = { name: r.name, total: Number(r.total), pickup: r.pickup, delivery: r.delivery, vehicles: quoteVehicles(r.vehicle_json) };
        const bookUrl = `${base}/payment?quote=${r.token}`;
        const m = await sendMail({ to: r.email, ...followupEmail(q, bookUrl, second) }).catch(e => ({ sent: false, reason: e.message }));
        await pool.execute(`UPDATE quotes SET ${second ? 'followup2_at' : 'followup1_at'} = NOW() WHERE token = ?`, [r.token]); // mark even on failure: never spam retries
        if (m.sent) console.log(`📨 Quote follow-up ${second ? 2 : 1} sent to ${r.email} (${r.token.slice(0, 8)})`);
      }
    }
  } catch (e) { console.error('sendQuoteFollowups:', e.message); }
}

// ---- Admin: payments overview (every order's money situation, newest first) ----
app.get('/api/payments', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM orders ORDER BY created_at DESC');
    const list = rows.map(r => {
      const o = mapOrderRow(r, false);
      return {
        id: o.id, createdAt: o.createdAt, status: o.status, source: o.source,
        customer: (o.contact && o.contact.fullName) || '', email: (o.contact && o.contact.email) || '', phone: (o.contact && o.contact.phone) || '',
        vehicle: o.vehicle ? [o.vehicle.year, o.vehicle.make, o.vehicle.model].filter(Boolean).join(' ') : '',
        total: o.total, paymentStatus: o.paymentStatus, paymentState: o.paymentState,
        holdAmount: o.holdAmount, holdExpiresAt: o.holdExpiresAt, chargedAmount: o.chargedAmount, chargedAt: o.chargedAt,
        refundedAmount: o.refundedAmount, refundedAt: o.refundedAt, noShowFee: o.noShowFee,
        hasCardOnFile: o.hasCardOnFile, confirmSentAt: o.confirmSentAt, agreedAt: o.agreedAt, pickedUpAt: o.pickedUpAt,
        stripePaymentIntentId: o.stripePaymentIntentId, feePaymentIntentId: o.feePaymentIntentId, disputeStatus: o.disputeStatus
      };
    });
    const totals = list.reduce((t, p) => {
      if (p.paymentState === 'holding') t.holding += p.holdAmount || p.total || 0;
      if (['charged', 'partially_refunded', 'refunded', 'fee_charged'].includes(p.paymentState)) t.charged += p.chargedAmount || 0;
      t.refunded += p.refundedAmount || 0;
      if (p.paymentState === 'pending') t.pending += p.total || 0;
      return t;
    }, { holding: 0, charged: 0, refunded: 0, pending: 0 });
    // Optional search / state filter / paging (totals always cover everything)
    const q = str(req.query.q, 100).toLowerCase(), state = str(req.query.state, 30);
    const STATE_GROUPS = {
      pending: ['pending', 'unpaid'], holding: ['holding'], charged: ['charged', 'partially_refunded', 'fee_charged'],
      refunded: ['refunded', 'partially_refunded'], other: ['released', 'expired']
    };
    let filtered = list;
    if (state && STATE_GROUPS[state]) filtered = filtered.filter(p => STATE_GROUPS[state].includes(p.paymentState));
    else if (state) filtered = filtered.filter(p => p.paymentState === state);
    if (q) filtered = filtered.filter(p => [p.id, p.customer, p.email, p.phone, p.vehicle].some(v => String(v || '').toLowerCase().includes(q)));
    const { page, limit, paged } = pageParams(req);
    if (!paged) return res.json({ payments: filtered, totals });
    const pg = paginate(filtered, page, limit);
    res.json({ payments: pg.slice, totals, total: pg.total, page: pg.page, pages: pg.pages });
  } catch (err) {
    console.error('GET /api/payments:', err);
    res.status(500).json({ success: false });
  }
});

// ==================== API: CUSTOMERS ====================

const CUSTOMER_TYPES = ['dealer', 'auction', 'oem', 'fleet', 'individual', 'other'];

// GET customers with order stats (optional ?q= search)
app.get('/api/customers', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let where = '';
    const params = [];
    if (q) {
      where = 'WHERE (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.company LIKE ?)';
      params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.execute(
      `SELECT c.*,
              COUNT(o.id)               AS order_count,
              COALESCE(SUM(o.total), 0) AS total_spent,
              MAX(o.created_at)         AS last_order_at
         FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id
         ${where}
         GROUP BY c.id
         ORDER BY c.created_at DESC`,
      params
    );
    const list = rows.map(mapCustomerRow);
    const { page, limit, paged } = pageParams(req);
    if (!paged) return res.json(list);
    const pg = paginate(list, page, limit);
    res.json({ customers: pg.slice, total: pg.total, page: pg.page, pages: pg.pages });
  } catch (err) {
    console.error('GET /api/customers:', err);
    res.json([]);
  }
});

// GET single customer + their order history
app.get('/api/customers/:id', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT c.*,
              COUNT(o.id)               AS order_count,
              COALESCE(SUM(o.total), 0) AS total_spent,
              MAX(o.created_at)         AS last_order_at
         FROM customers c
         LEFT JOIN orders o ON o.customer_id = c.id
         WHERE c.id = ?
         GROUP BY c.id`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false });

    const [orderRows] = await pool.execute(
      'SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ ...mapCustomerRow(rows[0]), orders: orderRows.map(r => mapOrderRow(r)) });
  } catch (err) {
    console.error('GET /api/customers/:id:', err);
    res.status(500).json({ success: false });
  }
});

// POST create customer (directory entry only — no order)
app.post('/api/customers', requireAdmin, async (req, res) => {
  const { name, email, phone, company, type, notes } = req.body;
  if (!name || !String(name).trim())
    return res.status(400).json({ success: false, message: 'Name is required' });
  const cleanEmail = (email || '').trim().toLowerCase() || null;
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
    return res.status(400).json({ success: false, message: 'Invalid email address' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO customers (name, email, phone, company, type, notes) VALUES (?,?,?,?,?,?)',
      [
        String(name).trim(), cleanEmail,
        (phone || '').trim() || null, (company || '').trim() || null,
        CUSTOMER_TYPES.includes(type) ? type : 'individual',
        (notes || '').trim() || null
      ]
    );
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'A customer with this email already exists' });
    console.error('POST /api/customers:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH update customer
app.patch('/api/customers/:id', requireAdmin, async (req, res) => {
  const { name, email, phone, company, type, notes } = req.body;
  if (!name || !String(name).trim())
    return res.status(400).json({ success: false, message: 'Name is required' });
  const cleanEmail = (email || '').trim().toLowerCase() || null;
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
    return res.status(400).json({ success: false, message: 'Invalid email address' });
  try {
    const [result] = await pool.execute(
      'UPDATE customers SET name=?, email=?, phone=?, company=?, type=?, notes=? WHERE id=?',
      [
        String(name).trim(), cleanEmail,
        (phone || '').trim() || null, (company || '').trim() || null,
        CUSTOMER_TYPES.includes(type) ? type : 'individual',
        (notes || '').trim() || null,
        req.params.id
      ]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'A customer with this email already exists' });
    console.error('PATCH /api/customers/:id:', err);
    res.status(500).json({ success: false });
  }
});

// DELETE customer — orders are kept, just unlinked
app.delete('/api/customers/:id', requireAdmin, async (req, res) => {
  try {
    await pool.execute('UPDATE orders SET customer_id = NULL WHERE customer_id = ?', [req.params.id]);
    const [result] = await pool.execute('DELETE FROM customers WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/customers/:id:', err);
    res.status(500).json({ success: false });
  }
});

// ==================== API: AUTH ====================

// POST sign-in → sets the session cookie (rate-limited against brute force)
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = req.body.role;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM employees WHERE email = ?', [email]
    );
    // Compare against a dummy hash when the user doesn't exist so timing is the same
    const hash = rows.length ? rows[0].password : '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Z6f0G9m1Jm6O7qYq3Y0kq0kq0kq0k';
    const match = await bcrypt.compare(password, hash);
    if (rows.length === 0 || !match)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const user = rows[0];
    if (role === 'admin' && user.role !== 'admin')
      return res.status(401).json({ success: false, message: 'Admin access required' });
    if (role && role !== 'admin' && user.role !== role)
      return res.status(401).json({ success: false, message: 'Invalid role for this account' });

    setSessionCookie(req, res, user, bool(req.body.remember));
    res.json({ success: true, role: user.role, email: user.email, name: user.name || null });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ success: false });
  }
});

// ---- Forgot / reset password (any role) ----
// POST /api/auth/forgot {email} → emails a one-hour reset link. Always answers "ok"
// so the form can't be used to discover which emails have accounts.
const RESET_TTL_MINUTES = 60;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
app.post('/api/auth/forgot', loginLimiter, async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
  try {
    const [rows] = await pool.execute('SELECT id, email, name FROM employees WHERE email = ?', [email]);
    if (rows.length) {
      const user = rows[0];
      const token = crypto.randomBytes(32).toString('hex');
      await pool.execute(
        'UPDATE employees SET reset_token_hash = ?, reset_expires = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
        [hashToken(token), RESET_TTL_MINUTES, user.id]
      );
      const link = `${appUrl(req)}/reset-password/${token}`;
      const mail = await sendMail({
        to: user.email,
        subject: 'Reset your MC Transportation password',
        html: emailShell(`<p>Hi${user.name ? ' ' + escHtml(user.name) : ''},</p>
          <p>Someone asked to reset the password for <strong>${escHtml(user.email)}</strong>. If that was you, click the button below. The link works for ${RESET_TTL_MINUTES} minutes.</p>
          <p style="text-align:center;margin:28px 0"><a href="${link}" style="background:#ff6a3d;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;display:inline-block">Choose a new password</a></p>
          <p style="color:#666;font-size:13px">If you didn't ask for this, ignore this email. Your password stays the same.</p>`),
        text: `Reset your MC Transportation password (link valid ${RESET_TTL_MINUTES} minutes): ${link}\n\nIf you didn't ask for this, ignore this email.`
      }).catch(e => ({ sent: false, reason: e.message }));
      if (!mail.sent) console.error('forgot-password mail not sent:', mail.reason);
    }
    res.json({ success: true, message: 'If that email has an account, a reset link is on its way.' });
  } catch (err) {
    console.error('POST /api/auth/forgot:', err);
    res.status(500).json({ success: false });
  }
});

// GET /reset-password/:token → page; POST /api/auth/reset {token, password} → sets it
app.get('/reset-password/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(404).render('404');
  res.render('reset-password', { token });
});
app.post('/api/auth/reset', loginLimiter, async (req, res) => {
  const token = String(req.body.token || '');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ success: false, message: 'This reset link is not valid' });
  if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM employees WHERE reset_token_hash = ? AND reset_expires IS NOT NULL AND reset_expires > NOW()',
      [hashToken(token)]
    );
    if (!rows.length) return res.status(400).json({ success: false, message: 'This reset link has expired or was already used. Request a new one.' });
    const user = rows[0];
    await pool.execute(
      'UPDATE employees SET password = ?, reset_token_hash = NULL, reset_expires = NULL WHERE id = ?',
      [await bcrypt.hash(password, 10), user.id]
    );
    setSessionCookie(req, res, user, false);
    res.json({ success: true, role: user.role, email: user.email });
  } catch (err) {
    console.error('POST /api/auth/reset:', err);
    res.status(500).json({ success: false });
  }
});

// POST sign-out → clears the session cookie
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// GET who am I (used by pages to sync their UI with the real session)
app.get('/api/auth/me', (req, res) => {
  if (!req.session) return res.json({ authenticated: false });
  res.json({ authenticated: true, role: req.session.role, email: req.session.email });
});

// POST change own password
app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
  const next    = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
  if (next.length < 8)
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
  try {
    const [rows] = await pool.execute('SELECT * FROM employees WHERE id = ?', [req.session.uid]);
    if (!rows.length || !(await bcrypt.compare(current, rows[0].password)))
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    await pool.execute('UPDATE employees SET password = ? WHERE id = ?', [await bcrypt.hash(next, 10), rows[0].id]);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/change-password:', err);
    res.status(500).json({ success: false });
  }
});

// POST public registration — carriers & shippers only (not admin)
app.post('/api/auth/register', registerLimiter, async (req, res) => {
  const { email, password, role, name, company } = req.body;
  if (!email || !password || typeof password !== 'string')
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  if (password.length < 8)
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

  const allowedRoles = ['carrier', 'shipper'];
  const userRole = allowedRoles.includes(role) ? role : null;
  if (!userRole)
    return res.status(400).json({ success: false, message: 'Role must be carrier or shipper' });

  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))
    return res.status(400).json({ success: false, message: 'Invalid email address' });

  try {
    const hash = await bcrypt.hash(password, 10);
    try {
      await pool.execute(
        'INSERT INTO employees (email, password, role, name, company) VALUES (?,?,?,?,?)',
        [cleanEmail, hash, userRole, (name || '').trim() || null, (company || '').trim() || null]
      );
    } catch (colErr) {
      // Fallback if name/company columns are missing
      if (colErr.code === 'ER_BAD_FIELD_ERROR') {
        await pool.execute(
          'INSERT INTO employees (email, password, role) VALUES (?,?,?)',
          [cleanEmail, hash, userRole]
        );
      } else {
        throw colErr;
      }
    }
    const [created] = await pool.execute('SELECT id, email, role FROM employees WHERE email = ?', [cleanEmail]);
    if (created.length) setSessionCookie(req, res, created[0]);
    res.json({ success: true, role: userRole, email: cleanEmail, name: (name || '').trim() || null });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    console.error('POST /api/auth/register:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST create employee/user (admin only)
app.post('/api/employees', requireAdmin, async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = ['admin', 'carrier', 'shipper'].includes(req.body.role) ? req.body.role : 'admin';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8)
    return res.status(400).json({ success: false, message: 'Valid email and a password of at least 8 characters are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO employees (email, password, role) VALUES (?,?,?)',
      [email, hash, role]
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Email already exists' });
    res.status(500).json({ success: false });
  }
});

// GET list employees
app.get('/api/employees', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, role, created_at FROM employees ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// DELETE employee (cannot delete yourself)
app.delete('/api/employees/:id', requireAdmin, async (req, res) => {
  if (Number(req.params.id) === Number(req.session.uid))
    return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
  try {
    await pool.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==================== API: SETTINGS ====================

// Public: pricing config used by the calculator / checkout pages
// Price anything, server-side (public: total only; admins also get the breakdown)
app.post('/api/price', publicLimiter, async (req, res) => {
  try {
    const vehicles = sanitizeVehicles(req.body.vehicles);
    if (!vehicles || !vehicles.length) return res.status(400).json({ success: false, message: 'At least one vehicle is required' });
    const distance = Number(req.body.distance);
    if (!(distance >= 0 && distance <= 6000)) return res.status(400).json({ success: false, message: 'Invalid distance' });
    const priced = await computeQuoteLive(vehicles, distance, {
      transportType: req.body.transportType === 'enclosed' ? 'enclosed' : 'open',
      pickupDate: str(req.body.pickupDate, 10), mustDeliverBy: str(req.body.mustDeliverBy, 10), ...locationOpts(req.body)
    });
    const isAdmin = !!(req.session && req.session.role === 'admin');
    res.json({ success: true, total: priced.total, transport: priced.transport, addons: priced.addons, fees: priced.fees, requiresCall: priced.requiresCall, ...(isAdmin ? { subtotal: priced.subtotal, cpm: priced.cpm, lines: priced.lines, factors: priced.factors } : {}) });
  } catch (err) { console.error('POST /api/price:', err); res.status(500).json({ success: false }); }
});

app.get('/api/settings/pricing', requireAdmin, async (req, res) => {
  const [pricing, fuel] = await Promise.all([getPricing(), getFuelIndex()]);
  res.json({ pricing, fuel, defaults: DEFAULT_PRICING, fuelConfigured: !!(process.env.EIA_API_KEY || '').trim(), aiConfigured: !!(process.env.ANTHROPIC_API_KEY || '').trim(), regions: REGION_NAMES });
});
// Recent location ratings, and an override so a wrong AI/metro tier can be corrected once for good
app.get('/api/locations', requireAdmin, async (req, res) => {
  try {
    const q = str(req.query.q, 100);
    const [rows] = q
      ? await pool.execute('SELECT * FROM location_ratings WHERE address LIKE ? ORDER BY created_at DESC LIMIT 100', ['%' + q + '%'])
      : await pool.execute('SELECT * FROM location_ratings ORDER BY created_at DESC LIMIT 100');
    res.json(rows.map(r => ({ id: r.id, address: r.address, metro: r.metro_name, metroMiles: r.metro_miles, aiTier: r.ai_tier, reasons: safeJson(r.ai_reasons) || [], flags: safeJson(r.ai_flags) || {}, overrideTier: r.override_tier, createdAt: r.created_at })));
  } catch (err) { res.json([]); }
});
app.patch('/api/locations/:id', requireAdmin, async (req, res) => {
  const t = req.body.overrideTier === null || req.body.overrideTier === '' ? null : Math.max(0, Math.min(3, parseInt(req.body.overrideTier, 10)));
  if (t !== null && !Number.isFinite(t)) return res.status(400).json({ success: false });
  await pool.execute('UPDATE location_ratings SET override_tier = ? WHERE id = ?', [t, Number(req.params.id) || 0]);
  res.json({ success: true, overrideTier: t });
});
app.put('/api/settings/pricing', requireAdmin, async (req, res) => {
  const p = sanitizePricing(req.body);
  if (!p) return res.status(400).json({ success: false, message: 'Invalid pricing settings' });
  try {
    await pool.execute("INSERT INTO settings (name, value) VALUES ('pricing', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(p)]);
    res.json({ success: true, pricing: p });
  } catch (err) { console.error('PUT pricing:', err); res.status(500).json({ success: false }); }
});
app.delete('/api/settings/pricing', requireAdmin, async (req, res) => {
  try { await pool.execute("DELETE FROM settings WHERE name = 'pricing'"); res.json({ success: true, pricing: DEFAULT_PRICING }); }
  catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/settings/pricing/refresh-fuel', requireAdmin, async (req, res) => {
  const r = await refreshFuelIndex(true);
  res.status(r.ok ? 200 : 400).json({ success: r.ok, fuel: r.idx || null, message: r.ok ? 'Diesel price updated' : r.reason });
});

app.get('/api/settings/calculator', async (req, res) => {
  res.json(await getCalculatorConfig());
});

// Admin: save pricing config
app.put('/api/settings/calculator', requireAdmin, async (req, res) => {
  const cfg = sanitizeCalculatorConfig(req.body);
  if (!cfg) return res.status(400).json({ success: false, message: 'Invalid calculator settings' });
  try {
    await pool.execute(
      "INSERT INTO settings (name, value) VALUES ('calculator', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [JSON.stringify(cfg)]
    );
    res.json({ success: true, config: cfg });
  } catch (err) {
    console.error('PUT /api/settings/calculator:', err);
    res.status(500).json({ success: false });
  }
});

// Admin: reset pricing config to defaults
app.delete('/api/settings/calculator', requireAdmin, async (req, res) => {
  try {
    await pool.execute("DELETE FROM settings WHERE name = 'calculator'");
    res.json({ success: true, config: DEFAULT_CALCULATOR_CONFIG });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==================== API: STRIPE (website checkout) ====================

// Public: price the quote on the server and create the PaymentIntent for exactly that
// amount. The browser only sends the inputs (vehicles, distance, promo code).
app.post('/api/create-payment-intent', publicLimiter, async (req, res) => {
  try {
    const vehicles = sanitizeVehicles(req.body.vehicles);
    if (!vehicles || !vehicles.length)
      return res.status(400).json({ success: false, message: 'At least one vehicle is required' });
    const distance = Number(req.body.distance);
    if (!(distance >= 1 && distance <= 6000))
      return res.status(400).json({ success: false, message: 'Enter a valid distance in miles' });

    const transportType = req.body.transportType === 'enclosed' ? 'enclosed' : 'open';
    const pickupDate = str(req.body.pickupDate, 10), mustDeliverBy = str(req.body.mustDeliverBy, 10);
    const priced = await computeQuoteLive(vehicles, distance, { transportType, pickupDate, mustDeliverBy, ...locationOpts(req.body) });
    const subtotal = priced.total;
    const promo = req.body.promoCode ? await findActivePromo(req.body.promoCode) : null;
    const discount = promoDiscount(promo, subtotal);
    const total = Math.max(0, subtotal - discount);
    const amountCents = Math.round(total * 100);
    if (amountCents < 50)
      return res.status(400).json({ success: false, message: 'Order amount is too small to charge' });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: 'Mcships – vehicle shipping (website)',
      metadata: {
        kind: 'web_checkout',
        distance: String(Math.round(distance)),
        vehicles: String(vehicles.length),
        subtotal: String(subtotal),
        promoCode: promo ? promo.code : '',
        discount: String(discount)
      }
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: total, subtotal, discount });
  } catch (err) {
    console.error('Stripe PaymentIntent error:', err.message);
    res.status(500).json({ success: false, message: 'Could not start the payment. Please try again.' });
  }
});

// ==================== API: PROMO CODES ====================

// GET all promo codes
app.get('/api/promo-codes', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// POST validate promo code (public — called from payment page)
app.post('/api/promo-codes/validate', publicLimiter, async (req, res) => {
  const code = str(req.body.code, 50);
  if (!code) return res.status(400).json({ success: false, message: 'No code provided' });
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM promo_codes WHERE code = ? AND active = 1',
      [code.toUpperCase().trim()]
    );
    if (rows.length === 0)
      return res.status(404).json({ success: false, message: 'Invalid or expired promo code' });
    const p = rows[0];
    res.json({ success: true, discount: Number(p.discount), type: p.type, code: p.code });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// POST create promo code
app.post('/api/promo-codes', requireAdmin, async (req, res) => {
  const code = str(req.body.code, 50);
  const discount = Number(req.body.discount);
  const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
  if (!code || !(discount > 0) || (type === 'percent' && discount > 100))
    return res.status(400).json({ success: false, message: 'Enter a code and a valid discount' });
  try {
    await pool.execute(
      'INSERT INTO promo_codes (code, discount, type) VALUES (?,?,?)',
      [code.toUpperCase().trim(), discount, type || 'percent']
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Code already exists' });
    res.status(500).json({ success: false });
  }
});

// PATCH update promo code
app.patch('/api/promo-codes/:id', requireAdmin, async (req, res) => {
  const discount = Number(req.body.discount);
  const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
  const active = req.body.active === undefined ? 1 : (bool(req.body.active) ? 1 : 0);
  if (!(discount > 0) || (type === 'percent' && discount > 100))
    return res.status(400).json({ success: false, message: 'Invalid discount' });
  try {
    await pool.execute(
      'UPDATE promo_codes SET discount=?, type=?, active=? WHERE id=?',
      [discount, type, active, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// DELETE promo code
app.delete('/api/promo-codes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.execute('DELETE FROM promo_codes WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==================== API: LEADS ====================
app.post('/api/leads', publicLimiter, async (req, res) => {
  const email = str(req.body.email, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, message: 'Invalid email' });
  try {
    const source = str(req.body.source, 100) || 'website';
    const [result] = await pool.execute('INSERT IGNORE INTO leads (email, source) VALUES (?,?)', [email, source]);
    res.json({ success: true });
    if (result.affectedRows && process.env.ADMIN_NOTIFY_EMAIL) {
      sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `✉️ New lead: ${email}`,
        html: emailShell(`<p>Someone left their email on the website.</p><p><strong>${escHtml(email)}</strong><br><span style="color:#666">Source: ${escHtml(source)}</span></p><p>Reply from sales@mcships.com while they're still interested.</p>`),
        text: `New lead from the website: ${email} (source: ${source})`
      }).catch(e => console.error('lead notify mail:', e.message));
    }
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/leads', requireAdmin, async (req, res) => {
  try {
    const q = str(req.query.q, 100);
    const [rows] = q
      ? await pool.execute('SELECT * FROM leads WHERE email LIKE ? OR source LIKE ? ORDER BY created_at DESC', ['%' + q + '%', '%' + q + '%'])
      : await pool.execute('SELECT * FROM leads ORDER BY created_at DESC');
    // Mark leads that already became customers
    const emails = rows.map(r => r.email);
    let known = new Set();
    if (emails.length) {
      const [cs] = await pool.query('SELECT email FROM customers WHERE email IN (?)', [emails]);
      known = new Set(cs.map(c => (c.email || '').toLowerCase()));
    }
    const list = rows.map(r => ({ id: r.id, email: r.email, source: r.source, createdAt: r.created_at, isCustomer: known.has((r.email || '').toLowerCase()) }));
    const { page, limit, paged } = pageParams(req);
    if (!paged) return res.json(list);
    const pg = paginate(list, page, limit);
    res.json({ leads: pg.slice, total: pg.total, page: pg.page, pages: pg.pages });
  } catch (err) {
    console.error('GET /api/leads:', err);
    res.json([]);
  }
});

// ==================== API: WEBSITE QUOTES ====================
// The calculator asks for contact details BEFORE showing a price. This saves the
// quote, prices it on the server, emails the customer a copy with a "Book" link,
// records the lead, and tells the team.
function quoteVehicles(json) { const v = safeJson(json); return Array.isArray(v) ? v : (v && typeof v === 'object' ? [v] : []); }
function quoteVehicleLabel(v) { v = v || {}; return [v.year, v.make, v.model].filter(Boolean).join(' ') || (v.type ? v.type.replace('-', ' ') : 'vehicle'); }
function quoteVehicleFlags(v) { return [v.condition === 'inoperable' ? 'inoperable' : '', v.modified ? 'modified' : '', v.urgent ? 'urgent' : ''].filter(Boolean).join(', '); }
// "2021 Ford F-150" or "2 vehicles: 2021 Ford F-150, sedan"
function quoteVehiclesLabel(list) {
  list = (list || []).filter(Boolean);
  if (!list.length) return 'your vehicle';
  if (list.length === 1) return quoteVehicleLabel(list[0]);
  return `${list.length} vehicles: ${list.map(quoteVehicleLabel).join(', ')}`;
}
function quoteEmail(q, bookUrl) {
  const list = Array.isArray(q.vehicles) && q.vehicles.length ? q.vehicles : [q.vehicle || {}];
  const label = quoteVehiclesLabel(list);
  const vehicleCell = list.map(v => { const f = quoteVehicleFlags(v); return escHtml(quoteVehicleLabel(v)) + (f ? ' · ' + escHtml(f) : ''); }).join('<br>');
  const rows = [
    [list.length > 1 ? `Vehicles (${list.length})` : 'Vehicle', vehicleCell],
    ['Pickup', escHtml(q.pickup || '—')], ['Delivery', escHtml(q.delivery || '—')],
    ['Distance', `${Number(q.distance || 0).toLocaleString()} miles`], ['Transport', escHtml(q.transportType || 'open')]
  ];
  const extras = [...(q.addons || []), ...(q.fees || [])];
  if (extras.length) rows.push(['Includes', extras.map(x => `${escHtml(x.label)} (+${money(x.amount)})`).join('<br>')]);
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:18px 0">${rows.map(([k, val]) =>
    `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;color:#666;width:120px">${k}</td><td style="padding:8px 10px;border-bottom:1px solid #eee">${val}</td></tr>`).join('')}</table>`;
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">Your quote: ${money(q.total)}</h1>
    <p>Hi ${escHtml(q.name || 'there')},</p>
    <p>Thanks for checking prices with Mcships. Here is the quote for the transport you entered:</p>
    ${table}
    <p style="margin:18px 0;padding:14px 16px;background:#fafafa;border-radius:8px;font-size:15px">Total for this transport${list.length > 1 ? ` (${list.length} vehicles, multi-vehicle discount included)` : ''}, all fees included: <strong style="font-size:20px">${money(q.total)}</strong></p>
    <p style="text-align:center;margin:28px 0"><a href="${bookUrl}" style="background:#ff6a3d;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;display:inline-block">Book this transport</a></p>
    <p style="font-size:13px;color:#666">The link opens checkout with everything already filled in — you only choose your dates and pay. This price is based on the details you entered and is valid for 7 days. Questions? Reply to this email or call ${COMPANY_PHONE}.</p>`);
  const text = `Your Mcships quote: ${money(q.total)}\n\n${list.length > 1 ? 'Vehicles' : 'Vehicle'}: ${label}\nPickup: ${q.pickup}\nDelivery: ${q.delivery}\nDistance: ${q.distance} miles\nTransport: ${q.transportType}\n\nBook: ${bookUrl}\n\nValid for 7 days. Questions? Call ${COMPANY_PHONE}.`;
  return { subject: `Your Mcships quote: ${money(q.total)}`, html, text };
}

app.post('/api/quotes', publicLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const email = str(b.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    const name = str(b.name, 120), phone = str(b.phone, 40);
    const vehicles = sanitizeVehicles(Array.isArray(b.vehicles) && b.vehicles.length ? b.vehicles : [b.vehicle || {}]);
    const vehicle = vehicles && vehicles[0];
    if (!vehicle) return res.status(400).json({ success: false, message: 'Vehicle details are missing' });
    vehicles.forEach(v => { delete v.photos; }); // photos are added at checkout, not here
    const distance = Math.round(Number(b.distance));
    if (!(distance >= 1 && distance <= 6000)) return res.status(400).json({ success: false, message: 'Enter the pickup and delivery addresses so we can measure the distance' });
    const pickup = str(b.pickup, 500), delivery = str(b.delivery, 500);
    const transportType = b.transportType === 'enclosed' ? 'enclosed' : 'open';

    const priced = await computeQuoteLive(vehicles, distance, { transportType, ...locationOpts(b) });
    const total = priced.total;
    const breakdown = priced.lines;
    const token = crypto.randomBytes(24).toString('hex');
    const lo = locationOpts(b);
    await pool.execute(
      `INSERT INTO quotes (token, email, name, phone, vehicle_json, distance, pickup, delivery, transport_type, total, breakdown_json, pickup_lat, pickup_lng, delivery_lat, delivery_lng)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [token, email, name || null, phone || null, JSON.stringify(vehicles), distance, pickup || null, delivery || null, transportType, total, JSON.stringify(breakdown), lo.pickupLat ?? null, lo.pickupLng ?? null, lo.deliveryLat ?? null, lo.deliveryLng ?? null]
    );
    pool.execute('INSERT IGNORE INTO leads (email, source) VALUES (?, ?)', [email, 'calculator']).catch(() => {});

    const bookUrl = `${appUrl(req)}/payment?quote=${token}`;
    const q = { email, name, phone, vehicle, vehicles, distance, pickup, delivery, transportType, total, breakdown, addons: priced.addons, fees: priced.fees };
    const mail = await sendMail({ to: email, ...quoteEmail(q, bookUrl) }).catch(e => ({ sent: false, reason: e.message }));
    if (mail.sent) pool.execute('UPDATE quotes SET emailed_at = NOW() WHERE token = ?', [token]).catch(() => {});
    else console.error('quote email not sent:', mail.reason);

    if (process.env.ADMIN_NOTIFY_EMAIL) {
      const vl = quoteVehiclesLabel(vehicles);
      const flags = vehicles.length === 1 ? quoteVehicleFlags(vehicle) : '';
      const alertRows = [
        ['Customer', escHtml(name || '—')], ['Email', `<a href="mailto:${escHtml(email)}">${escHtml(email)}</a>`], ['Phone', phone ? `<a href="tel:${escHtml(phone)}">${escHtml(phone)}</a>` : '—'],
        [vehicles.length > 1 ? 'Vehicles' : 'Vehicle', escHtml(vl) + (flags ? ' · ' + escHtml(flags) : '') + (vehicles.length === 1 && vehicle.vin ? ' · VIN ' + escHtml(vehicle.vin) : '')],
        ['Pickup', escHtml(pickup || '—')], ['Delivery', escHtml(delivery || '—')],
        ['Distance', `${distance.toLocaleString()} miles`], ['Transport', escHtml(transportType)],
        ['Quoted price', `<strong>${money(total)}</strong>`]
      ];
      const alertTable = `<table cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;margin:18px 0">` +
        alertRows.map(([k, v]) => `<tr><td style="padding:8px 12px;color:#6b7280;font-size:13px;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f3f4f6">${k}</td><td style="padding:8px 12px;color:#111827;font-size:14px;border-bottom:1px solid #f3f4f6">${v}</td></tr>`).join('') + `</table>`;
      sendMail({
        to: process.env.ADMIN_NOTIFY_EMAIL,
        subject: `New website quote ${money(total)} – ${name || email}`,
        html: emailShell(`<h1 style="margin:0 0 12px;font-size:20px">New website quote</h1>
          <p>Someone just priced a transport on mcships.com. They received the quote by email with a Book link.</p>
          ${alertTable}
          <p style="text-align:center;margin:26px 0"><a href="${appUrl(req)}/admin/leads" style="display:inline-block;background:#FF6A3D;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:8px">Open Leads in admin</a></p>
          <p style="font-size:13px;color:#6b7280">A quick call while they're still looking often closes it.</p>`),
        text: `New website quote ${money(total)}\n\nCustomer: ${name || '—'}\nEmail: ${email}\nPhone: ${phone || '—'}\nVehicle: ${vl}${flags ? ' (' + flags + ')' : ''}\nPickup: ${pickup}\nDelivery: ${delivery}\nDistance: ${distance} mi\nTransport: ${transportType}\n\nLeads: ${appUrl(req)}/admin/leads`
      }).catch(e => console.error('quote notify mail:', e.message));
    }
    res.json({ success: true, quoteId: token, total, addons: priced.addons, fees: priced.fees, bookUrl, emailSent: !!mail.sent, requiresCall: !!priced.requiresCall });
  } catch (err) {
    console.error('POST /api/quotes:', err);
    res.status(500).json({ success: false, message: 'Could not create the quote right now' });
  }
});

// Checkout prefill: everything the customer entered on the calculator
app.get('/api/quotes/:token', publicLimiter, async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{48}$/.test(token)) return res.status(404).json({ success: false });
  try {
    const [rows] = await pool.execute('SELECT * FROM quotes WHERE token = ?', [token]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'This quote link is not valid' });
    const q = rows[0];
    res.json({
      success: true, quoteId: q.token, email: q.email, name: q.name || '', phone: q.phone || '',
      vehicle: quoteVehicles(q.vehicle_json)[0] || {}, vehicles: quoteVehicles(q.vehicle_json), distance: q.distance, pickup: q.pickup || '', delivery: q.delivery || '',
      transportType: q.transport_type || 'open', total: Number(q.total), breakdown: safeJson(q.breakdown_json) || [],
      pickupLat: q.pickup_lat != null ? Number(q.pickup_lat) : null, pickupLng: q.pickup_lng != null ? Number(q.pickup_lng) : null,
      deliveryLat: q.delivery_lat != null ? Number(q.delivery_lat) : null, deliveryLng: q.delivery_lng != null ? Number(q.delivery_lng) : null,
      createdAt: q.created_at, orderId: q.order_id || null
    });
  } catch (err) {
    console.error('GET /api/quotes/:token:', err);
    res.status(500).json({ success: false });
  }
});

app.delete('/api/leads/:id', requireAdmin, async (req, res) => {
  try {
    const [r] = await pool.execute('DELETE FROM leads WHERE id = ?', [Number(req.params.id) || 0]);
    if (!r.affectedRows) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

// ==================== API: EXCHANGE ====================

function parseCityState(address) {
  if (!address) return { city: 'Unknown', state: '' };
  const parts = address.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    const statePart = parts[parts.length - 2] || parts[parts.length - 1];
    const stateMatch = statePart.match(/\b([A-Z]{2})\b/i) || statePart.match(/^([A-Za-z\s]+)$/);
    const city = parts[0];
    const state = stateMatch ? stateMatch[1].substring(0, 2).toUpperCase() : '';
    return { city, state };
  }
  return { city: address.substring(0, 30), state: '' };
}

function safeJson(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch (e) { return null; }
}

function dbRowToListing(r, detail = false) {
  const price = Number(r.price);
  const miles = Number(r.miles) || 0;
  const originAddr = r.origin_address || [r.origin_city, r.origin_state].filter(Boolean).join(', ');
  const destAddr = r.dest_address || [r.dest_city, r.dest_state].filter(Boolean).join(', ');
  const vehiclesData = safeJson(r.vehicles_json);
  const attachments = safeJson(r.attachments_json) || [];

  const base = {
    id: r.id,
    source: 'listing',
    origin: {
      city: r.origin_city,
      state: r.origin_state,
      pickupLabel: r.pickup_label || 'Available Now',
      address: originAddr
    },
    destination: {
      city: r.dest_city,
      state: r.dest_state,
      deliverDate: r.deliver_date || 'TBD',
      address: destAddr
    },
    vehicle: r.vehicle_label,
    vehicleCount: r.vehicle_count,
    price,
    miles,
    ratePerMile: miles > 0 ? Math.round((price / miles) * 100) / 100 : 0,
    status: r.status,
    shipperEmail: r.shipper_email || null,
    createdAt: r.created_at
  };
  if (!detail) return base;

  let vehicleDetails = [];
  if (Array.isArray(vehiclesData) && vehiclesData.length) {
    vehicleDetails = vehiclesData.map((v, i) => ({
      label: v.label || [v.year, v.make, v.model].filter(Boolean).join(' ') || `Vehicle ${i + 1}`,
      year: v.year || null,
      make: v.make || null,
      model: v.model || null,
      vin: v.vin || null,
      type: v.type || null,
      condition: v.condition || null,
      color: v.color || null,
      count: 1,
      price: v.price != null ? Number(v.price) : Math.round(price / (vehiclesData.length || 1))
    }));
  } else {
    vehicleDetails = [{
      label: r.vehicle_label,
      year: null, make: null, model: null, vin: null,
      type: null, condition: null, color: null,
      count: r.vehicle_count || 1,
      price
    }];
  }

  return {
    ...base,
    shipper: {
      name: r.shipper_email ? r.shipper_email.split('@')[0] : 'Shipper',
      company: null,
      email: r.shipper_email || null,
      phone: null,
      address: null
    },
    shipperContact: {
      name: null,
      phone: null,
      email: r.shipper_email || null
    },
    pickup: {
      name: r.origin_city || 'Pickup',
      address: originAddr,
      contact: null,
      phone: null,
      eta: r.pickup_label || 'Available Now',
      unavailable: null,
      notes: r.pickup_notes || null
    },
    dropoff: {
      name: r.dest_city || 'Destination',
      address: destAddr,
      contact: null,
      phone: null,
      eta: r.deliver_date || 'TBD',
      unavailable: null,
      notes: r.dropoff_notes || null
    },
    vehicles: vehicleDetails,
    attachments,
    transportType: null,
    total: price
  };
}

function orderToListing(order, detail = false) {
  const loc = order.location || {};
  const contact = order.contact || {};
  const origin = parseCityState(loc.pickup);
  const dest = parseCityState(loc.delivery);
  const vehicles = order.vehicles || (order.vehicle ? [order.vehicle] : []);
  const count = vehicles.length || 1;
  const v = vehicles[0] || order.vehicle || {};
  const vehicleLabel = count > 1
    ? `${count} Vehicles`
    : [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
  // Admin-intake orders carry a real distance; web orders don't, so estimate from price
  const miles = Number(order.distance) || Math.max(200, Math.round(Number(order.total) / 1.2));
  const price = Number(order.total) || 0;
  const deliverDate = order.mustDeliverBy || order.pickupDate;
  const fmtDate = deliverDate
    ? new Date(deliverDate).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' })
    : 'TBD';
  const pickupFmt = order.pickupDate
    ? new Date(order.pickupDate).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
    : 'Available Now';

  const base = {
    id: order.id,
    source: 'order',
    origin: { city: origin.city, state: origin.state, pickupLabel: pickupFmt, address: loc.pickup || '' },
    destination: { city: dest.city, state: dest.state, deliverDate: fmtDate, address: loc.delivery || '' },
    vehicle: vehicleLabel,
    vehicleCount: count,
    price,
    miles,
    ratePerMile: miles > 0 ? Math.round((price / miles) * 100) / 100 : 0,
    status: order.status,
    createdAt: order.createdAt || new Date().toISOString()
  };
  if (!detail) return base;

  const vehicleDetails = vehicles.map((veh, i) => {
    const item = veh || {};
    return {
      label: [item.year, item.make, item.model].filter(Boolean).join(' ') || `Vehicle ${i + 1}`,
      year: item.year || null,
      make: item.make || null,
      model: item.model || null,
      vin: item.vin || null,
      type: item.type || null,
      condition: item.condition || null,
      color: item.color || null,
      runsAndDrives: item.runsAndDrives,
      hasKeys: item.hasKeys,
      modified: item.modified,
      urgent: item.urgent,
      stockNumber: item.stockNumber || item.stock || null,
      curbWeight: item.curbWeight || null,
      dimensions: item.dimensions || null,
      trim: item.trim || null,
      bodySubType: item.bodySubType || null,
      gatePass: item.gatePass || null,
      photos: item.photos || [],
      count: 1,
      price: count > 0 ? Math.round(price / count) : price
    };
  });

  return {
    ...base,
    shipper: {
      name: contact.fullName || null,
      company: contact.company || null,
      email: contact.email || null,
      phone: contact.phone || null,
      address: null
    },
    shipperContact: {
      name: contact.fullName || null,
      phone: contact.phone || null,
      email: contact.email || null
    },
    pickup: {
      name: origin.city ? `${origin.city}${origin.state ? ', ' + origin.state : ''}` : 'Pickup',
      address: loc.pickup || [origin.city, origin.state].filter(Boolean).join(', '),
      contact: contact.fullName || null,
      phone: contact.phone || null,
      eta: pickupFmt,
      unavailable: null,
      notes: order.pickupNotes || null
    },
    dropoff: {
      name: dest.city ? `${dest.city}${dest.state ? ', ' + dest.state : ''}` : 'Delivery',
      address: loc.delivery || [dest.city, dest.state].filter(Boolean).join(', '),
      contact: null,
      phone: null,
      eta: fmtDate,
      unavailable: null,
      notes: order.deliveryNotes || null
    },
    vehicles: vehicleDetails.length ? vehicleDetails : [{
      label: vehicleLabel, year: null, make: null, model: null, vin: null,
      type: null, condition: null, color: null, count, price
    }],
    transportType: order.transportType || null,
    total: price
  };
}

function addBusinessDays(start, days) {
  const d = new Date(start);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

function fmtEstimateDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// GET all available listings
app.get('/api/exchange/listings', requireExchange, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM listings WHERE status = 'Available' ORDER BY created_at DESC"
    );
    const fromDb = rows.map(dbRowToListing);

    const [orderRows] = await pool.execute(
      "SELECT * FROM orders WHERE status IN ('New', 'Available', 'Posted') ORDER BY created_at DESC"
    );
    const safeParse = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch(e) { return null; }
    };
    const fromOrders = orderRows.map(r => orderToListing({
      id: r.id,
      status: r.status,
      location: safeParse(r.location) || {},
      vehicle: safeParse(r.vehicle),
      vehicles: safeParse(r.vehicles),
      pickupDate: r.pickup_date,
      mustDeliverBy: r.must_deliver_by,
      distance: r.distance,
      total: Number(r.total),
      createdAt: r.created_at
    }));

    const sort = req.query.sort || 'newest';
    let all = [...fromDb, ...fromOrders];
    if (sort === 'price_high') all.sort((a, b) => b.price - a.price);
    else if (sort === 'price_low') all.sort((a, b) => a.price - b.price);
    else all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(all);
  } catch (err) {
    console.error('GET /api/exchange/listings:', err);
    res.json([]);
  }
});

// GET single listing (full detail for modal)
app.get('/api/exchange/listings/:id', requireExchange, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM listings WHERE id = ?', [req.params.id]);
    if (rows.length > 0) return res.json(dbRowToListing(rows[0], true));

    const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (orderRows.length === 0) return res.status(404).json({ success: false });

    const r = orderRows[0];
    const safeParse = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch(e) { return null; }
    };
    res.json(orderToListing({
      id: r.id,
      status: r.status,
      contact: safeParse(r.contact) || {},
      location: safeParse(r.location) || {},
      vehicle: safeParse(r.vehicle),
      vehicles: safeParse(r.vehicles),
      pickupDate: r.pickup_date,
      mustDeliverBy: r.must_deliver_by,
      transportType: r.transport_type,
      distance: r.distance,
      total: Number(r.total),
      createdAt: r.created_at
    }, true));
  } catch (err) {
    console.error('GET /api/exchange/listings/:id:', err);
    res.status(500).json({ success: false });
  }
});

// GET pickup/delivery estimate options
app.get('/api/exchange/listings/:id/estimates', requireExchange, async (req, res) => {
  try {
    const today = new Date();
    const pickupOptions = [1, 2, 3, 4, 5].map(d => ({
      value: fmtEstimateDate(addBusinessDays(today, d)),
      label: fmtEstimateDate(addBusinessDays(today, d))
    }));
    const deliveryOptions = [3, 5, 7, 10, 14].map(d => ({
      value: fmtEstimateDate(addBusinessDays(today, d)),
      label: fmtEstimateDate(addBusinessDays(today, d))
    }));
    res.json({ pickupOptions, deliveryOptions });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// POST place bid (30-min cooldown per listing per carrier) — carrier identity comes from the session
app.post('/api/exchange/bids', requireCarrier, async (req, res) => {
  const { listingId, contactName, contactEmail, contactPhone, pickupEstimate, deliveryEstimate } = req.body;
  const carrierEmail = req.session.email;
  const amount = Number(req.body.amount);
  if (!listingId || !(amount > 0))
    return res.status(400).json({ success: false, message: 'Missing required fields' });

  try {
    const [recent] = await pool.execute(
      `SELECT created_at FROM bids
       WHERE listing_id = ? AND carrier_email = ?
       ORDER BY created_at DESC LIMIT 1`,
      [listingId, carrierEmail]
    );
    if (recent.length > 0) {
      const lastBid = new Date(recent[0].created_at);
      const diffMin = (Date.now() - lastBid.getTime()) / 60000;
      if (diffMin < 30) {
        const wait = Math.ceil(30 - diffMin);
        return res.status(429).json({
          success: false,
          message: `You may only place a bid on each load every 30 minutes. Try again in ${wait} min.`
        });
      }
    }

    await pool.execute(
      `INSERT INTO bids
         (listing_id, carrier_email, amount, contact_name, contact_email, contact_phone,
          pickup_estimate, delivery_estimate)
       VALUES (?,?,?,?,?,?,?,?)`,
      [listingId, carrierEmail, amount, contactName || null, contactEmail || null,
       contactPhone || null, pickupEstimate || null, deliveryEstimate || null]
    );

    if (contactName && carrierEmail) {
      await pool.execute(
        `INSERT INTO contacts (carrier_email, name, email, phone)
         SELECT ?,?,?,?
         WHERE NOT EXISTS (
           SELECT 1 FROM contacts WHERE carrier_email = ? AND name = ?
         )`,
        [carrierEmail, contactName, contactEmail || null, contactPhone || null,
         carrierEmail, contactName]
      );
    }

    res.json({ success: true, message: 'Bid placed successfully' });
  } catch (err) {
    console.error('POST /api/exchange/bids:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET bids — carriers see their own; shippers see bids on their listings; admins see all
app.get('/api/exchange/bids', requireExchange, async (req, res) => {
  try {
    const { listingId } = req.query;
    let sql = 'SELECT * FROM bids WHERE 1=1';
    const params = [];
    if (req.session.role === 'carrier') { sql += ' AND carrier_email = ?'; params.push(req.session.email); }
    else if (req.session.role === 'shipper') {
      sql += ' AND listing_id IN (SELECT id FROM listings WHERE shipper_email = ?)'; params.push(req.session.email);
    } else if (req.query.carrierEmail) { sql += ' AND carrier_email = ?'; params.push(String(req.query.carrierEmail)); }
    if (listingId)    { sql += ' AND listing_id = ?';    params.push(listingId); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// GET search contacts (min 3 chars) — own contacts only
app.get('/api/exchange/contacts', requireCarrier, async (req, res) => {
  const q = str(req.query.q, 100);
  const carrierEmail = actingEmail(req, req.query.carrierEmail);
  if (!q || q.length < 3) return res.json([]);
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, email, phone FROM contacts
       WHERE carrier_email = ? AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)
       ORDER BY name LIMIT 10`,
      [carrierEmail, `%${q}%`, `%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// POST add contact — saved under the signed-in carrier
app.post('/api/exchange/contacts', requireCarrier, async (req, res) => {
  const carrierEmail = actingEmail(req, req.body.carrierEmail);
  const name = str(req.body.name, 255), email = str(req.body.email, 255), phone = str(req.body.phone, 50);
  if (!name)
    return res.status(400).json({ success: false, message: 'Name required' });
  try {
    const [result] = await pool.execute(
      'INSERT INTO contacts (carrier_email, name, email, phone) VALUES (?,?,?,?)',
      [carrierEmail, name, email || null, phone || null]
    );
    res.json({ success: true, id: result.insertId, name, email, phone });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// POST instant book — denormalize listing data onto the booking row (carrier = session)
app.post('/api/exchange/book', requireCarrier, async (req, res) => {
  const { listingId, amount } = req.body;
  const carrierEmail = req.session.email;
  if (!listingId)
    return res.status(400).json({ success: false, message: 'Missing fields' });
  try {
    // Prefer exchange listing; fall back to order-as-listing
    let origin_city = null, origin_state = null, dest_city = null, dest_state = null;
    let vehicle_label = null, vehicle_count = 1, miles = 0, bookAmount = amount || 0;

    const [listingRows] = await pool.execute('SELECT * FROM listings WHERE id = ?', [listingId]);
    if (listingRows.length > 0) {
      const L = listingRows[0];
      origin_city = L.origin_city;
      origin_state = L.origin_state;
      dest_city = L.dest_city;
      dest_state = L.dest_state;
      vehicle_label = L.vehicle_label;
      vehicle_count = L.vehicle_count || 1;
      miles = L.miles || 0;
      if (!bookAmount) bookAmount = Number(L.price) || 0;
    } else {
      const [orderRows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [listingId]);
      if (orderRows.length > 0) {
        const r = orderRows[0];
        const safeParse = (val) => {
          if (!val) return null;
          if (typeof val === 'object') return val;
          try { return JSON.parse(val); } catch(e) { return null; }
        };
        const loc = safeParse(r.location) || {};
        const origin = parseCityState(loc.pickup);
        const dest = parseCityState(loc.delivery);
        origin_city = origin.city;
        origin_state = origin.state;
        dest_city = dest.city;
        dest_state = dest.state;
        const vehicles = safeParse(r.vehicles);
        const vehicle = safeParse(r.vehicle) || (vehicles && vehicles[0]) || {};
        const count = vehicles ? vehicles.length : 1;
        vehicle_count = count;
        vehicle_label = count > 1
          ? `${count} Vehicles`
          : [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle';
        if (!bookAmount) bookAmount = Number(r.total) || 0;
        miles = Number(r.distance) || Math.max(0, Math.round(bookAmount / 1.2));
      }
    }

    await pool.execute(
      `INSERT INTO bookings
         (listing_id, carrier_email, amount, status,
          origin_city, origin_state, dest_city, dest_state,
          vehicle_label, vehicle_count, miles)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        listingId, carrierEmail, bookAmount, 'Booked',
        origin_city, origin_state, dest_city, dest_state,
        vehicle_label, vehicle_count, miles
      ]
    );
    await pool.execute(
      "UPDATE listings SET status = 'Booked' WHERE id = ?",
      [listingId]
    );
    await pool.execute(
      "UPDATE orders SET status = 'Booked' WHERE id = ?",
      [listingId]
    );
    res.json({ success: true, message: 'Load booked successfully' });
  } catch (err) {
    console.error('POST /api/exchange/book:', err);
    res.status(500).json({ success: false });
  }
});

// GET carrier's loads (bookings with status progression) — own loads only
app.get('/api/exchange/loads', requireCarrier, async (req, res) => {
  const email = actingEmail(req, req.query.email);
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM bookings WHERE carrier_email = ? ORDER BY created_at DESC`,
      [email]
    );
    const loads = rows.map(r => ({
      id: r.id,
      listingId: r.listing_id,
      carrierEmail: r.carrier_email,
      amount: Number(r.amount),
      status: r.status || 'Booked',
      driverName: r.driver_name,
      pickedUpAt: r.picked_up_at,
      droppedOffAt: r.dropped_off_at,
      pickupEta: r.pickup_eta,
      dropoffEta: r.dropoff_eta,
      originCity: r.origin_city,
      originState: r.origin_state,
      destCity: r.dest_city,
      destState: r.dest_state,
      vehicleLabel: r.vehicle_label,
      vehicleCount: r.vehicle_count || 1,
      miles: r.miles || 0,
      invoiceUrl: r.invoice_url || null,
      bolUrl: r.bol_url || null,
      createdAt: r.created_at
    }));
    res.json(loads);
  } catch (err) {
    console.error('GET /api/exchange/loads:', err);
    res.json([]);
  }
});


// PATCH update a carrier load (driver, ETAs, status, invoice, BOL) — own loads only
app.patch('/api/exchange/loads/:id', requireCarrier, async (req, res) => {
  const { id } = req.params;
  const { status, invoice, bol } = req.body;
  const carrierEmail = actingEmail(req, req.body.carrierEmail);
  const driverName = str(req.body.driverName, 255), pickupEta = str(req.body.pickupEta, 50), dropoffEta = str(req.body.dropoffEta, 50);
  try {
    const [existing] = await pool.execute(
      'SELECT * FROM bookings WHERE id = ? AND carrier_email = ?',
      [id, carrierEmail]
    );
    if (existing.length === 0)
      return res.status(404).json({ success: false, message: 'Load not found' });

    const allowed = ['Booked', 'In Progress', 'Delivered', 'Completed'];
    const nextStatus = allowed.includes(status) ? status : existing[0].status;

    let pickedUpAt = existing[0].picked_up_at;
    let droppedOffAt = existing[0].dropped_off_at;
    if (nextStatus === 'In Progress' && !pickedUpAt) pickedUpAt = new Date();
    if ((nextStatus === 'Delivered' || nextStatus === 'Completed') && !droppedOffAt) {
      droppedOffAt = new Date();
      if (!pickedUpAt) pickedUpAt = new Date();
    }

    let invoiceUrl = existing[0].invoice_url || null;
    let bolUrl = existing[0].bol_url || null;
    if (invoice?.data) {
      const saved = await storeBase64Upload(invoice.data, FILE_FOLDERS.invoices, `invoice_${id}`);
      if (!saved) return res.status(400).json({ success: false, message: 'Invoice must be an image or PDF under 8 MB' });
      invoiceUrl = saved.url;
    }
    if (bol?.data) {
      const saved = await storeBase64Upload(bol.data, FILE_FOLDERS.bols, `bol_${id}`);
      if (!saved) return res.status(400).json({ success: false, message: 'BOL must be an image or PDF under 8 MB' });
      bolUrl = saved.url;
    }

    // Require docs when completing
    if (nextStatus === 'Completed' && !invoiceUrl && !bolUrl) {
      return res.status(400).json({
        success: false,
        message: 'Upload Invoice and/or BOL before marking the load as Completed'
      });
    }

    await pool.execute(
      `UPDATE bookings SET
         driver_name = ?, pickup_eta = ?, dropoff_eta = ?, status = ?,
         picked_up_at = ?, dropped_off_at = ?,
         invoice_url = ?, bol_url = ?
       WHERE id = ? AND carrier_email = ?`,
      [
        driverName || existing[0].driver_name,
        pickupEta || existing[0].pickup_eta,
        dropoffEta || existing[0].dropoff_eta,
        nextStatus,
        pickedUpAt,
        droppedOffAt,
        invoiceUrl,
        bolUrl,
        id,
        carrierEmail
      ]
    );

    // Keep listing / order status roughly in sync
    const listingId = existing[0].listing_id;
    const listingStatus =
      nextStatus === 'Completed' ? 'Completed' :
      nextStatus === 'Delivered' ? 'Delivered' :
      nextStatus === 'In Progress' ? 'In Progress' : 'Booked';
    await pool.execute('UPDATE listings SET status = ? WHERE id = ?', [listingStatus, listingId]);
    await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [listingStatus, listingId]);

    res.json({ success: true, invoiceUrl, bolUrl });
  } catch (err) {
    console.error('PATCH /api/exchange/loads/:id:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST shipper creates listing (shipper = session)
app.post('/api/exchange/listings', requireShipper, async (req, res) => {
  const b = req.body || {};
  b.shipperEmail = actingEmail(req, b.shipperEmail);
  let id = str(b.id, 20);
  if (!/^HX-[A-Z0-9-]{4,16}$/i.test(id)) id = 'HX-' + Date.now().toString().slice(-6);
  try {
    // Save attachments to disk (images / PDF only, max 10)
    const attachments = [];
    if (Array.isArray(b.attachments)) {
      for (let i = 0; i < Math.min(b.attachments.length, 10); i++) {
        const att = b.attachments[i];
        if (!att || !att.data) continue;
        const saved = await storeBase64Upload(att.data, FILE_FOLDERS.attachments, `${id}_${i}`);
        if (!saved) continue;
        attachments.push({
          name: str(att.name, 120) || saved.name,
          url: saved.url,
          mime: saved.mime,
          size: saved.size
        });
      }
    }

    const vehicles = Array.isArray(b.vehicles) ? b.vehicles : null;
    let vehicleLabel = b.vehicleLabel || 'Vehicle';
    let vehicleCount = Number(b.vehicleCount) || 1;
    if (vehicles && vehicles.length) {
      vehicleCount = vehicles.length;
      vehicleLabel = vehicles.length === 1
        ? (vehicles[0].label || [vehicles[0].year, vehicles[0].make, vehicles[0].model].filter(Boolean).join(' ') || 'Vehicle')
        : `${vehicles.length} Vehicles`;
    }

    await pool.execute(
      `INSERT INTO listings
         (id, origin_city, origin_state, dest_city, dest_state,
          vehicle_label, vehicle_count, price, miles, pickup_label, deliver_date, shipper_email,
          origin_address, dest_address, vehicles_json, pickup_notes, dropoff_notes, attachments_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        b.originCity || b.pickupName || 'Pickup',
        b.originState || '',
        b.destCity || b.destName || 'Destination',
        b.destState || '',
        vehicleLabel, vehicleCount,
        b.price || 0, b.miles || 0,
        b.pickupLabel || 'Available Now', b.deliverDate || null,
        b.shipperEmail || null,
        b.originAddress || null,
        b.destAddress || null,
        vehicles ? JSON.stringify(vehicles) : null,
        b.pickupNotes || null,
        b.dropoffNotes || null,
        attachments.length ? JSON.stringify(attachments) : null
      ]
    );
    res.json({ success: true, id });
  } catch (err) {
    console.error('POST /api/exchange/listings:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// VIN decode via NHTSA
app.get('/api/vin/:vin', publicLimiter, async (req, res) => {
  const vin = String(req.params.vin || '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{11,17}$/i.test(vin)) {
    return res.status(400).json({ success: false, message: 'Invalid VIN' });
  }
  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`;
    const resp = await fetch(url);
    const data = await resp.json();
    const r = (data.Results && data.Results[0]) || {};
    const year = r.ModelYear || null;
    const make = r.Make || null;
    const model = r.Model || null;
    const type = r.VehicleType || r.BodyClass || null;
    const label = [year, make, model].filter(Boolean).join(' ');
    if (!label) return res.json({ success: false, message: 'VIN not found' });
    res.json({
      success: true,
      vin,
      year,
      make,
      model,
      type,
      label,
      trim: r.Trim || null,
      bodyClass: r.BodyClass || null
    });
  } catch (err) {
    console.error('VIN decode:', err);
    res.status(500).json({ success: false, message: 'VIN lookup failed' });
  }
});

// GET shipper's own shipments (admin: all, or ?email= for one shipper)
app.get('/api/exchange/shipments', requireShipper, async (req, res) => {
  try {
    const email = req.session.role === 'admin' ? (req.query.email ? String(req.query.email) : null) : req.session.email;
    let listingSql = 'SELECT * FROM listings';
    const listingParams = [];
    if (email) { listingSql += ' WHERE shipper_email = ?'; listingParams.push(email); }
    listingSql += ' ORDER BY created_at DESC';
    const [listingRows] = await pool.execute(listingSql, listingParams);

    const [orderRows] = await pool.execute('SELECT * FROM orders ORDER BY created_at DESC');
    const safeParse = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch(e) { return null; }
    };

    // Attach carrier invoice/BOL from bookings when present
    const listingIds = listingRows.map(r => r.id);
    let docsByListing = {};
    if (listingIds.length) {
      const placeholders = listingIds.map(() => '?').join(',');
      const [bookingDocs] = await pool.execute(
        `SELECT listing_id, invoice_url, bol_url, status, carrier_email, driver_name
         FROM bookings WHERE listing_id IN (${placeholders})
         ORDER BY id DESC`,
        listingIds
      );
      for (const b of bookingDocs) {
        if (!docsByListing[b.listing_id]) {
          docsByListing[b.listing_id] = {
            invoiceUrl: b.invoice_url || null,
            bolUrl: b.bol_url || null,
            carrierEmail: b.carrier_email || null,
            driverName: b.driver_name || null,
            bookingStatus: b.status || null
          };
        }
      }
    }

    const fromListings = listingRows.map(r => {
      const docs = docsByListing[r.id] || {};
      return {
        id: r.id,
        status: r.status,
        origin: { city: r.origin_city, state: r.origin_state },
        destination: { city: r.dest_city, state: r.dest_state },
        vehicle: r.vehicle_label,
        price: Number(r.price),
        miles: r.miles,
        pickupDate: r.pickup_label,
        deliverDate: r.deliver_date,
        source: 'listing',
        invoiceUrl: docs.invoiceUrl || null,
        bolUrl: docs.bolUrl || null,
        carrierEmail: docs.carrierEmail || null,
        driverName: docs.driverName || null,
        createdAt: r.created_at
      };
    });

    // Orders only on unfiltered calls; shipper dashboard is listing-based by email
    let fromOrders = [];
    if (!email) {
      fromOrders = orderRows.map(r => {
        const loc = safeParse(r.location) || {};
        const vehicles = safeParse(r.vehicles);
        const vehicle = safeParse(r.vehicle) || (vehicles && vehicles[0]) || {};
        const count = vehicles ? vehicles.length : 1;
        return {
          id: r.id,
          status: r.status,
          origin: parseCityState(loc.pickup),
          destination: parseCityState(loc.delivery),
          vehicle: count > 1
            ? `${count} Vehicles`
            : [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || 'Vehicle',
          price: Number(r.total),
          pickupDate: r.pickup_date,
          deliverDate: r.must_deliver_by,
          source: 'order',
          createdAt: r.created_at
        };
      });
    }

    res.json([...fromListings, ...fromOrders]);
  } catch (err) {
    console.error('GET /api/exchange/shipments:', err);
    res.json([]);
  }
});

// DELETE a shipment (either an exchange listing or an order-based one)
// source query param disambiguates which table to delete from ('listing' | 'order')
app.delete('/api/exchange/shipments/:id', requireShipper, async (req, res) => {
  const { id } = req.params;
  const { source } = req.query;
  try {
    if (source === 'order') {
      // Website/phone orders are only deletable by admin
      if (req.session.role !== 'admin')
        return res.status(403).json({ success: false, message: 'Only admin can delete orders' });
      const [result] = await pool.execute('DELETE FROM orders WHERE id = ?', [id]);
      if (result.affectedRows === 0)
        return res.status(404).json({ success: false, message: 'Not found' });
      return res.json({ success: true });
    }

    // Default / 'listing': shippers may only delete their own listing
    let sql = 'DELETE FROM listings WHERE id = ?';
    const params = [id];
    if (req.session.role !== 'admin') { sql += ' AND shipper_email = ?'; params.push(req.session.email); }
    const [result] = await pool.execute(sql, params);
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found or not yours' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/exchange/shipments/:id:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ==================== API: STATS ====================

// Carrier stats: available board size + load pipeline + bids (own stats)
app.get('/api/exchange/carrier-stats', requireCarrier, async (req, res) => {
  const email = actingEmail(req, req.query.email);
  try {
    const [[bidsRow]] = await pool.query(
      'SELECT COUNT(*) AS totalBids FROM bids WHERE carrier_email = ?', [email]
    );
    const [[bookRow]] = await pool.query(
      `SELECT
         COUNT(*) AS totalBookings,
         COALESCE(SUM(amount),0) AS totalSpent,
         SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS inProgressCount,
         SUM(CASE WHEN status = 'Delivered' THEN 1 ELSE 0 END) AS deliveredCount,
         SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completedCount,
         SUM(CASE WHEN status = 'Booked' THEN 1 ELSE 0 END) AS bookedOpenCount
       FROM bookings WHERE carrier_email = ?`, [email]
    );
    const [[availRow]] = await pool.query(
      "SELECT COUNT(*) AS availableCount FROM listings WHERE status = 'Available'"
    );
    // Also count order-based available loads
    const [[orderAvail]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM orders WHERE status IN ('New', 'Available', 'Posted')"
    );
    const [[lastBidRow]] = await pool.query(
      'SELECT MAX(created_at) AS lastBidAt FROM bids WHERE carrier_email = ?', [email]
    );
    const totalBids = Number(bidsRow.totalBids) || 0;
    const totalBookings = Number(bookRow.totalBookings) || 0;
    const availableCount = (Number(availRow.availableCount) || 0) + (Number(orderAvail.cnt) || 0);
    res.json({
      email,
      totalBids,
      totalBookings,
      totalSpent: Number(bookRow.totalSpent) || 0,
      winRate: totalBids > 0 ? Math.round((totalBookings / totalBids) * 100) : 0,
      lastBidAt: lastBidRow.lastBidAt,
      availableCount,
      inProgressCount: Number(bookRow.inProgressCount) || 0,
      deliveredCount: Number(bookRow.deliveredCount) || 0,
      completedCount: Number(bookRow.completedCount) || 0,
      bookedOpenCount: Number(bookRow.bookedOpenCount) || 0
    });
  } catch (err) {
    console.error('GET /api/exchange/carrier-stats:', err);
    res.status(500).json({ success: false });
  }
});

// Shipper stats: listings posted, booked count, total value, avg price + status breakdown (own stats)
app.get('/api/exchange/shipper-stats', requireShipper, async (req, res) => {
  const email = actingEmail(req, req.query.email);
  try {
    const [[listRow]] = await pool.query(
      `SELECT COUNT(*) AS totalListings,
              SUM(CASE WHEN status = 'Booked' THEN 1 ELSE 0 END) AS bookedCount,
              SUM(CASE WHEN status = 'Available' OR status = 'New' OR status = 'Posted' THEN 1 ELSE 0 END) AS availableCount,
              SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS inProgressCount,
              SUM(CASE WHEN status IN ('Completed','Done','Delivered') THEN 1 ELSE 0 END) AS completedCount,
              COALESCE(SUM(price),0) AS totalValue
       FROM listings WHERE shipper_email = ?`, [email]
    );
    const totalListings = Number(listRow.totalListings) || 0;
    const totalValue = Number(listRow.totalValue) || 0;
    res.json({
      email,
      totalListings,
      bookedCount: Number(listRow.bookedCount) || 0,
      availableCount: Number(listRow.availableCount) || 0,
      inProgressCount: Number(listRow.inProgressCount) || 0,
      completedCount: Number(listRow.completedCount) || 0,
      totalValue,
      avgPrice: totalListings > 0 ? Math.round(totalValue / totalListings) : 0
    });
  } catch (err) {
    console.error('GET /api/exchange/shipper-stats:', err);
    res.status(500).json({ success: false });
  }
});

// ==================== 404 ====================
app.use((req, res) => res.status(404).render('404'));

// ==================== START ====================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 MC Transportation running on http://localhost:${PORT}`);
    console.log(`   Admin: http://localhost:${PORT}/admin\n`);
    if (!mailer && !useResendApi) console.log('   ✉️  Email disabled (no SMTP_HOST in .env) — confirmation links must be copied manually');
  });

  // Card-hold housekeeping: once at boot, then hourly (unref so it never blocks shutdown)
  const runExpiry = () => expireCardHolds().catch(e => console.error('expireCardHolds:', e.message));
  runExpiry();
  setInterval(runExpiry, 60 * 60 * 1000).unref();
  // Quote follow-up emails: hourly (each quote gets at most one day-2 and one day-6 email)
  setTimeout(() => sendQuoteFollowups(), 60 * 1000);
  setInterval(sendQuoteFollowups, 60 * 60 * 1000).unref();
  // Review requests the day after delivery: hourly
  setTimeout(() => sendReviewRequests(), 90 * 1000);
  setInterval(sendReviewRequests, 60 * 60 * 1000).unref();
  // Diesel index for the fuel surcharge: at boot, then daily (only refetches when older than 6 days)
  refreshFuelIndex().catch(() => {});
  setInterval(() => refreshFuelIndex().catch(() => {}), 24 * 3600 * 1000).unref();
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});

module.exports = { app, pool, expireCardHolds, sendQuoteFollowups, sendReviewRequests, setSmsTransport };
