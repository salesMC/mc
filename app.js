// app.js
require('dotenv').config();
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
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text })
    });
    if (!r.ok) {
      let msg = `Resend HTTP ${r.status}`;
      try { const j = await r.json(); if (j && j.message) msg = j.message; } catch {}
      throw new Error(msg);
    }
  } finally { clearTimeout(timer); }
}

async function sendMail({ to, subject, html, text }) {
  if (!mailer && !useResendApi) {
    console.log(`📧 [mail not configured] would send "${subject}" to ${to}`);
    return { sent: false, reason: 'Email is not set up yet (add SMTP_HOST, SMTP_USER, SMTP_PASS to .env)' };
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (useResendApi) await sendViaResend({ from, to, subject, html, text });
  else await mailer.sendMail({ from, to, subject, html, text });
  return { sent: true };
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
    pickedUpAt    : r.picked_up_at || null,
    hasCardOnFile : !!r.stripe_payment_method_id,
    createdAt     : r.created_at
  };
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
const DEFAULT_CALCULATOR_CONFIG = {
  baseFee: 120,
  tiers: [
    { max: 30,   rate: 3.00 },
    { max: 70,   rate: 2.20 },
    { max: 110,  rate: 1.80 },
    { max: 160,  rate: 1.50 },
    { max: null, rate: 1.30 }   // null = no upper limit
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

// Same formula as the public calculator: per vehicle (base + tiered cpm × miles) × type, + add-ons
function computeQuote(cfg, vehicles, distance) {
  const miles = Math.max(0, Number(distance) || 0);
  let cpm = cfg.tiers[cfg.tiers.length - 1].rate;
  for (const t of cfg.tiers) {
    if (miles <= (t.max == null ? Infinity : t.max)) { cpm = t.rate; break; }
  }
  return vehicles.reduce((sum, v) => {
    let s = cfg.baseFee + cpm * miles;
    if (cfg.multipliers[v.type]) s *= cfg.multipliers[v.type];
    if (v.condition === 'inoperable') s += cfg.addons.inoperable;
    if (v.modified) s += cfg.addons.modified;
    if (v.urgent)   s += cfg.addons.urgent;
    return sum + Math.round(s);
  }, 0);
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
      ['charged_at', 'DATETIME'],
      ['charged_amount', 'DECIMAL(10,2)'],
      ['picked_up_at', 'DATETIME'],
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
    for (const [col, def] of [['name', 'VARCHAR(255)'], ['company', 'VARCHAR(255)']]) {
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
        ['admin@mctransportation.com', await bcrypt.hash(pw, 10), 'admin']
      );
      console.log('✅ Default admin created: admin@mctransportation.com (change the password after first login)');
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
// AWS S3 when AWS_S3_BUCKET is set; otherwise the local uploads/ folder.
// The bucket stays private — files are always served through /uploads/:name.
// ---------------------------------------------------------------------------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const S3_BUCKET = (process.env.AWS_S3_BUCKET || '').trim();
const S3_PREFIX = 'uploads/';
let s3 = null;
if (S3_BUCKET) {
  const { S3Client } = require('@aws-sdk/client-s3');
  // Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY automatically
  s3 = new S3Client({ region: (process.env.AWS_REGION || 'us-east-1').trim() });
  console.log(`📦 File storage: S3 bucket "${S3_BUCKET}"`);
} else {
  console.log('📦 File storage: local uploads/ folder (set AWS_S3_BUCKET to use S3)');
}

const UPLOAD_TYPES = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heic', 'application/pdf': 'pdf'
};
const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', pdf: 'application/pdf' };
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const UPLOAD_NAME_RE = /^[A-Za-z0-9_-]{1,120}\.(jpg|png|webp|gif|heic|pdf)$/;

async function storeFile(name, buf, mime) {
  if (s3) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: S3_PREFIX + name, Body: buf, ContentType: mime }));
  } else {
    fs.writeFileSync(path.join(uploadsDir, name), buf);
  }
}

// Decode a base64 data-URL (images / PDF only, size-capped) and store it under a
// server-chosen name (never the client's). Returns null when rejected.
async function storeBase64Upload(dataUrl, prefix) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const ext = UPLOAD_TYPES[mime];
  if (!ext) return null;
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length || buf.length > MAX_UPLOAD_BYTES) return null;
  const safeName = `${String(prefix).replace(/[^a-z0-9_-]/gi, '').slice(0, 60)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
  await storeFile(safeName, buf, MIME_BY_EXT[ext]);
  return { url: `/uploads/${safeName}`, mime: MIME_BY_EXT[ext], name: safeName, size: buf.length };
}

// Vehicle photos arrive as base64 inside the vehicles array. Store each one as a
// file and keep only {name, url} in the database.
async function storeVehiclePhotos(vehicles, prefix) {
  for (let i = 0; i < vehicles.length; i++) {
    const photos = Array.isArray(vehicles[i].photos) ? vehicles[i].photos : [];
    const stored = [];
    for (let k = 0; k < photos.length; k++) {
      const p = photos[k];
      if (p && typeof p.url === 'string' && /^\/uploads\/[A-Za-z0-9_-]+\.[a-z]+$/.test(p.url)) { stored.push({ name: p.name || '', url: p.url }); continue; }
      const saved = await storeBase64Upload(p && p.data, `${prefix}_v${i + 1}_${k + 1}`);
      if (saved) stored.push({ name: str(p.name, 120) || saved.name, url: saved.url });
    }
    vehicles[i].photos = stored;
  }
  return vehicles;
}

// Serve stored files as inert documents (no scripts, sandboxed) from S3 or disk.
app.get('/uploads/:name', async (req, res) => {
  const name = req.params.name;
  if (!UPLOAD_NAME_RE.test(name)) return res.status(404).end();
  const ext = name.slice(name.lastIndexOf('.') + 1);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (s3) {
    try {
      const { GetObjectCommand } = require('@aws-sdk/client-s3');
      const obj = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_PREFIX + name }));
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
  const file = path.join(uploadsDir, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', MIME_BY_EXT[ext]);
  fs.createReadStream(file).pipe(res);
});

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
const SESSION_COOKIE = 'mc_session';
const SESSION_TTL_SECONDS = { admin: 24 * 3600, carrier: 7 * 24 * 3600, shipper: 7 * 24 * 3600 };

function signSession(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}
function createSessionToken(user) {
  const ttl = SESSION_TTL_SECONDS[user.role] || 24 * 3600;
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
function setSessionCookie(req, res, user) {
  const ttl = SESSION_TTL_SECONDS[user.role] || 24 * 3600;
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${createSessionToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ttl}${req.secure ? '; Secure' : ''}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
app.use((req, res, next) => { req.session = readSession(req); next(); });

// Values every template can use (keys live in .env, not in the page source files)
app.use((req, res, next) => {
  res.locals.googleMapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
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
app.get('/',               (req, res) => res.render('index'));
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
app.get('/admin/orders',      requireAdminPage, (req, res) => res.render('admin/orders'));
app.get('/admin/customers',   requireAdminPage, (req, res) => res.render('admin/customers'));
app.get('/admin/promo-codes', requireAdminPage, (req, res) => res.render('admin/promo-codes'));
app.get('/admin/calculator',  requireAdminPage, (req, res) => res.render('admin/calculator'));
app.get('/sign-in',        (req, res) => res.render('sign-in'));
app.get('/register',       (req, res) => res.render('register'));

app.get('/exchange/listings',  (req, res) => res.render('exchange/listings'));
app.get('/exchange/shipments', (req, res) => res.render('exchange/shipments'));

// ==================== API: ORDERS ====================

// GET all orders (photos stripped — only loaded in detail view)
app.get('/api/orders', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    res.json(rows.map(r => mapOrderRow(r)));
  } catch (err) {
    console.error('GET /api/orders:', err);
    res.json([]);
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

    await pool.execute(
      `INSERT INTO orders
         (id, status, contact, vehicle, vehicles, location,
          pickup_date, must_deliver_by, transport_type, total,
          customer_id, source, payment_status, distance, notes,
          stripe_payment_intent_id, charged_at, charged_amount, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        id, 'New',
        JSON.stringify(contact),
        JSON.stringify(vehicles[0]),
        JSON.stringify(vehicles),
        JSON.stringify(location),
        pickupDate, mustDeliverBy, transportType, total,
        customerId, source, paymentStatus, distance, notes,
        stripePiId, stripePiId ? new Date() : null, stripePiId ? total : null
      ]
    );
    console.log(`New order: ${id}${isAdmin ? ' (admin intake)' : ` (web, ${money(total)} paid)`}`);
    res.json({ success: true, orderId: id, customerId, total });
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
  const allowed = ['New', 'In Work', 'Done', 'Canceled'];
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
app.delete('/api/orders/:id', requireAdmin, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM orders WHERE id = ?',
      [req.params.id]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE order:', err);
    res.status(500).json({ success: false });
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

function receiptEmail(order, holdAmount) {
  const name = (order.contact || {}).fullName || 'there';
  const html = emailShell(`
    <h1 style="margin:0 0 12px;font-size:22px">You're confirmed</h1>
    <p>Hi ${escHtml(name)},</p>
    <p>Thank you — your pickup is confirmed. A temporary hold of <strong>${money(holdAmount)}</strong> has been placed on your card. <strong>You will only be charged once the vehicle is picked up.</strong></p>
    ${summaryTableHtml(order)}
    <p style="font-size:13px;color:#6b7280">Reminder: if the vehicle is not available when our carrier arrives, or the pickup is cancelled with less than 24 hours' notice, the no-show fee of ${money(orderFee(order))} applies as agreed.</p>
    <p style="font-size:13px;color:#6b7280">Need to change anything? Call ${COMPANY_PHONE}.</p>`);
  const text = `Hi ${name},\n\nYour pickup is confirmed. A temporary hold of ${money(holdAmount)} has been placed on your card. You will only be charged once the vehicle is picked up.\n\n${summaryText(order)}\n\nQuestions? Call ${COMPANY_PHONE}.`;
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
      description         : `MC Transportation – pickup authorization for order ${order.id}`,
      metadata            : { orderId: order.id, kind: 'pickup_hold', agreementVersion: AGREEMENT_VERSION }
    });

    await pool.execute(
      `UPDATE orders SET stripe_customer_id = ?, stripe_payment_intent_id = ?,
              agreed_name = ?, agreed_ip = ?, agreed_at = NOW()
       WHERE id = ?`,
      [stripeCustomerId, pi.id, String(agreedName).trim().slice(0, 255), clientIp(req), order.id]
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

    const pi = await stripe.paymentIntents.retrieve(piId);
    if (!pi.metadata || pi.metadata.orderId !== row.id)
      return res.status(400).json({ success: false, message: 'Payment does not belong to this order' });
    if (pi.status !== 'requires_capture')
      return res.status(400).json({ success: false, message: `Card authorization not completed (status: ${pi.status})` });

    const paymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method && pi.payment_method.id) || null;
    const holdExpires = new Date(pi.created * 1000 + HOLD_DAYS * 86400000);
    await pool.execute(
      `UPDATE orders SET payment_status = 'authorized', stripe_payment_intent_id = ?,
              stripe_payment_method_id = ?, hold_amount = ?, hold_expires_at = ?
       WHERE id = ?`,
      [pi.id, paymentMethodId, pi.amount / 100, holdExpires, row.id]
    );

    // Best-effort notifications (never fail the confirmation because of email)
    const order = mapOrderRow(row, false);
    const c = order.contact || {};
    try {
      if (c.email) await sendMail({ to: c.email, ...receiptEmail(order, pi.amount / 100) });
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
    res.json({ success: true, link, emailSent: mail.sent, emailError: mail.sent ? null : mail.reason, sentTo: email || null });
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
    const amountCents = Math.round(Number(row.total) * 100);

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
        description: `MC Transportation – transport charge for order ${row.id}`,
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
      description: `MC Transportation – no-show / dry-run fee for order ${row.id}`,
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
    res.json(rows.map(mapCustomerRow));
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

    setSessionCookie(req, res, user);
    res.json({ success: true, role: user.role, email: user.email, name: user.name || null });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
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

    const cfg = await getCalculatorConfig();
    const subtotal = computeQuote(cfg, vehicles, distance);
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
      description: 'MC Transportation – Vehicle Shipping',
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
    await pool.execute(
      'INSERT IGNORE INTO leads (email, source) VALUES (?,?)',
      [email, str(req.body.source, 100) || 'website']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/leads', requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM leads ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
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
      const saved = await storeBase64Upload(invoice.data, `invoice_${id}`);
      if (!saved) return res.status(400).json({ success: false, message: 'Invoice must be an image or PDF under 8 MB' });
      invoiceUrl = saved.url;
    }
    if (bol?.data) {
      const saved = await storeBase64Upload(bol.data, `bol_${id}`);
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
        const saved = await storeBase64Upload(att.data, `${id}_${i}`);
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
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});

module.exports = { app, pool, expireCardHolds };
