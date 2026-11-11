const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb, seedDemoData } = require('./db/database');

// Laad .env bestand als het bestaat (zonder externe dependencies)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || 'pms.clubdisplay.nl';
// Versie van de checkout-pagina (app/index.html). Bump beide (server én index.html)
// samen zodat TV's zichzelf automatisch herladen bij een code-update.
const CHECKOUT_CODE_VERSION = 2;

app.use(express.json());

// Request logging voor debugging (zonder API key)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/checkout')) {
    console.log('→', req.method, req.path, req.headers['origin'] || '-');
  }
  next();
});

// CORS — nodig voor iframe op PCC portal (ander domein)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || (() => { console.error('WAARSCHUWING: SESSION_SECRET niet gezet, gebruik fallback — NIET veilig voor productie'); return 'dev-fallback-' + uuidv4(); })(),
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

// Alleen beheerders (gebruikers zonder klantkoppeling)
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.customerId) return res.status(403).json({ error: 'Geen toegang tot deze actie' });
  next();
}

// Beheerder mag alles; klantgebruiker alleen zijn eigen klant
function canAccessCustomer(req, customerId) {
  if (!req.session.customerId) return true;
  return String(req.session.customerId) === String(customerId);
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
  req.session.role = user.role || 'admin';
  req.session.customerId = user.customer_id || null;
  res.json({ success: true, username: user.username, role: user.role || 'admin', customerId: user.customer_id || null });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ username: req.session.username, role: req.session.role || 'admin', customerId: req.session.customerId || null });
});

// === Customers ===

app.get('/api/customers', requireAuth, (req, res) => {
  const userScope = req.session.customerId
    ? ' WHERE c.id = ?'
    : '';
  const params = req.session.customerId ? [req.session.customerId] : [];
  const customers = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM tvs WHERE customer_id = c.id) as tv_count,
      (SELECT username FROM users WHERE customer_id = c.id AND role = 'customer' LIMIT 1) as dashboard_username
    FROM customers c${userScope} ORDER BY c.created_at DESC
  `).all(...params);
  res.json(customers);
});

app.post('/api/customers', requireAdmin, (req, res) => {
  const { name, contact_email, tv_limit } = req.body;
  if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
  const apiKey = uuidv4();
  const result = db.prepare(
    'INSERT INTO customers (name, contact_email, api_key, tv_limit) VALUES (?, ?, ?, ?)'
  ).run(name, contact_email || null, apiKey, tv_limit || 1);
  res.json({ id: result.lastInsertRowid, api_key: apiKey });
});

app.put('/api/customers/:id', requireAdmin, (req, res) => {
  const { name, contact_email, tv_limit, active, daily_checkout, checkout_reboot } = req.body;
  db.prepare(
    'UPDATE customers SET name = COALESCE(?, name), contact_email = COALESCE(?, contact_email), tv_limit = COALESCE(?, tv_limit), active = COALESCE(?, active), daily_checkout = COALESCE(?, daily_checkout), checkout_reboot = COALESCE(?, checkout_reboot) WHERE id = ?'
  ).run(name || null, contact_email ?? null, tv_limit ?? null, active ?? null, daily_checkout ?? null, checkout_reboot ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/customers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE customer_id = ? AND role = ?').run(req.params.id, 'customer');
  res.json({ success: true });
});

app.post('/api/customers/:id/regenerate-key', requireAdmin, (req, res) => {
  const newKey = uuidv4();
  db.prepare('UPDATE customers SET api_key = ? WHERE id = ?').run(newKey, req.params.id);
  res.json({ api_key: newKey });
});

// === Klant-login (dashboard gebruiker) ===

app.post('/api/customers/:id/user', requireAdmin, (req, res) => {
  const { username, password } = req.body;
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

  const existing = db.prepare('SELECT id, password_hash FROM users WHERE customer_id = ? AND role = ?').get(req.params.id, 'customer');
  const finalUsername = (username || '').trim();
  if (!finalUsername) return res.status(400).json({ error: 'Gebruikersnaam is verplicht' });
  if (!existing && !password) return res.status(400).json({ error: 'Wachtwoord is verplicht' });

  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != COALESCE(?, 0)').get(finalUsername, existing ? existing.id : 0);
  if (taken) return res.status(400).json({ error: 'Gebruikersnaam is al in gebruik' });

  if (existing) {
    const hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
    db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?').run(finalUsername, hash, existing.id);
  } else {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash, customer_id, role) VALUES (?, ?, ?, ?)').run(finalUsername, hash, req.params.id, 'customer');
  }
  res.json({ success: true, username: finalUsername });
});

// === TVs ===

app.get('/api/customers/:id/tvs', requireAuth, (req, res) => {
  if (!canAccessCustomer(req, req.params.id)) return res.status(403).json({ error: 'Geen toegang' });
  const tvs = db.prepare(`
    SELECT t.*,
      CASE WHEN EXISTS (
        SELECT 1 FROM wipe_commands w
        WHERE w.customer_id = t.customer_id AND (w.tv_id IS NULL OR w.tv_id = t.id)
          AND w.id > COALESCE(t.last_wipe_command_id, 0)
      ) THEN 1 ELSE 0 END as pending_wipe
    FROM tvs t WHERE t.customer_id = ? ORDER BY t.created_at ASC
  `).all(req.params.id);
  res.json(tvs);
});

app.post('/api/customers/:id/tvs', requireAdmin, (req, res) => {
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

app.put('/api/tvs/:id', requireAdmin, (req, res) => {
  const { label, room_name } = req.body;
  db.prepare(
    'UPDATE tvs SET label = COALESCE(?, label), room_name = COALESCE(?, room_name) WHERE id = ?'
  ).run(label || null, room_name ?? null, req.params.id);
  res.json({ success: true });
});

app.delete('/api/tvs/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM tvs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// === Handmatig wissen (wipe) ===
// Beheerder of de klantgebruiker zelf kan een wis-verzoek klaarzetten. De TV
// (iframe) pollt dit op en voert idcap://tv/checkout/request uit.

app.post('/api/customers/:id/wipe', requireAuth, (req, res) => {
  if (!canAccessCustomer(req, req.params.id)) return res.status(403).json({ error: 'Geen toegang' });
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

  const tvId = req.body.tv_id || null;
  if (tvId) {
    const tv = db.prepare('SELECT id FROM tvs WHERE id = ? AND customer_id = ?').get(tvId, req.params.id);
    if (!tv) return res.status(404).json({ error: 'TV niet gevonden' });
  }
  const result = db.prepare('INSERT INTO wipe_commands (customer_id, tv_id, requested_by) VALUES (?, ?, ?)')
    .run(req.params.id, tvId, req.session.userId);
  res.json({ success: true, command_id: result.lastInsertRowid });
});

// === Checkout Logs ===

app.get('/api/logs', requireAuth, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  // Klantgebruiker ziet alleen de eigen logs
  const customerId = req.session.customerId ? req.session.customerId : req.query.customer_id;
  let sql = `
    SELECT l.*, c.name as customer_name, t.label as tv_label, t.room_name
    FROM checkout_logs l
    LEFT JOIN customers c ON l.customer_id = c.id
    LEFT JOIN tvs t ON l.tv_id = t.id
  `;
  const params = [];
  if (customerId) {
    sql += ' WHERE l.customer_id = ?';
    params.push(customerId);
  }
  sql += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));
  const logs = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM checkout_logs' + (customerId ? ' WHERE customer_id = ?' : '')).get(...(customerId ? [customerId] : [])).c;
  res.json({ logs, total });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const cust = req.session.customerId;
  const customersWhere = cust ? ' WHERE id = ?' : '';
  const tvsWhere = cust ? ' WHERE customer_id = ?' : '';
  const logsWhere = cust ? ' WHERE customer_id = ?' : '';
  const p = cust ? [cust] : [];
  const totalCustomers = db.prepare('SELECT COUNT(*) as c FROM customers' + customersWhere).get(...p).c;
  const activeCustomers = db.prepare('SELECT COUNT(*) as c FROM customers WHERE active = 1' + (cust ? ' AND id = ?' : '')).get(...p).c;
  const totalTvs = db.prepare('SELECT COUNT(*) as c FROM tvs' + tvsWhere).get(...p).c;
  const todayLogs = db.prepare("SELECT COUNT(*) as c FROM checkout_logs WHERE date(created_at) = date('now')" + (cust ? ' AND customer_id = ?' : '')).get(...p).c;
  const successToday = db.prepare("SELECT COUNT(*) as c FROM checkout_logs WHERE date(created_at) = date('now') AND success = 1" + (cust ? ' AND customer_id = ?' : '')).get(...p).c;
  res.json({ totalCustomers, activeCustomers, totalTvs, todayLogs, successToday });
});

// === TV Auto-registration (called by iframe) ===

app.post('/api/checkout/register', (req, res) => {
  const { api_key, device_id, serial_number, label } = req.body;
  if (!api_key || !device_id) return res.status(400).json({ error: 'api_key en device_id zijn verplicht' });

  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ? AND active = 1').get(api_key);
  if (!customer) return res.status(404).json({ error: 'Ongeldige of gedeactiveerde API key' });

  // Check if TV already registered
  let tv = db.prepare('SELECT id, label, serial_number FROM tvs WHERE customer_id = ? AND device_id = ?').get(customer.id, device_id);
  if (tv) {
    // Update serial_number if we have one and it wasn't set before
    if (serial_number && !tv.serial_number) {
      db.prepare('UPDATE tvs SET serial_number = ? WHERE id = ?').run(serial_number, tv.id);
    }
    return res.json({ id: tv.id, label: tv.label, registered: false });
  }

  // Check tv_limit
  const tvCount = db.prepare('SELECT COUNT(*) as c FROM tvs WHERE customer_id = ?').get(customer.id).c;
  const cust = db.prepare('SELECT tv_limit FROM customers WHERE id = ?').get(customer.id);
  if (tvCount >= cust.tv_limit) return res.status(400).json({ error: 'TV limiet bereikt' });

  // Auto-register this TV
  const ip = req.headers['x-forwarded-for'] || req.ip;
  const result = db.prepare(
    'INSERT INTO tvs (customer_id, device_id, serial_number, label, ip_address) VALUES (?, ?, ?, ?, ?)'
  ).run(customer.id, device_id, serial_number || null, label || device_id, ip);

  res.json({ id: result.lastInsertRowid, label: label || device_id, registered: true });
});

// Track page load (for debugging)
app.get('/api/track/load', (req, res) => {
  console.log('📺 PAGE LOAD — origin:', req.headers.origin || '-', 'ip:', req.ip, 'xff:', req.headers['x-forwarded-for'] || '-', 'real:', req.headers['x-real-ip'] || '-', 'client:', req.headers['x-client-ip'] || '-', 'ua:', (req.headers['user-agent'] || '-').slice(0, 80));
  res.json({ ok: true });
});

// Eenvoudige registratie via GET (voor HTML widgets zonder JS/fetch)
app.get('/api/checkout/pixel', (req, res) => {
  const { key, device_id } = req.query;
  if (!key || !device_id) return res.status(400).end();
  const customer = db.prepare('SELECT id, tv_limit FROM customers WHERE api_key = ? AND active = 1').get(key);
  if (!customer) return res.status(404).end();
  let tv = db.prepare('SELECT id FROM tvs WHERE customer_id = ? AND device_id = ?').get(customer.id, device_id);
  if (!tv) {
    const count = db.prepare('SELECT COUNT(*) as c FROM tvs WHERE customer_id = ?').get(customer.id).c;
    if (count < customer.tv_limit) {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      db.prepare('INSERT INTO tvs (customer_id, device_id, label, ip_address) VALUES (?, ?, ?, ?)').run(customer.id, device_id, device_id, ip);
    }
  }
  res.type('image/gif');
  res.end('GIF89a\u0001\u0000\u0001\u0000\x80\x00\u0000\xff\xff\xff\x00\x00\x00!\xf9\u0004\u0000\u0000\u0000\u0000\u0000,\u0000\u0000\u0000\u0000\u0000\u0001\u0000\x01\u0000\x00\x02\u0002D\x01\u0000;', 'binary');
});

// Update TV IP (via IDCAP lokaal IP)
app.post('/api/checkout/update-ip', (req, res) => {
  const { api_key, device_id, ip_address } = req.body;
  if (!api_key || !device_id || !ip_address) return res.status(400).json({ error: 'missende velden' });
  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ?').get(api_key);
  if (!customer) return res.status(404).end();
  db.prepare('UPDATE tvs SET ip_address = ? WHERE customer_id = ? AND device_id = ?').run(ip_address, customer.id, device_id);
  res.json({ ok: true });
});

// Script-based iframe injector (voor HTML widgets die iframes filteren)
app.get('/embed.js', (req, res) => {
  res.type('application/javascript');
  const key = req.query.key || '';
  const hour = req.query.hour || '11';
  const min = req.query.min || '0';
  res.send(`
(function(){
  var f = document.createElement('iframe');
  f.src = 'https://pms.clubdisplay.nl/?key=${encodeURIComponent(key)}&hour=${hour}&min=${min}';
  f.sandbox = 'allow-same-origin allow-scripts';
  f.style.cssText = 'width:100%;height:100%;border:none;position:absolute;top:0;left:0';
  document.currentScript.parentNode.appendChild(f);
})();
  `.trim());
});

// === Checkout Endpoint (called by iframe with API key) ===

app.get('/api/checkout/validate', (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ valid: false, error: 'API key is verplicht' });
  const customer = db.prepare('SELECT id, name, tv_limit, active, daily_checkout, checkout_reboot FROM customers WHERE api_key = ?').get(key);
  if (!customer) return res.status(404).json({ valid: false, error: 'Ongeldige API key' });
  if (!customer.active) return res.status(403).json({ valid: false, error: 'Account is gedeactiveerd' });
  res.json({
    valid: true,
    customer_id: customer.id,
    customer_name: customer.name,
    daily_checkout: customer.daily_checkout === 0 ? 0 : 1,
    checkout_reboot: customer.checkout_reboot === 0 ? 0 : 1
  });
});

function getCheckoutTime(req, res) {
  const hour = req.query.hour === undefined ? 11 : Number(req.query.hour);
  const min = req.query.min === undefined ? 0 : Number(req.query.min);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(min) || min < 0 || min > 59) {
    res.status(400).json({ error: 'Ongeldige checkouttijd' });
    return null;
  }
  return { hour, min };
}

function getLocalDay(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function getNextCheckoutTarget(hour, min, now) {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target;
}

function requireActiveCheckoutKey(req, res) {
  const key = req.query.key;
  if (!key) {
    res.status(400).json({ error: 'API key is verplicht' });
    return null;
  }
  const customer = db.prepare('SELECT id, daily_checkout FROM customers WHERE api_key = ? AND active = 1').get(key);
  if (!customer) {
    res.status(404).json({ error: 'Ongeldige of gedeactiveerde API key' });
    return null;
  }
  return customer;
}

app.get('/api/checkout/schedule', (req, res) => {
  const customer = requireActiveCheckoutKey(req, res);
  if (!customer) return;
  if (!customer.daily_checkout) {
    return res.json({ enabled: false, wait_ms: 3600000 });
  }
  const checkoutTime = getCheckoutTime(req, res);
  if (!checkoutTime) return;
  const now = new Date();
  const target = getNextCheckoutTarget(checkoutTime.hour, checkoutTime.min, now);
  res.json({
    enabled: true,
    server_now: now.toISOString(),
    server_day: getLocalDay(now),
    wait_ms: Math.max(1000, target.getTime() - now.getTime()),
    hour: checkoutTime.hour,
    min: checkoutTime.min
  });
});

app.get('/api/checkout/authorize', (req, res) => {
  const customer = requireActiveCheckoutKey(req, res);
  if (!customer) return;
  if (!customer.daily_checkout) {
    return res.json({ allowed: false, enabled: false, wait_ms: 3600000 });
  }
  const checkoutTime = getCheckoutTime(req, res);
  if (!checkoutTime) return;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), checkoutTime.hour, checkoutTime.min, 0, 0);
  const allowed = now >= target;
  res.json({
    allowed,
    server_now: now.toISOString(),
    server_day: getLocalDay(now),
    wait_ms: allowed ? 0 : Math.max(1000, target.getTime() - now.getTime())
  });
});

app.post('/api/checkout/log', (req, res) => {
  const { api_key, device_id, success, error_message, ip_address, user_agent } = req.body;
  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ?').get(api_key);
  if (!customer) return res.status(404).json({ error: 'Ongeldige API key' });

  // Find TV by device_id if provided
  let tvId = null;
  if (device_id) {
    const tv = db.prepare('SELECT id FROM tvs WHERE customer_id = ? AND device_id = ?').get(customer.id, device_id);
    if (tv) tvId = tv.id;
  }

  db.prepare(`
    INSERT INTO checkout_logs (customer_id, tv_id, api_key, ip_address, user_agent, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(customer.id, tvId, api_key, ip_address || null, user_agent || null, success ? 1 : 0, error_message || null);

  if (tvId && success) {
    db.prepare("UPDATE tvs SET last_checkout = datetime('now', 'localtime'), last_checkout_ok = 1 WHERE id = ?").run(tvId);
  } else if (tvId) {
    db.prepare("UPDATE tvs SET last_checkout = datetime('now', 'localtime'), last_checkout_ok = 0 WHERE id = ?").run(tvId);
  }

  res.json({ success: true });
});

// === Handmatig wissen: TV-poll endpoints (geen sessie, API key) ===

app.get('/api/checkout/wipe/pending', (req, res) => {
  const { key, device_id } = req.query;
  if (!key || !device_id) return res.status(400).json({ pending: false, version: CHECKOUT_CODE_VERSION });
  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ? AND active = 1').get(key);
  if (!customer) return res.status(404).json({ pending: false, version: CHECKOUT_CODE_VERSION });
  const tv = db.prepare('SELECT id, last_wipe_command_id FROM tvs WHERE customer_id = ? AND device_id = ?').get(customer.id, device_id);
  if (!tv) return res.json({ pending: false, version: CHECKOUT_CODE_VERSION });
  const cmd = db.prepare(`
    SELECT id FROM wipe_commands
    WHERE customer_id = ? AND (tv_id IS NULL OR tv_id = ?) AND id > COALESCE(?, 0)
    ORDER BY id DESC LIMIT 1
  `).get(customer.id, tv.id, tv.last_wipe_command_id);
  res.json({ pending: !!cmd, command_id: cmd ? cmd.id : null, version: CHECKOUT_CODE_VERSION });
});

app.post('/api/checkout/wipe/complete', (req, res) => {
  const { api_key, device_id, command_id } = req.body;
  if (!api_key || !device_id || !command_id) return res.status(400).json({ error: 'missende velden' });
  const customer = db.prepare('SELECT id FROM customers WHERE api_key = ?').get(api_key);
  if (!customer) return res.status(404).end();
  const tv = db.prepare('SELECT id FROM tvs WHERE customer_id = ? AND device_id = ?').get(customer.id, device_id);
  if (!tv) return res.status(404).end();
  db.prepare('UPDATE tvs SET last_wipe_command_id = ? WHERE id = ? AND (last_wipe_command_id IS NULL OR last_wipe_command_id < ?)')
    .run(parseInt(command_id), tv.id, parseInt(command_id));
  res.json({ success: true });
});

// Diagnostiek: TV meldt status van reboot/herstart-commando's
app.post('/api/checkout/reboot-status', (req, res) => {
  const { api_key, device_id, step, result } = req.body;
  const customer = api_key ? db.prepare('SELECT id FROM customers WHERE api_key = ?').get(api_key) : null;
  console.log(`🔄 REBOOT — customer:${customer ? customer.id : '?'} device:${device_id || '?'} step:${step || '?'} result:${typeof result === 'string' ? result : JSON.stringify(result || {})}`);
  res.json({ ok: true });
});

// === ACME / Let's Encrypt webroot ===
// Certbot schrijft hier de HTTP-01 challenge-bestanden. Zo kan het certificaat
// vernieuwd worden zonder poort 80 te binden (die is door deze app in gebruik).
const ACME_WEBROOT = process.env.ACME_WEBROOT || '/var/www/certbot';
app.use('/.well-known', express.static(path.join(ACME_WEBROOT, '.well-known')));

// === Dashboard frontend ===

app.use('/admin', express.static(path.join(__dirname, 'app', 'dashboard')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'dashboard', 'index.html'));
});
app.get('/admin/:page', (req, res) => {
  res.sendFile(path.join(__dirname, 'app', 'dashboard', 'index.html'));
});

// === Checkout page ===

// Cache-busting: redirect naar een versie-URL. Sommige TV-browsers negeren
// Cache-Control: no-store en cachen de oude pagina; door de URL te wijzigen
// laden ze gegarandeerd de nieuwste code.
app.get('/', (req, res) => {
  if (String(req.query.v) === String(CHECKOUT_CODE_VERSION)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.sendFile(path.join(__dirname, 'app', 'index.html'));
  }
  console.log('↪ REDIRECT naar v' + CHECKOUT_CODE_VERSION + ' — url:', req.originalUrl);
  const params = new URLSearchParams(req.query);
  params.set('v', CHECKOUT_CODE_VERSION);
  res.redirect(302, '/?' + params.toString());
});

app.use(express.static(path.join(__dirname, 'app'), {
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === 'index.html') res.setHeader('Cache-Control', 'no-store');
  }
}));

// === Error handling ===
// Vangt malformed JSON (bijv. scanners die form-data naar een JSON endpoint
// sturen) netjes af, zodat de error-log niet vervuilt met stacktraces.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Ongeldig verzoek (ongeldige JSON body)' });
  }
  console.error('Onverwachte fout:', err);
  res.status(err.status || 500).json({ error: 'Serverfout' });
});

// HTTP -> HTTPS redirect en HTTP server
app.listen(PORT, () => {
  console.log(`HTTP Server running at http://localhost:${PORT}`);
});

// HTTPS server
const sslPath = `/etc/letsencrypt/live/${DOMAIN}`;
if (fs.existsSync(`${sslPath}/fullchain.pem`)) {
  const httpsOptions = {
    key: fs.readFileSync(`${sslPath}/privkey.pem`),
    cert: fs.readFileSync(`${sslPath}/fullchain.pem`)
  };
  https.createServer(httpsOptions, app).listen(443, () => {
    console.log(`HTTPS Server running at https://${DOMAIN}`);
  });
} else {
  console.log('Geen SSL certificaat gevonden, HTTPS niet gestart');
}
