/**
 * MySQL connection and schema init.
 * Creates database and tables on startup when USE_MEMORY is false.
 * Verifies table structure and adds any missing columns (auto-migrate).
 */

const mysql = require('mysql2/promise');
const { SCHEMA } = require('./schema');

const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'shamcash_api';

let pool = null;

function getConfig(useDatabase = true) {
  const config = {
    host: MYSQL_HOST,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  };
  if (useDatabase) config.database = MYSQL_DATABASE;
  return config;
}

/**
 * Get current columns for a table from INFORMATION_SCHEMA.
 */
async function getTableColumns(conn, tableName) {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [MYSQL_DATABASE, tableName]
  );
  return rows.map((r) => r.COLUMN_NAME.toLowerCase());
}

/**
 * Add missing columns to a table to match expected schema. Does not drop or change existing columns.
 */
async function ensureTableColumns(conn, tableName) {
  const expected = SCHEMA[tableName];
  if (!expected) return;
  const current = await getTableColumns(conn, tableName);
  const currentSet = new Set(current);
  for (const col of expected) {
    const name = col.name.toLowerCase();
    if (currentSet.has(name)) continue;
    if (col.key === 'PRI' || col.extra === 'auto_increment') continue;
    const nullStr = col.nullable !== false ? 'NULL' : 'NOT NULL';
    const def = col.default !== undefined ? ` DEFAULT ${col.default}` : '';
    const addSql = `ALTER TABLE \`${tableName}\` ADD COLUMN \`${col.name}\` ${col.type} ${nullStr}${def}`;
    await conn.query(addSql);
    console.log(`  [db] Added column ${tableName}.${col.name}`);
  }
}

/**
 * Create database if not exists, create tables if not exist, then ensure all columns exist.
 */
async function init() {
  const conn = await mysql.createConnection(getConfig(false));
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await conn.query(`USE \`${MYSQL_DATABASE}\``);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS pending_sessions (
        session_id VARCHAR(512) PRIMARY KEY,
        public_key VARCHAR(512),
        info_device JSON,
        enc_payload TEXT,
        aes_key_enc TEXT,
        created_at BIGINT NOT NULL
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INT AUTO_INCREMENT PRIMARY KEY,
        api_key VARCHAR(128) NOT NULL UNIQUE,
        session_id VARCHAR(512),
        credentials JSON NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);

    for (const tableName of Object.keys(SCHEMA)) {
      await ensureTableColumns(conn, tableName);
    }
  } finally {
    await conn.end();
  }

  pool = mysql.createPool(getConfig(true));
  return pool;
}

function getPool() {
  return pool;
}

async function query(sql, params = []) {
  if (!pool) throw new Error('Database not initialized. Call init() first.');
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = {
  init,
  getPool,
  query,
};
