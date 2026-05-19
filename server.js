const express      = require('express');
const path         = require('path');
const https        = require('https');
const cookieParser = require('cookie-parser');
const jwt          = require('jsonwebtoken');
const bcrypt       = require('bcryptjs');
const { pool, initDB } = require('./db');

const app = express();
const PORT           = process.env.PORT || 3000;
const JWT_SECRET     = process.env.JWT_SECRET || 'dev_secret_change_in_prod_' + Date.now();
const DISABLE_IP_CHECK = process.env.DISABLE_IP_CHECK !== 'false';
const IS_PROD        = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));  // large limit for base64 image uploads
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

async function requireAuth(req, res, next) {
  try {
    const token = req.cookies.token ||
      (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const payload = jwt.verify(token, JWT_SECRET);
    const user = await pool.one(`
      SELECT u.id, u.username, u.role, u.team_id, u.banned, u.custom_role_id,
             cr.name AS custom_role_name, cr.color AS custom_role_color
      FROM users u
      LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
      WHERE u.id = $1
    `, [payload.id]);

    if (!user || user.banned) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!roles.includes(req.user.role))
        return res.status(403).json({ error: 'Forbidden' });
      next();
    });
  };
}

// Wrap async route handlers so unhandled rejections become 500s
const a = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────
app.post('/api/auth/register', a(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const ip = getIP(req);

  if (!DISABLE_IP_CHECK) {
    const ipTaken = await pool.one('SELECT 1 FROM ip_registry WHERE ip_address = $1', [ip]);
    if (ipTaken)
      return res.status(403).json({ error: 'An account already exists from this network address' });
  }

  const existing = await pool.one('SELECT id FROM users WHERE username = $1', [username]);
  if (existing)
    return res.status(400).json({ error: 'Username is already taken' });

  const hash    = bcrypt.hashSync(password, 10);
  const { rows: cnt } = await pool.query('SELECT COUNT(*) AS c FROM users');
  const role    = parseInt(cnt[0].c) === 0 ? 'owner' : 'member';

  const result  = await pool.one(
    'INSERT INTO users (username, password_hash, role, ip_address) VALUES ($1,$2,$3,$4) RETURNING id',
    [username, hash, role, ip]
  );
  await pool.run(
    'INSERT INTO ip_registry (ip_address, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [ip, result.id]
  );

  const token = jwt.sign({ id: result.id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 7*24*60*60*1000 });
  res.json({ user: { id: result.id, username, role } });
}));

app.post('/api/auth/login', a(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await pool.one(`
    SELECT u.*, cr.name AS custom_role_name, cr.color AS custom_role_color
    FROM users u LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
    WHERE u.username = $1
  `, [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid username or password' });
  if (user.banned)
    return res.status(403).json({ error: 'This account has been banned' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 7*24*60*60*1000 });
  res.json({ user: { id: user.id, username: user.username, role: user.role, team_id: user.team_id,
    custom_role_id: user.custom_role_id, custom_role_name: user.custom_role_name, custom_role_color: user.custom_role_color } });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

// ─────────────────────────────────────────────
// TEAMS
// ─────────────────────────────────────────────
app.get('/api/teams', requireAuth, a(async (req, res) => {
  res.json(await pool.q('SELECT * FROM teams ORDER BY id'));
}));

app.post('/api/teams', requireRole('owner'), a(async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const r = await pool.one('INSERT INTO teams (name, color) VALUES ($1,$2) RETURNING id', [name, color || '#888']);
  res.json({ id: r.id, name, color });
}));

app.put('/api/teams/:id', requireRole('owner'), a(async (req, res) => {
  const { name, color } = req.body;
  await pool.run('UPDATE teams SET name=$1, color=$2 WHERE id=$3', [name, color, req.params.id]);
  res.json({ success: true });
}));

app.delete('/api/teams/:id', requireRole('owner'), a(async (req, res) => {
  await pool.run('UPDATE users       SET team_id=NULL WHERE team_id=$1', [req.params.id]);
  await pool.run('UPDATE assignments SET team_id=NULL WHERE team_id=$1', [req.params.id]);
  await pool.run('DELETE FROM teams WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// ASSIGNMENTS
// ─────────────────────────────────────────────
app.get('/api/assignments', requireAuth, a(async (req, res) => {
  const { month, year, team_id } = req.query;

  let sql = `
    SELECT a.*,
           t.name  AS team_name,
           t.color AS team_color,
           u.username AS creator_name
    FROM assignments a
    LEFT JOIN teams t ON a.team_id = t.id
    LEFT JOIN users u ON a.created_by = u.id
  `;
  const conditions = [], params = [];

  if (month && year) {
    params.push(`${String(month).padStart(2,'0')}-${year}`);
    conditions.push(`TO_CHAR(a.due_date::date, 'MM-YYYY') = $${params.length}`);
  }
  if (team_id) {
    params.push(team_id);
    conditions.push(`a.team_id = $${params.length}`);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY a.due_date ASC';

  res.json(await pool.q(sql, params));
}));

app.get('/api/assignments/:id', requireAuth, a(async (req, res) => {
  const a = await pool.one(`
    SELECT a.*, t.name AS team_name, t.color AS team_color, u.username AS creator_name
    FROM assignments a
    LEFT JOIN teams t ON a.team_id = t.id
    LEFT JOIN users u ON a.created_by = u.id
    WHERE a.id = $1
  `, [req.params.id]);
  if (!a) return res.status(404).json({ error: 'Assignment not found' });
  res.json(a);
}));

app.post('/api/assignments', requireAuth, a(async (req, res) => {
  if (!['owner','mod','contributor'].includes(req.user.role))
    return res.status(403).json({ error: 'Only contributors, mods, and owners can create assignments' });

  const { title, description, due_date, team_id } = req.body;
  if (!title || !due_date)
    return res.status(400).json({ error: 'Title and due date are required' });

  const r = await pool.one(
    'INSERT INTO assignments (title, description, due_date, team_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [title, description || null, due_date, team_id || null, req.user.id]
  );
  await pool.run('INSERT INTO answer_keys (assignment_id) VALUES ($1)', [r.id]);
  res.json({ id: r.id, title, description, due_date, team_id: team_id || null });
}));

app.put('/api/assignments/:id', requireAuth, a(async (req, res) => {
  const existing = await pool.one('SELECT * FROM assignments WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const canEdit =
    ['owner','mod'].includes(req.user.role) ||
    (req.user.role === 'contributor' && existing.created_by === req.user.id);
  if (!canEdit) return res.status(403).json({ error: 'Forbidden' });

  const { title, description, due_date, team_id } = req.body;
  await pool.run(
    'UPDATE assignments SET title=$1, description=$2, due_date=$3, team_id=$4 WHERE id=$5',
    [title, description || null, due_date, team_id || null, req.params.id]
  );
  res.json({ success: true });
}));

app.delete('/api/assignments/:id', requireRole('owner','mod'), a(async (req, res) => {
  await pool.run('DELETE FROM assignments WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// ANSWER KEYS
// ─────────────────────────────────────────────
app.get('/api/answer-keys/:assignmentId', requireAuth, a(async (req, res) => {
  const key = await pool.one('SELECT * FROM answer_keys WHERE assignment_id=$1', [req.params.assignmentId]);
  if (!key) return res.status(404).json({ error: 'Answer key not found' });

  const entries = await pool.q(`
    SELECT e.*, u.username AS submitter_name, u2.username AS approver_name
    FROM answer_key_entries e
    LEFT JOIN users u  ON e.submitted_by = u.id
    LEFT JOIN users u2 ON e.approved_by  = u2.id
    WHERE e.answer_key_id = $1
    ORDER BY e.created_at DESC
  `, [key.id]);

  res.json({ ...key, entries });
}));

app.post('/api/answer-keys/:assignmentId/entries', requireAuth, a(async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });

  const key = await pool.one('SELECT * FROM answer_keys WHERE assignment_id=$1', [req.params.assignmentId]);
  if (!key) return res.status(404).json({ error: 'Answer key not found' });

  const r = await pool.one(
    'INSERT INTO answer_key_entries (answer_key_id, content, submitted_by) VALUES ($1,$2,$3) RETURNING id',
    [key.id, content.trim(), req.user.id]
  );
  await pool.run(
    "UPDATE answer_keys SET status='pending' WHERE id=$1 AND status='empty'",
    [key.id]
  );
  res.json({ id: r.id, status: 'pending' });
}));

app.put('/api/answer-key-entries/:id/approve', requireRole('owner','mod'), a(async (req, res) => {
  const entry = await pool.one('SELECT * FROM answer_key_entries WHERE id=$1', [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  await pool.run(
    "UPDATE answer_key_entries SET status='approved', approved_by=$1 WHERE id=$2",
    [req.user.id, req.params.id]
  );
  await pool.run(
    "UPDATE answer_keys SET status='approved' WHERE id=$1",
    [entry.answer_key_id]
  );
  res.json({ success: true });
}));

app.put('/api/answer-key-entries/:id/reject', requireRole('owner','mod'), a(async (req, res) => {
  const entry = await pool.one('SELECT * FROM answer_key_entries WHERE id=$1', [req.params.id]);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  await pool.run(
    "UPDATE answer_key_entries SET status='rejected', approved_by=$1 WHERE id=$2",
    [req.user.id, req.params.id]
  );
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────────
app.get('/api/chat', requireAuth, a(async (req, res) => {
  const since = parseInt(req.query.since) || 0;

  let messages;
  if (since === 0) {
    const rows = await pool.q(`
      SELECT m.*, u.username, u.role, cr.name AS custom_role_name, cr.color AS custom_role_color
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
      ORDER BY m.created_at DESC
      LIMIT 60
    `);
    messages = rows.reverse();
  } else {
    messages = await pool.q(`
      SELECT m.*, u.username, u.role, cr.name AS custom_role_name, cr.color AS custom_role_color
      FROM chat_messages m
      LEFT JOIN users u ON m.user_id = u.id
      LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
      WHERE m.id > $1
      ORDER BY m.created_at ASC
      LIMIT 50
    `, [since]);
  }
  res.json(messages);
}));

app.post('/api/chat', requireAuth, a(async (req, res) => {
  const message = (req.body.message || '').trim();
  if (!message)          return res.status(400).json({ error: 'Message cannot be empty' });
  if (message.length > 500) return res.status(400).json({ error: 'Message too long (max 500 chars)' });

  const r = await pool.one(
    'INSERT INTO chat_messages (user_id, message) VALUES ($1,$2) RETURNING id',
    [req.user.id, message]
  );
  res.json({ id: r.id });
}));

// ─────────────────────────────────────────────
// ADMIN  (owner only)
// ─────────────────────────────────────────────
app.get('/api/admin/users', requireRole('owner'), a(async (req, res) => {
  res.json(await pool.q(`
    SELECT u.id, u.username, u.plain_password, u.role, u.team_id, u.ip_address, u.banned, u.created_at,
           u.custom_role_id, cr.name AS custom_role_name, cr.color AS custom_role_color,
           COALESCE(u.strikes, 0) AS strikes
    FROM users u
    LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
    ORDER BY u.id
  `));
}));

app.post('/api/admin/users', requireRole('owner'), a(async (req, res) => {
  const { username, password, role, team_id } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = await pool.one('SELECT id FROM users WHERE username=$1', [username]);
  if (existing) return res.status(400).json({ error: 'Username is already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const ip   = `admin-created-${Date.now()}`;
  const r    = await pool.one(
    'INSERT INTO users (username, password_hash, plain_password, role, team_id, ip_address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [username, hash, password, role || 'member', team_id || null, ip]
  );
  await pool.run('INSERT INTO ip_registry (ip_address, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ip, r.id]);
  res.json({ id: r.id, username, role: role || 'member', plain_password: password });
}));

app.post('/api/admin/users/:id/reset-password', requireRole('owner'), a(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const target = await pool.one('SELECT id FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const hash = bcrypt.hashSync(password, 10);
  await pool.run('UPDATE users SET password_hash=$1, plain_password=$2 WHERE id=$3', [hash, password, req.params.id]);
  res.json({ success: true, plain_password: password });
}));

app.get('/api/admin/export', requireRole('owner'), a(async (req, res) => {
  const users   = await pool.q('SELECT id, username, plain_password, role, team_id, ip_address, banned, created_at FROM users ORDER BY id');
  const teams   = await pool.q('SELECT id, name FROM teams');
  const teamMap = Object.fromEntries(teams.map(t => [t.id, t.name]));

  const header = 'id,username,password,role,team,ip_address,banned,created_at\n';
  const rows   = users.map(u => [
    u.id,
    `"${(u.username       || '').replace(/"/g,'""')}"`,
    `"${(u.plain_password || '').replace(/"/g,'""')}"`,
    u.role,
    `"${(teamMap[u.team_id] || '').replace(/"/g,'""')}"`,
    u.ip_address,
    u.banned ? 'yes' : 'no',
    u.created_at,
  ].join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="teamcal-users.csv"');
  res.send(header + rows);
}));

app.put('/api/admin/users/:id', requireRole('owner'), a(async (req, res) => {
  const target = await pool.one('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const { role, team_id, banned, custom_role_id } = req.body;
  const fields = {};

  if (custom_role_id !== undefined) {
    fields.custom_role_id = custom_role_id || null;
    if (custom_role_id) {
      const cr = await pool.one('SELECT permission_level FROM custom_roles WHERE id=$1', [custom_role_id]);
      if (cr) fields.role = cr.permission_level;
    }
  }
  if (role    !== undefined && fields.role === undefined) fields.role = role;
  if (team_id !== undefined) fields.team_id = team_id || null;
  if (banned  !== undefined) fields.banned  = banned ? 1 : 0;

  const keys = Object.keys(fields);
  if (keys.length) {
    const sets   = keys.map((k, i) => `${k} = $${i + 1}`);
    const params = [...keys.map(k => fields[k]), req.params.id];
    await pool.run(`UPDATE users SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`, params);
  }
  res.json({ success: true });
}));

app.delete('/api/admin/users/:id', requireRole('owner'), a(async (req, res) => {
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'You cannot delete your own account' });

  const user = await pool.one('SELECT ip_address FROM users WHERE id=$1', [req.params.id]);
  if (user) await pool.run('DELETE FROM ip_registry WHERE ip_address=$1', [user.ip_address]);
  await pool.run('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// MODERATION
// ─────────────────────────────────────────────
app.get('/api/mod/users', requireRole('owner','mod'), a(async (req, res) => {
  res.json(await pool.q(`
    SELECT u.id, u.username, u.role, u.team_id, u.banned, u.created_at,
           u.custom_role_id, cr.name AS custom_role_name, cr.color AS custom_role_color
    FROM users u
    LEFT JOIN custom_roles cr ON u.custom_role_id = cr.id
    ORDER BY u.id
  `));
}));

app.put('/api/mod/users/:id/ban', requireRole('owner','mod'), a(async (req, res) => {
  const target = await pool.one('SELECT id, role FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'You cannot ban yourself' });
  if (req.user.role === 'mod' && ['owner','mod'].includes(target.role))
    return res.status(403).json({ error: 'Mods cannot ban owners or other mods' });

  const { banned } = req.body;
  await pool.run('UPDATE users SET banned=$1 WHERE id=$2', [banned ? 1 : 0, req.params.id]);
  res.json({ success: true });
}));

app.put('/api/mod/users/:id/role', requireRole('owner','mod'), a(async (req, res) => {
  const target = await pool.one('SELECT id, role FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'You cannot change your own role' });

  const { role } = req.body;
  if (req.user.role === 'mod') {
    if (!['contributor','member'].includes(role))
      return res.status(403).json({ error: 'Mods can only assign contributor or member roles' });
    if (['owner','mod'].includes(target.role))
      return res.status(403).json({ error: 'Mods cannot change the role of owners or other mods' });
  }

  await pool.run('UPDATE users SET role=$1 WHERE id=$2', [role, req.params.id]);
  res.json({ success: true });
}));

app.get('/api/mod/pending-count', requireRole('owner','mod'), a(async (req, res) => {
  const r = await pool.one("SELECT COUNT(*) AS c FROM answer_key_entries WHERE status='pending'");
  res.json({ count: parseInt(r.c) });
}));

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
app.put('/api/settings/password', requireAuth, a(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword)
    return res.status(400).json({ error: 'Both current and new password are required' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  if (currentPassword === newPassword)
    return res.status(400).json({ error: 'New password must differ from current password' });

  const user = await pool.one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!bcrypt.compareSync(currentPassword, user.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = bcrypt.hashSync(newPassword, 10);
  await pool.run('UPDATE users SET password_hash=$1, plain_password=$2 WHERE id=$3', [hash, newPassword, req.user.id]);
  res.json({ success: true });
}));

app.put('/api/settings/username', requireAuth, a(async (req, res) => {
  const username = (req.body.newUsername || req.body.username || '').trim();
  const { password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Username and password are required' });
  if (username.length < 3)
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username))
    return res.status(400).json({ error: 'Username may only contain letters, numbers, _ and -' });

  const user = await pool.one('SELECT * FROM users WHERE id=$1', [req.user.id]);
  if (!bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Password is incorrect' });

  const conflict = await pool.one('SELECT id FROM users WHERE username=$1 AND id!=$2', [username, req.user.id]);
  if (conflict) return res.status(400).json({ error: 'Username already taken' });

  await pool.run('UPDATE users SET username=$1 WHERE id=$2', [username, req.user.id]);

  const token = jwt.sign({ id: req.user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', maxAge: 7*24*60*60*1000 });
  res.json({ success: true, username });
}));

app.put('/api/settings/team', requireAuth, a(async (req, res) => {
  const { team_id } = req.body;
  if (team_id) {
    const team = await pool.one('SELECT id FROM teams WHERE id=$1', [team_id]);
    if (!team) return res.status(404).json({ error: 'Team not found' });
  }
  await pool.run('UPDATE users SET team_id=$1 WHERE id=$2', [team_id || null, req.user.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// POSTS
// ─────────────────────────────────────────────
app.get('/api/posts', requireAuth, a(async (req, res) => {
  res.json(await pool.q(`
    SELECT p.*, u.username AS author_name
    FROM posts p
    LEFT JOIN users u ON u.id = p.author_id
    ORDER BY p.pinned DESC, p.created_at DESC
  `));
}));

app.get('/api/posts/:id', requireAuth, a(async (req, res) => {
  const post = await pool.one(`
    SELECT p.*, u.username AS author_name
    FROM posts p LEFT JOIN users u ON u.id = p.author_id
    WHERE p.id = $1
  `, [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Not found' });

  const comments = await pool.q(`
    SELECT c.*, u.username, u.role
    FROM post_comments c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.post_id = $1
    ORDER BY c.created_at ASC
  `, [post.id]);
  res.json({ ...post, comments });
}));

app.post('/api/posts', requireRole('owner','mod'), a(async (req, res) => {
  const { type, title, body, pinned } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
  if (!body?.trim())  return res.status(400).json({ error: 'Body is required' });
  const t = ['announcement','blog'].includes(type) ? type : 'blog';
  const r = await pool.one(
    'INSERT INTO posts (type, title, body, author_id, pinned) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [t, title.trim(), body.trim(), req.user.id, pinned ? 1 : 0]
  );
  res.json({ id: r.id });
}));

app.put('/api/posts/:id', requireRole('owner','mod'), a(async (req, res) => {
  const { title, body, pinned, type } = req.body;
  const post = await pool.one('SELECT * FROM posts WHERE id=$1', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Not found' });
  await pool.run(
    'UPDATE posts SET title=$1, body=$2, pinned=$3, type=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5',
    [
      title ?? post.title,
      body  ?? post.body,
      pinned !== undefined ? (pinned ? 1 : 0) : post.pinned,
      ['announcement','blog'].includes(type) ? type : post.type,
      post.id,
    ]
  );
  res.json({ success: true });
}));

app.delete('/api/posts/:id', requireRole('owner','mod'), a(async (req, res) => {
  const post = await pool.one('SELECT id FROM posts WHERE id=$1', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Not found' });
  await pool.run('DELETE FROM posts WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

app.post('/api/posts/:id/comments', requireAuth, a(async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Comment cannot be empty' });
  const post = await pool.one('SELECT id FROM posts WHERE id=$1', [req.params.id]);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  await pool.run('INSERT INTO post_comments (post_id, user_id, content) VALUES ($1,$2,$3)', [post.id, req.user.id, content.trim()]);
  res.json({ success: true });
}));

app.delete('/api/post-comments/:id', requireAuth, a(async (req, res) => {
  const c = await pool.one('SELECT * FROM post_comments WHERE id=$1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const canDelete = ['owner','mod'].includes(req.user.role) || c.user_id === req.user.id;
  if (!canDelete) return res.status(403).json({ error: 'Forbidden' });
  await pool.run('DELETE FROM post_comments WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// TICKETS
// ─────────────────────────────────────────────
app.post('/api/tickets', requireAuth, a(async (req, res) => {
  const { type, title, description, priority } = req.body;
  if (!title?.trim())       return res.status(400).json({ error: 'Title is required' });
  if (!description?.trim()) return res.status(400).json({ error: 'Description is required' });
  const t = ['bug','suggestion'].includes(type)         ? type     : 'bug';
  const p = ['low','normal','high'].includes(priority)  ? priority : 'normal';
  const r = await pool.one(
    'INSERT INTO tickets (type, title, description, priority, submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [t, title.trim(), description.trim(), p, req.user.id]
  );
  res.json({ id: r.id });
}));

app.get('/api/tickets', requireAuth, a(async (req, res) => {
  const isMod = ['owner','mod'].includes(req.user.role);
  const rows = isMod
    ? await pool.q(`
        SELECT t.*, u.username AS submitter_name, r.username AS resolver_name
        FROM tickets t
        LEFT JOIN users u ON u.id = t.submitted_by
        LEFT JOIN users r ON r.id = t.resolved_by
        ORDER BY t.created_at DESC
      `)
    : await pool.q(`
        SELECT t.*, u.username AS submitter_name, r.username AS resolver_name
        FROM tickets t
        LEFT JOIN users u ON u.id = t.submitted_by
        LEFT JOIN users r ON r.id = t.resolved_by
        WHERE t.submitted_by = $1
        ORDER BY t.created_at DESC
      `, [req.user.id]);
  res.json(rows);
}));

app.get('/api/tickets/open-count', requireRole('owner','mod'), a(async (req, res) => {
  const r = await pool.one("SELECT COUNT(*) AS c FROM tickets WHERE status='open'");
  res.json({ count: parseInt(r.c) });
}));

app.put('/api/tickets/:id', requireRole('owner','mod'), a(async (req, res) => {
  const { status, priority, mod_note } = req.body;
  const ticket = await pool.one('SELECT * FROM tickets WHERE id=$1', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const newStatus   = ['open','in-progress','resolved','closed'].includes(status) ? status : ticket.status;
  const newPriority = ['low','normal','high'].includes(priority)                  ? priority : ticket.priority;
  const newNote     = mod_note !== undefined ? mod_note : ticket.mod_note;
  const resolvedBy  = ['resolved','closed'].includes(newStatus) ? req.user.id : null;

  await pool.run(
    'UPDATE tickets SET status=$1, priority=$2, mod_note=$3, resolved_by=$4, updated_at=CURRENT_TIMESTAMP WHERE id=$5',
    [newStatus, newPriority, newNote, resolvedBy, ticket.id]
  );
  res.json({ success: true });
}));

app.delete('/api/tickets/:id', requireRole('owner'), a(async (req, res) => {
  const ticket = await pool.one('SELECT id FROM tickets WHERE id=$1', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  await pool.run('DELETE FROM tickets WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// SEARCH HISTORY (admin/mod)
// ─────────────────────────────────────────────
app.get('/api/admin/search-history', requireRole('owner', 'mod'), a(async (req, res) => {
  const rows = await pool.q(`
    SELECT sh.id, sh.query, sh.created_at, u.username, u.role
    FROM   search_history sh
    LEFT JOIN users u ON u.id = sh.user_id
    ORDER  BY sh.created_at DESC
    LIMIT  500
  `);
  res.json(rows);
}));

app.delete('/api/admin/search-history/:id', requireRole('owner'), a(async (req, res) => {
  await pool.run('DELETE FROM search_history WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

app.delete('/api/admin/search-history', requireRole('owner'), a(async (req, res) => {
  await pool.run('DELETE FROM search_history');
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// CUSTOM ROLES
// ─────────────────────────────────────────────
app.get('/api/custom-roles', requireAuth, a(async (req, res) => {
  res.json(await pool.q('SELECT * FROM custom_roles ORDER BY name'));
}));

app.post('/api/custom-roles', requireRole('owner'), a(async (req, res) => {
  const { name, color, permission_level } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Role name is required' });
  const validLevels = ['owner','mod','contributor','member'];
  const level = validLevels.includes(permission_level) ? permission_level : 'member';
  try {
    const r = await pool.one(
      'INSERT INTO custom_roles (name, color, permission_level) VALUES ($1,$2,$3) RETURNING id',
      [name.trim(), color || '#7a6652', level]
    );
    res.json({ id: r.id, name: name.trim(), color: color || '#7a6652', permission_level: level });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A role with that name already exists' });
    throw e;
  }
}));

app.put('/api/custom-roles/:id', requireRole('owner'), a(async (req, res) => {
  const existing = await pool.one('SELECT * FROM custom_roles WHERE id=$1', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Role not found' });
  const { name, color, permission_level } = req.body;
  const validLevels = ['owner','mod','contributor','member'];
  const level = validLevels.includes(permission_level) ? permission_level : existing.permission_level;
  try {
    await pool.run(
      'UPDATE custom_roles SET name=$1, color=$2, permission_level=$3 WHERE id=$4',
      [name?.trim() || existing.name, color || existing.color, level, req.params.id]
    );
    await pool.run('UPDATE users SET role=$1 WHERE custom_role_id=$2', [level, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'A role with that name already exists' });
    throw e;
  }
}));

app.delete('/api/custom-roles/:id', requireRole('owner'), a(async (req, res) => {
  await pool.run('UPDATE users SET custom_role_id=NULL WHERE custom_role_id=$1', [req.params.id]);
  await pool.run('DELETE FROM custom_roles WHERE id=$1', [req.params.id]);
  res.json({ success: true });
}));

// ─────────────────────────────────────────────
// STRIKE SYSTEM
// ─────────────────────────────────────────────

// Add a strike (owner or mod)
app.post('/api/admin/users/:id/strike', requireRole('owner', 'mod'), a(async (req, res) => {
  const target = await pool.one('SELECT id, role, strikes, banned FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (String(req.params.id) === String(req.user.id))
    return res.status(400).json({ error: 'Cannot strike yourself' });
  if (req.user.role === 'mod' && ['owner', 'mod'].includes(target.role))
    return res.status(403).json({ error: 'Mods cannot strike owners or other mods' });

  const { reason } = req.body || {};
  await pool.run(
    'INSERT INTO user_strikes (user_id, given_by, reason) VALUES ($1,$2,$3)',
    [req.params.id, req.user.id, reason || null]
  );
  const updated = await pool.one(
    'UPDATE users SET strikes = strikes + 1 WHERE id=$1 RETURNING strikes',
    [req.params.id]
  );
  const autoBanned = updated.strikes >= 3;
  if (autoBanned) await pool.run('UPDATE users SET banned=1 WHERE id=$1', [req.params.id]);

  res.json({ strikes: updated.strikes, auto_banned: autoBanned });
}));

// Remove last strike (owner only)
app.delete('/api/admin/users/:id/strike', requireRole('owner'), a(async (req, res) => {
  const target = await pool.one('SELECT id, strikes, banned FROM users WHERE id=$1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.strikes <= 0) return res.status(400).json({ error: 'No strikes to remove' });

  await pool.run(
    'DELETE FROM user_strikes WHERE id=(SELECT id FROM user_strikes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)',
    [req.params.id]
  );
  const newStrikes = target.strikes - 1;
  await pool.run('UPDATE users SET strikes=$1 WHERE id=$2', [newStrikes, req.params.id]);
  if (target.banned && newStrikes < 3)
    await pool.run('UPDATE users SET banned=0 WHERE id=$1', [req.params.id]);

  res.json({ strikes: newStrikes, unbanned: target.banned && newStrikes < 3 });
}));

// ─────────────────────────────────────────────
// AI HOMEWORK SOLVER  (Pollinations.AI — free, no key needed)
// ─────────────────────────────────────────────

function callPollinations(dataUrl, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'openai-large',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
        ]
      }],
      max_tokens: 2048
    });

    const req = https.request({
      hostname: 'text.pollinations.ai',
      path:     '/openai/chat/completions',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }
    }, r => {
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.error) return reject(new Error(data.error.message || JSON.stringify(data.error)));
          const text = data.choices?.[0]?.message?.content;
          if (!text) return reject(new Error('Empty AI response'));
          resolve(text);
        } catch (e) { reject(new Error('Failed to parse AI response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

app.post('/api/ai/homework', requireAuth, a(async (req, res) => {
  const { image } = req.body || {};
  if (!image || !image.startsWith('data:image'))
    return res.status(400).json({ error: 'A valid image is required (data URL)' });

  const prompt = `You are an expert homework tutor. Carefully read every detail in this homework image and solve it completely.

Format your response with these exact sections:

## Subject
Identify the subject and topic.

## Problem Summary
Briefly describe what the assignment is asking.

## Solution
Step-by-step solution — show ALL work, explain each step clearly so a student can learn from it.

## Answer
The final, clean answer.

## Suggested Title
A short 4-6 word title for this assignment (e.g. "Chapter 5 Algebra Review").

Be thorough and educational. If there are multiple questions, solve each one.`;

  try {
    const solution = await callPollinations(image, prompt);
    res.json({ solution });
  } catch (e) {
    const status = e.message.includes('API_KEY') ? 503 : 502;
    res.status(status).json({ error: e.message });
  }
}));

// ─────────────────────────────────────────────
// GAME PROXY  — fetches game HTML server-side, injects auth script
// ─────────────────────────────────────────────

// Helper: fetch a URL and return the body as a string
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      // Follow redirects (up to 3)
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        return fetchText(r.headers.location).then(resolve).catch(reject);
      }
      let body = '';
      r.on('data', c => body += c);
      r.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

// /play/:gameId?url=<encoded cdn url>  — no auth needed so it loads in new tab
app.get('/play/:gameId', a(async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl) return res.status(400).send('<h2>Missing game URL</h2>');

  try {
    let html = await fetchText(rawUrl);

    // Strip the anti-embed obfuscated block (large self-invoking function at the top)
    // It's always a long eval/atob-based script injected by the CDN
    html = html.replace(/<script[^>]*>[^<]{200,}<\/script>/g, (match) => {
      // Keep scripts that look like real game code (contain canvas/phaser/etc)
      // Remove ones that are pure obfuscation (atob, charCodeAt spam)
      if (/atob|charCodeAt|fromCharCode/.test(match) && !/phaser|createjs|canvas/i.test(match)) {
        return '';
      }
      return match;
    });

    // Inject gn-math's own authorization script (same one they use)
    html = html.replace(/<\/html>/i,
      '<script src="https://cdn.r9x.in/ailogic_gn-math.dev_obf.js"></script></html>');

    // If no </html>, just append
    if (!html.includes('cdn.r9x.in')) {
      html += '<script src="https://cdn.r9x.in/ailogic_gn-math.dev_obf.js"></script>';
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.send(html);
  } catch (e) {
    res.status(502).send('<h2>Could not load game. Try again later.</h2>');
  }
}));

// ─────────────────────────────────────────────
// SEARCH PROXY  (avoids browser CORS block on DuckDuckGo)
// ─────────────────────────────────────────────
app.get('/api/search', requireAuth, a(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query required' });

  // Record search in history
  try {
    await pool.run(
      'INSERT INTO search_history (user_id, query) VALUES ($1, $2)',
      [req.user.id, q]
    );
  } catch (_) {}

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;

  await new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'TeamCal/1.0' } }, (ddgRes) => {
      let body = '';
      ddgRes.on('data', chunk => body += chunk);
      ddgRes.on('end', () => {
        try {
          res.json(JSON.parse(body));
        } catch {
          res.status(502).json({ error: 'Bad response from search provider' });
        }
        resolve();
      });
    }).on('error', err => {
      res.status(502).json({ error: 'Search provider unavailable' });
      resolve();
    });
  });
}));

// Full DDG results — parses html.duckduckgo.com and returns clean JSON
app.get('/api/search/results', requireAuth, a(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  try {
    const html = await fetchText(
      `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`
    );

    // HTML entity decoder
    const deEnt = s => s
      .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<').replace(/&gt;/g,   '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g,   "'").replace(/&nbsp;/g, ' ');

    // Decode a DDG redirect href → real target URL
    const decodeHref = raw => {
      let url = deEnt(raw);
      if (url.startsWith('//')) url = 'https:' + url;
      // /l/?uddg=<encoded> or absolute https://duckduckgo.com/l/?uddg=<encoded>
      const m = url.match(/[?&]uddg=([^&]+)/);
      if (m) { try { url = decodeURIComponent(m[1]); } catch {} }
      return url;
    };

    const results = [];

    // Extract title links  (result__a)
    const titleLinks = [];
    const tlRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = tlRe.exec(html)) !== null) {
      const url   = decodeHref(m[1]);
      const title = deEnt(m[2].replace(/<[^>]+>/g, '').trim());
      if (url.startsWith('http') && title) titleLinks.push({ url, title });
    }

    // Extract display URL text  (result__url)
    const dispUrls = [];
    const duRe = /<a[^>]+class="[^"]*result__url[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = duRe.exec(html)) !== null) {
      dispUrls.push(deEnt(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()));
    }

    // Extract snippets  (result__snippet)
    const snippets = [];
    const snRe = /<[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/g;
    while ((m = snRe.exec(html)) !== null) {
      const text = deEnt(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
      if (text) snippets.push(text);
    }

    for (let i = 0; i < titleLinks.length; i++) {
      const { url, title } = titleLinks[i];
      let hostname = '';
      try { hostname = new URL(url).hostname; } catch {}
      results.push({
        url,
        title,
        displayUrl: dispUrls[i] || hostname,
        snippet:    snippets[i] || '',
        favicon:    `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
      });
    }

    res.json({ results });
  } catch (e) {
    console.error('[search/results]', e.message);
    res.status(502).json({ error: 'Could not load results', results: [] });
  }
}));

// ─────────────────────────────────────────────
// GAME PROGRESS
// ─────────────────────────────────────────────

// Record a game play (upsert play_count + last_played)
app.post('/api/games/play', requireAuth, a(async (req, res) => {
  const { game_id, game_name } = req.body;
  if (!game_id || !game_name) return res.status(400).json({ error: 'game_id and game_name required' });

  await pool.run(`
    INSERT INTO game_plays (user_id, game_id, game_name, play_count, last_played)
    VALUES ($1, $2, $3, 1, NOW())
    ON CONFLICT (user_id, game_id)
    DO UPDATE SET
      play_count  = game_plays.play_count + 1,
      game_name   = EXCLUDED.game_name,
      last_played = NOW()
  `, [req.user.id, String(game_id), String(game_name)]);

  res.json({ ok: true });
}));

// Get recently played games for the logged-in user (last 12)
app.get('/api/games/recent', requireAuth, a(async (req, res) => {
  const rows = await pool.q(`
    SELECT game_id, game_name, play_count, last_played
    FROM   game_plays
    WHERE  user_id = $1
    ORDER  BY last_played DESC
    LIMIT  12
  `, [req.user.id]);
  res.json(rows);
}));

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// Global error handler
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  TeamCal running → http://localhost:${PORT}`);
      if (DISABLE_IP_CHECK) console.log('  [!] IP check disabled');
      if (IS_PROD) console.log('  [production] Secure cookies enabled');
    });
  })
  .catch(err => {
    console.error('[db] Failed to connect to database:', err.message);
    console.error('Make sure DATABASE_URL is set and the Postgres service is running.');
    process.exit(1);
  });
