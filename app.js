// app.js
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcryptjs');
const Stripe  = require('stripe');

// ==================== STRIPE ====================
// Replace with your LIVE secret key when going live
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app  = express();
const PORT = process.env.PORT || 3000;

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
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate older orders tables (customer link + phone-in order fields)
    const orderExtraCols = [
      ['customer_id', 'INT'],
      ['source', "VARCHAR(20) NOT NULL DEFAULT 'web'"],
      ['payment_status', "VARCHAR(20) NOT NULL DEFAULT 'paid'"],
      ['distance', 'INT'],
      ['notes', 'TEXT'],
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

    // Создать дефолтных пользователей если их нет
    const defaults = [
      { email: 'admin@mctransportation.com',  password: 'mcadmin2026',  role: 'admin'   },
      { email: 'carrier@mctransportation.com', password: 'carrier2026', role: 'carrier' },
      { email: 'shipper@mctransportation.com', password: 'shipper2026', role: 'shipper' },
    ];
    for (const u of defaults) {
      const [existing] = await conn.execute('SELECT id FROM employees WHERE email = ?', [u.email]);
      if (existing.length === 0) {
        const hash = await bcrypt.hash(u.password, 10);
        await conn.execute(
          'INSERT INTO employees (email, password, role) VALUES (?, ?, ?)',
          [u.email, hash, u.role]
        );
        console.log(`✅ Default ${u.role} created: ${u.email} / ${u.password}`);
      }
    }

    // Seed exchange listings if empty
    const [listingRows] = await conn.execute('SELECT id FROM listings LIMIT 1');
    if (listingRows.length === 0) {
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

    // Seed demo contacts for carrier
    const [contactRows] = await conn.execute('SELECT id FROM contacts LIMIT 1');
    if (contactRows.length === 0) {
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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

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

app.get('/admin',          (req, res) => res.render('admin'));
app.get('/sign-in',        (req, res) => res.render('sign-in'));
app.get('/register',       (req, res) => res.render('register'));

app.get('/exchange/listings',  (req, res) => res.render('exchange/listings'));
app.get('/exchange/shipments', (req, res) => res.render('exchange/shipments'));

// ==================== API: ORDERS ====================

// GET all orders (photos stripped — only loaded in detail view)
app.get('/api/orders', async (req, res) => {
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
app.get('/api/orders/:id', async (req, res) => {
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

// POST create order — from web checkout (source 'web', paid via Stripe)
// or from the admin phone-in intake (source 'admin', unpaid quote).
app.post('/api/orders', async (req, res) => {
  try {
    const b = req.body;
    const id      = b.id || ('MC-' + Date.now().toString().slice(-6));
    const contact = b.contact || {};
    const isAdmin = b.source === 'admin';
    const vehicles = Array.isArray(b.vehicles) ? b.vehicles : null;

    // Link the order to a customer record (never fatal for the order itself)
    let customerId = b.customerId ? Number(b.customerId) : null;
    try {
      customerId = await upsertCustomer(pool, {
        id: customerId,
        name: contact.fullName, email: contact.email, phone: contact.phone,
        company: contact.company, type: contact.type, notes: b.customerNotes
      }, isAdmin);
    } catch (e) {
      console.error('POST /api/orders customer upsert:', e.message);
    }

    await pool.execute(
      `INSERT INTO orders
         (id, status, contact, vehicle, vehicles, location,
          pickup_date, must_deliver_by, transport_type, total,
          customer_id, source, payment_status, distance, notes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        id,
        b.status                          || 'New',
        JSON.stringify(contact),
        JSON.stringify(b.vehicle || (vehicles && vehicles[0]) || null),
        JSON.stringify(vehicles),
        JSON.stringify(b.location        || {}),
        b.pickupDate                      || null,
        b.mustDeliverBy                   || null,
        b.transportType                   || 'open',
        b.total                           || 0,
        customerId,
        isAdmin ? 'admin' : 'web',
        b.paymentStatus || (isAdmin ? 'unpaid' : 'paid'),
        b.distance != null && b.distance !== '' ? Math.round(Number(b.distance)) : null,
        (b.notes || '').trim() || null,
      ]
    );
    console.log(`New order: ${id}${isAdmin ? ' (admin intake)' : ''}`);
    res.json({ success: true, orderId: id, customerId });
  } catch (err) {
    console.error('POST /api/orders:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH update payment status (phone-in orders start unpaid)
app.patch('/api/orders/:id/payment', async (req, res) => {
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
app.patch('/api/orders/:id/status', async (req, res) => {
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
app.delete('/api/orders/:id', async (req, res) => {
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

// ==================== API: CUSTOMERS ====================

const CUSTOMER_TYPES = ['dealer', 'auction', 'oem', 'fleet', 'individual', 'other'];

// GET customers with order stats (optional ?q= search)
app.get('/api/customers', async (req, res) => {
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
app.get('/api/customers/:id', async (req, res) => {
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
app.post('/api/customers', async (req, res) => {
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
app.patch('/api/customers/:id', async (req, res) => {
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
app.delete('/api/customers/:id', async (req, res) => {
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

// POST sign-in (returns success/fail; session handled client-side for now)
app.post('/api/auth/login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM employees WHERE email = ?', [email]
    );
    if (rows.length === 0)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, rows[0].password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const userRole = rows[0].role;
    if (role === 'admin' && userRole !== 'admin')
      return res.status(401).json({ success: false, message: 'Admin access required' });
    if (role && role !== 'admin' && userRole !== role)
      return res.status(401).json({ success: false, message: 'Invalid role for this account' });

    res.json({
      success: true,
      role: userRole,
      email: rows[0].email,
      name: rows[0].name || null
    });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ success: false });
  }
});

// POST public registration — carriers & shippers only (not admin)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, role, name, company } = req.body;
  if (!email || !password)
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  if (password.length < 6)
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

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
    res.json({ success: true, role: userRole, email: cleanEmail, name: (name || '').trim() || null });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    console.error('POST /api/auth/register:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST create employee (admin only – no middleware guard here, add JWT if needed)
app.post('/api/employees', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO employees (email, password, role) VALUES (?,?,?)',
      [email, hash, role || 'admin']
    );
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(409).json({ success: false, message: 'Email already exists' });
    res.status(500).json({ success: false });
  }
});

// GET list employees
app.get('/api/employees', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, role, created_at FROM employees ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// DELETE employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==================== API: STRIPE ====================

// POST create PaymentIntent — called from frontend before card charge
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || isNaN(amount) || amount < 50) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount),
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: 'MC Transportation – Vehicle Shipping'
    });
    res.json({ success: true, clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe PaymentIntent error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== API: PROMO CODES ====================

// GET all promo codes
app.get('/api/promo-codes', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// POST validate promo code (public — called from payment page)
app.post('/api/promo-codes/validate', async (req, res) => {
  const { code } = req.body;
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
app.post('/api/promo-codes', async (req, res) => {
  const { code, discount, type } = req.body;
  if (!code || !discount) return res.status(400).json({ success: false, message: 'Missing fields' });
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
app.patch('/api/promo-codes/:id', async (req, res) => {
  const { discount, type, active } = req.body;
  try {
    await pool.execute(
      'UPDATE promo_codes SET discount=?, type=?, active=? WHERE id=?',
      [discount, type || 'percent', active !== undefined ? active : 1, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// DELETE promo code
app.delete('/api/promo-codes/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM promo_codes WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ==================== API: LEADS ====================
app.post('/api/leads', async (req, res) => {
  try {
    await pool.execute(
      'INSERT IGNORE INTO leads (email, source) VALUES (?,?)',
      [req.body.email, req.body.source || 'website']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/leads', async (req, res) => {
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
app.get('/api/exchange/listings', async (req, res) => {
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
app.get('/api/exchange/listings/:id', async (req, res) => {
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
app.get('/api/exchange/listings/:id/estimates', async (req, res) => {
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

// POST place bid (30-min cooldown per listing per carrier)
app.post('/api/exchange/bids', async (req, res) => {
  const { listingId, carrierEmail, amount, contactName, contactEmail, contactPhone,
          pickupEstimate, deliveryEstimate } = req.body;
  if (!listingId || !carrierEmail || !amount)
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

// GET bids (for carrier or admin)
app.get('/api/exchange/bids', async (req, res) => {
  try {
    const { carrierEmail, listingId } = req.query;
    let sql = 'SELECT * FROM bids WHERE 1=1';
    const params = [];
    if (carrierEmail) { sql += ' AND carrier_email = ?'; params.push(carrierEmail); }
    if (listingId)    { sql += ' AND listing_id = ?';    params.push(listingId); }
    sql += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(sql, params);
    res.json(rows);
  } catch (err) {
    res.json([]);
  }
});

// GET search contacts (min 3 chars)
app.get('/api/exchange/contacts', async (req, res) => {
  const { q, carrierEmail } = req.query;
  if (!carrierEmail) return res.json([]);
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

// POST add contact
app.post('/api/exchange/contacts', async (req, res) => {
  const { carrierEmail, name, email, phone } = req.body;
  if (!carrierEmail || !name)
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

// POST instant book — denormalize listing data onto the booking row
app.post('/api/exchange/book', async (req, res) => {
  const { listingId, carrierEmail, amount } = req.body;
  if (!listingId || !carrierEmail)
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

// GET carrier's loads (bookings with status progression)
app.get('/api/exchange/loads', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
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

// Helper: save base64 file to uploads/
function saveBase64Upload(dataUrl, prefix) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mime = match[1];
  const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
  const safeName = `${prefix}_${Date.now()}.${ext}`;
  const filePath = path.join(uploadsDir, safeName);
  fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
  return { url: `/uploads/${safeName}`, mime, name: safeName };
}

// PATCH update a carrier load (driver, ETAs, status, invoice, BOL)
app.patch('/api/exchange/loads/:id', async (req, res) => {
  const { id } = req.params;
  const { carrierEmail, driverName, pickupEta, dropoffEta, status, invoice, bol } = req.body;
  if (!carrierEmail)
    return res.status(400).json({ success: false, message: 'carrierEmail required' });
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
      const saved = saveBase64Upload(invoice.data, `invoice_${id}`);
      if (saved) invoiceUrl = saved.url;
    }
    if (bol?.data) {
      const saved = saveBase64Upload(bol.data, `bol_${id}`);
      if (saved) bolUrl = saved.url;
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

// POST shipper creates listing
app.post('/api/exchange/listings', async (req, res) => {
  const b = req.body;
  const id = b.id || ('HX-' + Date.now().toString().slice(-6));
  try {
    // Save base64 attachments to disk
    const attachments = [];
    if (Array.isArray(b.attachments)) {
      for (let i = 0; i < b.attachments.length; i++) {
        const att = b.attachments[i];
        if (!att || !att.data) continue;
        const match = String(att.data).match(/^data:([^;]+);base64,(.+)$/);
        if (!match) continue;
        const mime = match[1];
        const ext = (att.name && att.name.includes('.'))
          ? att.name.split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '')
          : (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/g, '');
        const safeName = `${id}_${Date.now()}_${i}.${ext || 'bin'}`;
        const filePath = path.join(uploadsDir, safeName);
        fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
        attachments.push({
          name: att.name || safeName,
          url: `/uploads/${safeName}`,
          mime,
          size: att.size || null
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
app.get('/api/vin/:vin', async (req, res) => {
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

// GET shipper's own shipments
app.get('/api/exchange/shipments', async (req, res) => {
  try {
    const email = req.query.email;
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
app.delete('/api/exchange/shipments/:id', async (req, res) => {
  const { id } = req.params;
  const { source, shipperEmail } = req.query;
  try {
    if (source === 'order') {
      const [result] = await pool.execute('DELETE FROM orders WHERE id = ?', [id]);
      if (result.affectedRows === 0)
        return res.status(404).json({ success: false, message: 'Not found' });
      return res.json({ success: true });
    }

    // Default / 'listing': only allow deleting the shipper's own listing
    let sql = 'DELETE FROM listings WHERE id = ?';
    const params = [id];
    if (shipperEmail) { sql += ' AND shipper_email = ?'; params.push(shipperEmail); }
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

// Carrier stats: available board size + load pipeline + bids
app.get('/api/exchange/carrier-stats', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
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

// Shipper stats: listings posted, booked count, total value, avg price + status breakdown
app.get('/api/exchange/shipper-stats', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });
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
  });
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
