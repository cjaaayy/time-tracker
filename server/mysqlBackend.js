const mysql = require('mysql2/promise');

async function createMySqlBackend(environment = process.env) {
  const pool = mysql.createPool({
    host: environment.MYSQL_HOST || '127.0.0.1',
    port: Number(environment.MYSQL_PORT || 3306),
    user: required(environment.MYSQL_USER, 'MYSQL_USER'),
    password: required(environment.MYSQL_PASSWORD, 'MYSQL_PASSWORD'),
    database: required(environment.MYSQL_DATABASE, 'MYSQL_DATABASE'),
    waitForConnections: true,
    connectionLimit: boundedInteger(environment.MYSQL_POOL_SIZE, 10, 2, 50),
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    ssl: environment.MYSQL_SSL === 'true' ? { minVersion: 'TLSv1.2' } : undefined,
  });
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS time_tracker_state (
      state_key VARCHAR(64) NOT NULL PRIMARY KEY,
      payload JSON NOT NULL,
      updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `);
  const [rows] = await pool.query('SELECT state_key, payload FROM time_tracker_state');
  const state = new Map(rows.map((row) => [row.state_key, typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload]));
  let pending = Promise.resolve();
  return {
    get(key) { return state.get(key); },
    set(key, payload) {
      state.set(key, payload);
      pending = pending.then(() => pool.execute(
        'INSERT INTO time_tracker_state (state_key, payload) VALUES (?, CAST(? AS JSON)) ON DUPLICATE KEY UPDATE payload = VALUES(payload)',
        [key, JSON.stringify(payload)],
      ));
      return pending;
    },
    flush() { return pending; },
    ping() { return pool.query('SELECT 1'); },
    async close() { await pending; await pool.end(); },
  };
}

function required(value, name) {
  if (!value) throw new Error(`${name} muss gesetzt sein`);
  return value;
}
function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value || fallback);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

module.exports = { createMySqlBackend };
