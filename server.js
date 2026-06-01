const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, seedDemoData } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'virtual-pms-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

const db = getDb();

// Seed demo data on first start
seedDemoData();

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// === Auth ===

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Ongeldige inloggegevens' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ success: true, username: user.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: req.session.username });
});

// === Customers ===

app.get('/api/customers', requireAuth, (req, res) => {
  const customers = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM tvs WHERE customer_id = c.id) as tv_count
    FROM customers c ORDER BY c.created_at DESC
  `).all();
  res.json(customers);
});

app.post('/api/customers', requireAuth, (req, res) => {
  const { name, contact_email, tv_limit } = req.body;
  if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
  const apiKey = uuidv4();
  const result = db.prepare(
    'INSERT INTO customers (name, contact_email, api_key, tv_limit) VALUES (?, ?, ?, ?)'
  ).run(name, contact_email || null, apiKey, tv_limit || 1);
  res.json({ id: result.lastInsertRowid, api_key: apiKey });
});

app.put('/api/customers/:id', requireAuth, (req, res) => {
  const { name, contact_email, tv_limit, active } = req.body;
  db.prepare(
    'UPDATE customers SET name = COALESCE(?, name), contact_email = COALESCE(?, contact_email), tv_limit = COALESCE(?, tv_limit), active = COALESCE(?, active) WHERE id = ?'
  ).run(name || null, contact_email ?? null, tv_limit ?? null, active ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/customers/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/customers/:id/regenerate-key', requireAuth, (req, res) => {
  const newKey = uuidv4();
  db.prepare('UPDATE customers SET api_key = ? WHERE id = ?').run(newKey, req.params.id);
  res.json({ api_key: newKey });
});

// === TVs ===

app.get('/api/customers/:id/tvs', requireAuth, (req, res) => {
  const tvs = db.prepare('SELECT * FROM tvs WHERE customer_id = ? ORDER BY label').all(req.params.id);
  res.json(tvs);
});

app.post('/api/customers/:id/tvs', requireAuth, (req, res) => {
  const { label, room_name } = req.body;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
  const tvCount = db.prepare('SELECT COUNT(*) as c FROM tvs WHERE customer_id = ?').get(req.params.id).c;
  if (tvCount >= customer.tv_limit) {
    return res.status(400).json({ error: `Maximaal ${customer.tv_limit} TV's toegestaan` });
  }
  const result = db.prepare(
    'INSERT INTO tvs (customer_id, label, room_name) VALUES (?, ?, ?)'
  ).run(req.params.id, label, room_name || null);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/tvs/:id', requireAuth, (req, res) => {
  const { label, room_name } = req.body;
  db.prepare(
    'UPDATE tvs SET label = COALESCE(?, label), room_name = COALESCE(?, room_name) WHERE id = ?'
  ).run(label || null, room_name ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/tvs/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM tvs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// === Checkout Logs ===

app.get('/api/logs', requireAuth, (req, res) => {
  const { customer_id, limit = 50, offset = 0 } = req.query;
  let sql = `
    SELECT l.*, c.name as customer_name, t.label as tv_label, t.room_name
    FROM checkout_logs l
    LEFT JOIN customers c ON l.customer_id = c.id
    LEFT JOIN tvs t ON l.tv_id = t.id
  `;
  const params = [];
  if (customer_id) {
    sql += ' WHERE l.customer_id = ?';
    params.push(customer_id);
  }
  sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const logs = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM checkout_logs' + (customer_id ? ' WHERE customer_id = ?' : '')).get(...(customer_id ? [customer_id] : [])).c;
  res.json({ logs, total });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
  const activeCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE active = 1').get().c;
  const totalTvs = db.prepare('SELECT COUNT(*) as c FROM tvs').get().c;
  const todayLogs = db.prepare("SELECT COUNT(*) as c FROM checkout_logs WHERE date(created_at) = date('now')").get().c;
  const successToday = db.prepare("SELECT COUNT(*) as c FROM checkout_logs WHERE date(created_at) = date('now') AND success = 1").get().c;
  res.json({ totalCustomers, activeCustomers, totalTvs, todayLogs, successToday });
});

// === Checkout Endpoint (called by iframe with API key) ===

app.get('/api/checkout/validate', (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ valid: false, error: 'API key is verplicht' });
  const customer = db.prepare('SELECT id, name, tv_limit, active FROM customers WHERE api_key = ?').get(key);
  if (!customer) return res.status(404).json({ valid: false, error: 'Ongeldige API key' });
  if (!customer.active) return res.status(403).json({ valid: false, error: 'Account is gedeactiveerd' });
  res.json({ valid: true, customer_id: customer.id, customer_name: customer.name });
});

app.post('/api/checkout/log', (req, res) => {
  const { api_key, tv_id, success, error_message, ip_address, user_agent } = req.body;
  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ?').get(api_key);
  if (!customer) return res.status(404).json({ error: 'Ongeldige API key' });

  db.prepare(`
    INSERT INTO checkout_logs (customer_id, tv_id, api_key, ip_address, user_agent, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, tv_id || null, api_key, ip_address || null, user_agent || null, success ? 1 : 0, error_message || null);

  if (tv_id && success) {
    db.prepare('UPDATE tvs SET last_checkout = datetime("now"), last_checkout_ok = 1 WHERE id = ?').run(tv_id);
  }

  res.json({ success: true });
});

// === Dashboard frontend ===

app.use('/admin', express.static(path.join(__dirname, 'app', 'dashboard')));

app.get('/admin*', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'dashboard', 'index.html'));
});

// === Checkout page ===

app.use(express.static(path.join(__dirname, 'app')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
