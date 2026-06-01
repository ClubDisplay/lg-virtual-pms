const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'pms.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_email TEXT,
      api_key TEXT UNIQUE NOT NULL,
      tv_limit INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tvs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      device_id TEXT,
      label TEXT NOT NULL,
      room_name TEXT,
      last_checkout TEXT,
      last_checkout_ok INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checkout_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      tv_id INTEGER REFERENCES tvs(id) ON DELETE SET NULL,
      api_key TEXT,
      ip_address TEXT,
      user_agent TEXT,
      success INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add device_id column if it doesn't exist yet
  try {
    db.exec(`ALTER TABLE tvs ADD COLUMN device_id TEXT`);
  } catch(e) {
    // Column likely already exists, that's fine
  }

  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c === 0) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
    console.log('Default admin user created (admin / admin)');
  }
}

function seedDemoData() {
  const apiKey = uuidv4();
  const existing = db.prepare('SELECT id FROM customers WHERE name = ?').get('Demo Hotel');
  if (existing) return;

  const cust = db.prepare(
    'INSERT INTO customers (name, contact_email, api_key, tv_limit) VALUES (?, ?, ?, ?)'
  ).run('Demo Hotel', 'demo@hotel.nl', apiKey, 5);

  const tvInsert = db.prepare('INSERT INTO tvs (customer_id, label, room_name) VALUES (?, ?, ?)');
  for (let i = 1; i <= 3; i++) {
    tvInsert.run(cust.lastInsertRowid, `TV ${i}`, `Kamer ${100 + i}`);
  }

  console.log(`Demo customer created. API key: ${apiKey}`);
}

module.exports = { getDb, seedDemoData };
