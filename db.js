const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('\n⚠️  DATABASE_URL is not set!');
  console.error('   On Railway: go to your project → Add Service → Database → PostgreSQL');
  console.error('   Railway will inject DATABASE_URL automatically once the Postgres service is attached.\n');
  process.exit(1);
}

// Railway (and most managed Postgres hosts) inject DATABASE_URL automatically.
// SSL is required for Railway Postgres; rejectUnauthorized:false because Railway
// uses a self-signed cert on the internal proxy.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Convenience helpers so the rest of the code stays readable
pool.q   = (sql, p = []) => pool.query(sql, p).then(r => r.rows);
pool.one = (sql, p = []) => pool.query(sql, p).then(r => r.rows[0] ?? null);
pool.run = (sql, p = []) => pool.query(sql, p);

async function initDB() {
  // Create all tables (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id    SERIAL PRIMARY KEY,
      name  TEXT   NOT NULL,
      color TEXT   NOT NULL DEFAULT '#e74c3c'
    );

    CREATE TABLE IF NOT EXISTS custom_roles (
      id               SERIAL PRIMARY KEY,
      name             TEXT   UNIQUE NOT NULL,
      color            TEXT   NOT NULL DEFAULT '#7a6652',
      permission_level TEXT   NOT NULL DEFAULT 'member',
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      username       TEXT    UNIQUE NOT NULL,
      password_hash  TEXT    NOT NULL,
      plain_password TEXT,
      role           TEXT    NOT NULL DEFAULT 'member',
      team_id        INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      ip_address     TEXT    NOT NULL,
      banned         INTEGER DEFAULT 0,
      custom_role_id INTEGER REFERENCES custom_roles(id) ON DELETE SET NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ip_registry (
      ip_address TEXT    PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assignments (
      id          SERIAL PRIMARY KEY,
      title       TEXT    NOT NULL,
      description TEXT,
      due_date    TEXT    NOT NULL,
      team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS answer_keys (
      id            SERIAL PRIMARY KEY,
      assignment_id INTEGER UNIQUE REFERENCES assignments(id) ON DELETE CASCADE,
      status        TEXT    DEFAULT 'empty',
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS answer_key_entries (
      id            SERIAL PRIMARY KEY,
      answer_key_id INTEGER REFERENCES answer_keys(id) ON DELETE CASCADE,
      content       TEXT    NOT NULL,
      submitted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      status        TEXT    DEFAULT 'pending',
      approved_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      message    TEXT    NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      type       TEXT    NOT NULL DEFAULT 'blog',
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      pinned     INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      content    TEXT    NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id           SERIAL PRIMARY KEY,
      type         TEXT    NOT NULL DEFAULT 'bug',
      title        TEXT    NOT NULL,
      description  TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'open',
      priority     TEXT    NOT NULL DEFAULT 'normal',
      submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      mod_note     TEXT,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      query      TEXT    NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS game_plays (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id     TEXT    NOT NULL,
      game_name   TEXT    NOT NULL,
      play_count  INTEGER NOT NULL DEFAULT 1,
      last_played TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, game_id)
    );
  `);

  // Seed default teams on first run
  const { rows } = await pool.query('SELECT COUNT(*) AS c FROM teams');
  if (parseInt(rows[0].c) === 0) {
    await pool.query(`
      INSERT INTO teams (name, color) VALUES
        ('Team Imagine', '#e74c3c'),
        ('Team Horizon', '#3498db'),
        ('Team Apex',    '#27ae60')
    `);
  }

  console.log('[db] PostgreSQL ready');
}

module.exports = { pool, initDB };
