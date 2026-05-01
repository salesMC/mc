// app.js
require('dotenv').config();
const express = require('express');
const path    = require('path');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcryptjs');

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
        must_pickup_by VARCHAR(20),
        transport_type VARCHAR(20),
        total       DECIMAL(10,2) DEFAULT 0,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Таблица сотрудников
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS employees (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(255) UNIQUE NOT NULL,
        password   VARCHAR(255)        NOT NULL,
        role       VARCHAR(50)         NOT NULL DEFAULT 'admin',
        created_at DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP
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

    // Создать дефолтного админа если нет ни одного
    const [rows] = await conn.execute('SELECT id FROM employees LIMIT 1');
    if (rows.length === 0) {
      const hash = await bcrypt.hash('mcadmin2026', 10);
      await conn.execute(
        'INSERT INTO employees (email, password, role) VALUES (?, ?, ?)',
        ['admin@mctransportation.com', hash, 'admin']
      );
      console.log('✅ Default admin created: admin@mctransportation.com / mcadmin2026');
    }

    console.log('✅ Database initialized');
  } finally {
    conn.release();
  }
}

// ==================== MIDDLEWARE ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
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

// ==================== API: ORDERS ====================

// GET all orders
app.get('/api/orders', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM orders ORDER BY created_at DESC'
    );
    // MySQL2 may return JSON columns already parsed as objects
    const safeParse = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch(e) { return null; }
    };

    // Strip photos from list view — only load them in detail view
    const stripPhotos = (v) => {
      if (!v) return v;
      const { photos, ...rest } = v;
      return rest;
    };

    const orders = rows.map(r => {
      const vehicles = safeParse(r.vehicles);
      const vehicle  = safeParse(r.vehicle) || (vehicles && vehicles.length ? vehicles[0] : null);
      return {
        id           : r.id,
        status       : r.status,
        contact      : safeParse(r.contact) || {},
        vehicle      : stripPhotos(vehicle),
        vehicles     : vehicles ? vehicles.map(stripPhotos) : null,
        location     : safeParse(r.location) || {},
        pickupDate   : r.pickup_date,
        mustPickupBy : r.must_pickup_by,
        transportType: r.transport_type,
        total        : Number(r.total),
        createdAt    : r.created_at
      };
    });
    res.json(orders);
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

    const safeParse = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch(e) { return null; }
    };

    const r = rows[0];
    const vehicles = safeParse(r.vehicles);
    const vehicle  = safeParse(r.vehicle) || (vehicles && vehicles.length ? vehicles[0] : null);

    res.json({
      id           : r.id,
      status       : r.status,
      contact      : safeParse(r.contact) || {},
      vehicle,
      vehicles,
      location     : safeParse(r.location) || {},
      pickupDate   : r.pickup_date,
      mustPickupBy : r.must_pickup_by,
      transportType: r.transport_type,
      total        : Number(r.total),
      createdAt    : r.created_at
    });
  } catch (err) {
    console.error('GET /api/orders/:id', err);
    res.status(500).json({ success: false });
  }
});

// POST create order
app.post('/api/orders', async (req, res) => {
  try {
    const b = req.body;
    await pool.execute(
      `INSERT INTO orders
         (id, status, contact, vehicle, vehicles, location,
          pickup_date, must_pickup_by, transport_type, total, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        b.id                              || ('MC-' + Date.now().toString().slice(-6)),
        b.status                          || 'New',
        JSON.stringify(b.contact         || {}),
        JSON.stringify(b.vehicle         || null),
        JSON.stringify(b.vehicles        || null),
        JSON.stringify(b.location        || {}),
        b.pickupDate                      || null,
        b.mustPickupBy                    || null,
        b.transportType                   || 'open',
        b.total                           || 0,
      ]
    );
    console.log(`New order: ${b.id}`);
    res.json({ success: true, orderId: b.id });
  } catch (err) {
    console.error('POST /api/orders:', err);
    res.status(500).json({ success: false, message: 'Server error' });
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

// ==================== API: AUTH ====================

// POST sign-in (returns success/fail; session handled client-side for now)
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM employees WHERE email = ?', [email]
    );
    if (rows.length === 0)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const match = await bcrypt.compare(password, rows[0].password);
    if (!match)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    res.json({ success: true, role: rows[0].role, email: rows[0].email });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ success: false });
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
