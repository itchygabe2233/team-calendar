/* ================================================================
   TeamCal — frontend SPA
   ================================================================ */

// ── State ──────────────────────────────────────────────────────
const S = {
  user:         null,
  view:         'calendar',    // 'calendar' | 'answer-key' | 'admin' | 'mod' | 'tickets' | 'board'
  date:         new Date(),
  assignments:  [],
  teams:        [],
  customRoles:  [],
  activeTeams:  new Set(),     // empty = show all
  adminUsers:   [],
  modUsers:     [],
  tickets:      [],
  chat: { msgs: [], lastId: 0, timer: null },
  answerKey:    null,
  assignment:   null,
};

// ── API ─────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res  = await fetch('/api' + path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const GET  = (p)    => api('GET',    p);
const POST = (p, b) => api('POST',   p, b);
const PUT  = (p, b) => api('PUT',    p, b);
const DEL  = (p)    => api('DELETE', p);

// ── Utils ───────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function pad(n) { return String(n).padStart(2,'0'); }

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
  return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true });
}

function fmtRelTime(s) {
  if (!s) return '';
  const diff = Date.now() - new Date(s).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return fmtDate(s);
}

// Toggle password visibility (eye button on inputs)
function togglePwVis(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

function toast(msg, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function canCreate()  { return ['owner','mod','contributor'].includes(S.user?.role); }
function canModerate(){ return ['owner','mod'].includes(S.user?.role); }
function isOwner()    { return S.user?.role === 'owner'; }
function isMod()      { return S.user?.role === 'mod'; }

// Returns an HTML role badge — shows custom role name/color if set, otherwise base role
function roleBadge(user, extraStyle = '') {
  if (!user) return '';
  if (user.custom_role_name) {
    const bg = esc(user.custom_role_color || '#7a6652');
    const st = `background:${bg};color:#fff;border-color:transparent${extraStyle ? ';' + extraStyle : ''}`;
    return `<span class="role-badge" style="${st}">${esc(user.custom_role_name)}</span>`;
  }
  const st = extraStyle ? ` style="${extraStyle}"` : '';
  return `<span class="role-badge ${esc(user.role)}"${st}>${esc(user.role)}</span>`;
}

// ── Bootstrap ───────────────────────────────────────────────────
async function boot() {
  try {
    S.user        = await GET('/auth/me');
    S.teams       = await GET('/teams');
    S.customRoles = await GET('/custom-roles');
    renderShell();
    await switchView('calendar');
    startChat();
  } catch {
    renderAuth();
  }
}

// ================================================================
// AUTH
// ================================================================
function renderAuth() {
  document.body.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-logo">📅 TeamCal</div>
        <div class="auth-tabs">
          <div class="auth-tab active" id="tab-login"    onclick="showTab('login')">Sign in</div>
          <div class="auth-tab"        id="tab-register" onclick="showTab('register')">Register</div>
        </div>
        <div id="auth-body"></div>
      </div>
    </div>
  `;
  showTab('login');
}

function showTab(t) {
  document.getElementById('tab-login')   .classList.toggle('active', t === 'login');
  document.getElementById('tab-register').classList.toggle('active', t === 'register');
  document.getElementById('auth-body').innerHTML = t === 'login' ? loginForm() : registerForm();
}

function loginForm() {
  return `
    <form onsubmit="doLogin(event)">
      <div class="form-group">
        <label>Username</label>
        <input id="l-u" type="text" required autocomplete="username">
      </div>
      <div class="form-group">
        <label>Password</label>
        <div class="pw-wrap">
          <input id="l-p" type="password" required autocomplete="current-password">
          <button type="button" class="pw-eye" onclick="togglePwVis('l-p',this)" tabindex="-1">👁</button>
        </div>
      </div>
      <div id="l-err"></div>
      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:.5rem">Sign in</button>
    </form>`;
}

function registerForm() {
  return `
    <form onsubmit="doRegister(event)">
      <div class="form-group">
        <label>Username</label>
        <input id="r-u" type="text" required minlength="3" autocomplete="username">
      </div>
      <div class="form-group">
        <label>Password</label>
        <div class="pw-wrap">
          <input id="r-p" type="password" required minlength="6" autocomplete="new-password">
          <button type="button" class="pw-eye" onclick="togglePwVis('r-p',this)" tabindex="-1">👁</button>
        </div>
      </div>
      <div id="r-err"></div>
      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:.5rem">Create account</button>
      <p class="auth-note">The <strong>first</strong> account registered becomes the <strong>Owner</strong>.</p>
    </form>`;
}

async function doLogin(e) {
  e.preventDefault();
  try {
    const res   = await POST('/auth/login', { username: e.target['l-u'].value, password: e.target['l-p'].value });
    S.user      = res.user;
    S.teams     = await GET('/teams');
    renderShell();
    await switchView('calendar');
    startChat();
  } catch (err) {
    document.getElementById('l-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function doRegister(e) {
  e.preventDefault();
  try {
    const res   = await POST('/auth/register', { username: e.target['r-u'].value, password: e.target['r-p'].value });
    S.user      = res.user;
    S.teams     = await GET('/teams');
    renderShell();
    await switchView('calendar');
    startChat();
  } catch (err) {
    document.getElementById('r-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function doLogout() {
  clearInterval(S.chat.timer);
  await POST('/auth/logout', {});
  Object.assign(S, { user:null, view:'calendar', assignments:[], teams:[], activeTeams:new Set(), adminUsers:[], modUsers:[], chat:{msgs:[],lastId:0,timer:null}, answerKey:null, assignment:null });
  renderAuth();
}

// ================================================================
// SETTINGS MODAL
// ================================================================
function openSettings(tab) {
  tab = tab || 'password';
  const teamOptions = S.teams.map(t =>
    `<option value="${t.id}" ${S.user.team_id==t.id?'selected':''}>${esc(t.name)}</option>`
  ).join('');

  showModal(`
    <div class="modal-head">
      <h3>⚙ Settings</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>

    <div class="settings-tabs">
      <button class="settings-tab ${tab==='password'?'active':''}" onclick="openSettings('password')">Password</button>
      <button class="settings-tab ${tab==='username'?'active':''}" onclick="openSettings('username')">Username</button>
      <button class="settings-tab ${tab==='team'    ?'active':''}" onclick="openSettings('team')">Team</button>
    </div>

    ${tab === 'password' ? `
      <form onsubmit="saveSettingsPw(event)" style="margin-top:1rem">
        <div class="form-group">
          <label>Current Password</label>
          <div class="pw-wrap">
            <input id="sp-cur" type="password" required autocomplete="current-password">
            <button type="button" class="pw-eye" onclick="togglePwVis('sp-cur',this)" tabindex="-1">👁</button>
          </div>
        </div>
        <div class="form-group">
          <label>New Password</label>
          <div class="pw-wrap">
            <input id="sp-new" type="password" required minlength="6" autocomplete="new-password">
            <button type="button" class="pw-eye" onclick="togglePwVis('sp-new',this)" tabindex="-1">👁</button>
          </div>
        </div>
        <div class="form-group">
          <label>Confirm New Password</label>
          <div class="pw-wrap">
            <input id="sp-cfm" type="password" required minlength="6" autocomplete="new-password">
            <button type="button" class="pw-eye" onclick="togglePwVis('sp-cfm',this)" tabindex="-1">👁</button>
          </div>
        </div>
        <div id="sp-err"></div>
        <div id="sp-ok"></div>
        <button type="submit" class="btn btn-primary" style="margin-top:.5rem">Change Password</button>
      </form>
    ` : tab === 'username' ? `
      <form onsubmit="saveSettingsUn(event)" style="margin-top:1rem">
        <div class="form-group">
          <label>New Username</label>
          <input id="su-new" type="text" required minlength="3" value="${esc(S.user.username)}" autocomplete="username">
        </div>
        <div class="form-group">
          <label>Confirm Password</label>
          <div class="pw-wrap">
            <input id="su-pw" type="password" required autocomplete="current-password">
            <button type="button" class="pw-eye" onclick="togglePwVis('su-pw',this)" tabindex="-1">👁</button>
          </div>
        </div>
        <div id="su-err"></div>
        <div id="su-ok"></div>
        <button type="submit" class="btn btn-primary" style="margin-top:.5rem">Change Username</button>
      </form>
    ` : `
      <form onsubmit="saveSettingsTeam(event)" style="margin-top:1rem">
        <div class="form-group">
          <label>Your Team</label>
          <select id="st-team">
            <option value="">— no team —</option>
            ${teamOptions}
          </select>
        </div>
        <div id="st-err"></div>
        <div id="st-ok"></div>
        <button type="submit" class="btn btn-primary" style="margin-top:.5rem">Save Team</button>
      </form>
    `}
  `);
}

async function saveSettingsPw(e) {
  e.preventDefault();
  const cur = document.getElementById('sp-cur').value;
  const nw  = document.getElementById('sp-new').value;
  const cfm = document.getElementById('sp-cfm').value;
  if (nw !== cfm) {
    document.getElementById('sp-err').innerHTML = `<div class="error-msg">Passwords do not match.</div>`;
    return;
  }
  try {
    await PUT('/settings/password', { currentPassword: cur, newPassword: nw });
    document.getElementById('sp-err').innerHTML = '';
    document.getElementById('sp-ok').innerHTML  = `<div class="success-msg">Password updated!</div>`;
    document.getElementById('sp-cur').value = '';
    document.getElementById('sp-new').value = '';
    document.getElementById('sp-cfm').value = '';
  } catch (err) {
    document.getElementById('sp-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function saveSettingsUn(e) {
  e.preventDefault();
  const newUsername = document.getElementById('su-new').value.trim();
  const password    = document.getElementById('su-pw').value;
  try {
    const res = await PUT('/settings/username', { newUsername, password });
    S.user.username = res.username;
    document.getElementById('su-err').innerHTML = '';
    document.getElementById('su-ok').innerHTML  = `<div class="success-msg">Username changed to <strong>${esc(res.username)}</strong>!</div>`;
    // Patch only the topbar username text — no full re-render (which would destroy the open modal)
    const topbarName = document.querySelector('.topbar-user span:first-child');
    if (topbarName) topbarName.textContent = res.username;
    // Reflect new name in the input field so it shows the current value
    const suNew = document.getElementById('su-new');
    if (suNew) suNew.value = res.username;
  } catch (err) {
    document.getElementById('su-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function saveSettingsTeam(e) {
  e.preventDefault();
  const team_id = document.getElementById('st-team').value || null;
  try {
    await PUT('/settings/team', { team_id });
    S.user.team_id = team_id ? Number(team_id) : null;
    document.getElementById('st-err').innerHTML = '';
    document.getElementById('st-ok').innerHTML  = `<div class="success-msg">Team updated!</div>`;
  } catch (err) {
    document.getElementById('st-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

// ================================================================
// SHELL
// ================================================================
function renderShell() {
  document.body.innerHTML = `
    <div class="app" id="app">
      <div class="topbar">
        <div class="topbar-logo">📅 TeamCal</div>
        <div class="topbar-spacer"></div>
        <div class="topbar-user">
          <span>${esc(S.user.username)}</span>
          ${roleBadge(S.user)}
          <button class="btn btn-ghost settings-gear" onclick="openSettings()" title="Account settings">⚙</button>
          <button class="btn btn-sm" onclick="doLogout()">Sign out</button>
        </div>
      </div>

      <div class="sidebar" id="sidebar"></div>
      <div class="main"    id="main"></div>

      <div class="chat-panel">
        <div class="chat-head">💬 Team Chat</div>
        <div class="chat-msgs" id="chat-msgs"></div>
        <div class="chat-foot">
          <textarea class="chat-input" id="chat-in" rows="1" placeholder="Message…" onkeydown="chatKey(event)" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
          <button class="btn btn-primary btn-sm" onclick="sendChat()">→</button>
        </div>
      </div>
    </div>
  `;
  renderSidebar();
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  sb.innerHTML = `
    <div>
      <div class="sidebar-section-label">Navigation</div>
      <button class="nav-btn ${S.view==='calendar' ?'active':''}" onclick="switchView('calendar')">📆 Calendar</button>
      <button class="nav-btn ${S.view==='board'    ?'active':''}" onclick="switchView('board')">📌 Board</button>
      <button class="nav-btn ${S.view==='search'   ?'active':''}" onclick="switchView('search')">🔍 Search</button>
      <button class="nav-btn ${S.view==='games'    ?'active':''}" onclick="switchView('games')">🎮 Games</button>
      <button class="nav-btn ${S.view==='homework' ?'active':''}" onclick="switchView('homework')">🤖 AI Homework</button>
      <button class="nav-btn ${S.view==='tickets'  ?'active':''}" onclick="switchView('tickets')">
        🎫 Tickets
        <span id="ticket-badge" class="badge" style="display:none"></span>
      </button>
      ${isOwner() ? `
        <button class="nav-btn ${S.view==='admin'?'active':''}" onclick="switchView('admin')">
          ⚙️ Admin
          <span id="pending-badge" class="badge" style="display:none"></span>
        </button>` : ''}
      ${isMod() ? `
        <button class="nav-btn ${S.view==='mod'?'active':''}" onclick="switchView('mod')">
          🛡️ Moderation
          <span id="pending-badge" class="badge" style="display:none"></span>
        </button>` : ''}
    </div>

    <div>
      <div class="sidebar-section-label">Teams</div>
      <div class="team-filter-row ${S.activeTeams.size===0?'selected':''}" onclick="toggleTeam(null)">
        <span class="team-dot" style="background:#aaa"></span>
        <span>All teams</span>
      </div>
      ${S.teams.map(t => `
        <div class="team-filter-row ${S.activeTeams.has(t.id)?'selected':''}" onclick="toggleTeam(${t.id})">
          <span class="team-dot" style="background:${esc(t.color)}"></span>
          <span>${esc(t.name)}</span>
        </div>
      `).join('')}
    </div>

    ${canCreate() ? `
    <div>
      <button class="btn btn-primary" style="width:100%" onclick="openAddAssignment()">+ Assignment</button>
    </div>` : ''}
  `;
  if (canModerate()) loadPendingCount();
}

async function loadPendingCount() {
  try {
    const { count } = await GET('/mod/pending-count');
    const badge = document.getElementById('pending-badge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? '' : 'none';
    }
  } catch { /* silent */ }
  if (canModerate()) {
    try {
      const { count } = await GET('/tickets/open-count');
      const badge = document.getElementById('ticket-badge');
      if (badge) {
        badge.textContent = count;
        badge.style.display = count > 0 ? '' : 'none';
      }
    } catch { /* silent */ }
  }
}

async function switchView(view) {
  // Guards — prevent unauthorized navigation even if called programmatically
  if (view === 'admin' && !isOwner()) { toast('Owner access only', 'error'); return; }
  if (view === 'mod'   && !canModerate()) { toast('Mod access only', 'error'); return; }
  S.view = view;
  renderSidebar();
  // Trigger fade-in on the main area when switching views
  const main = document.getElementById('main');
  if (main) { main.classList.remove('tc-view-fade'); void main.offsetWidth; main.classList.add('tc-view-fade'); }
  if      (view === 'calendar') await loadCalendar();
  else if (view === 'admin')    await loadAdmin();
  else if (view === 'mod')      await loadMod();
  else if (view === 'tickets')  await loadTickets();
  else if (view === 'board')    await loadBoard();
  else if (view === 'search')   renderSearchView();
  else if (view === 'games')    await loadGames();
  else if (view === 'homework') renderHomeworkView();
}

function toggleTeam(id) {
  if (id === null) { S.activeTeams.clear(); }
  else {
    if (S.activeTeams.has(id)) S.activeTeams.delete(id);
    else S.activeTeams.add(id);
  }
  renderSidebar();
  renderCalendar(); // re-filter in place
}

// ================================================================
// CALENDAR
// ================================================================
async function loadCalendar() {
  const y = S.date.getFullYear(), m = S.date.getMonth() + 1;
  try {
    S.assignments = await GET(`/assignments?month=${m}&year=${y}`);
  } catch { S.assignments = []; }
  renderCalendar();
}

function renderCalendar() {
  const main = document.getElementById('main');
  if (!main) return;

  const y = S.date.getFullYear(), mo = S.date.getMonth();
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Build map: YYYY-MM-DD → assignments
  const byDate = {};
  for (const a of S.assignments) {
    if (S.activeTeams.size > 0 && !S.activeTeams.has(a.team_id)) continue;
    const k = a.due_date.slice(0, 10);
    (byDate[k] = byDate[k] || []).push(a);
  }

  const firstDow  = new Date(y, mo, 1).getDay();
  const daysInMo  = new Date(y, mo + 1, 0).getDate();
  const prevDays  = new Date(y, mo, 0).getDate();
  const todayStr  = todayISO();

  const total = Math.ceil((firstDow + daysInMo) / 7) * 7;

  let cells = '';
  for (let i = 0; i < total; i++) {
    let day, cls = 'cal-day', dateStr;
    if (i < firstDow) {
      day = prevDays - firstDow + i + 1;
      cls += ' other-month';
      dateStr = `${y}-${pad(mo)}-${pad(day)}`;
    } else if (i >= firstDow + daysInMo) {
      day = i - firstDow - daysInMo + 1;
      cls += ' other-month';
      dateStr = `${y}-${pad(mo + 2)}-${pad(day)}`;
    } else {
      day = i - firstDow + 1;
      dateStr = `${y}-${pad(mo + 1)}-${pad(day)}`;
      if (dateStr === todayStr) cls += ' today';
    }

    const list = byDate[dateStr] || [];
    const chips = list.slice(0, 3).map(a => `
      <div class="chip" style="background:${esc(a.team_color||'#aaa')}"
           onclick="openDetail(${a.id})" title="${esc(a.title)}">${esc(a.title)}</div>
    `).join('');
    const more  = list.length > 3 ? `<div class="chip-more">+${list.length-3} more</div>` : '';

    cells += `
      <div class="${cls}">
        <div class="day-num"><div class="day-num-inner">${day}</div></div>
        <div class="day-chips">${chips}${more}</div>
      </div>`;
  }

  main.innerHTML = `
    <div class="cal-header">
      <button class="btn btn-sm" onclick="shiftMonth(-1)">←</button>
      <h2>${MONTHS[mo]} ${y}</h2>
      <button class="btn btn-sm" onclick="shiftMonth(1)">→</button>
      <button class="btn btn-sm" onclick="goToday()">Today</button>
    </div>
    <div class="cal-grid">
      ${DAYS.map(d=>`<div class="cal-dh">${d}</div>`).join('')}
      ${cells}
    </div>`;
}

function shiftMonth(d) { S.date = new Date(S.date.getFullYear(), S.date.getMonth() + d, 1); loadCalendar(); }
function goToday()     { S.date = new Date(); loadCalendar(); }

// ================================================================
// ASSIGNMENT DETAIL MODAL
// ================================================================
async function openDetail(id) {
  try {
    const a = await GET(`/assignments/${id}`);
    S.assignment = a;
    const canEdit = canModerate() || (S.user.role==='contributor' && a.created_by===S.user.id);
    showModal(`
      <div class="modal-head">
        <h3>${esc(a.title)}</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <div class="flex-row" style="margin-bottom:.9rem;flex-wrap:wrap;gap:.5rem">
        ${a.team_name ? `
          <span class="team-dot" style="background:${esc(a.team_color)}"></span>
          <span style="font-size:13px">${esc(a.team_name)}</span>` : ''}
        <span style="margin-left:auto;color:var(--muted);font-size:12px">Due ${fmtDate(a.due_date)}</span>
      </div>
      ${a.description ? `<p style="font-size:13px;color:var(--muted);margin-bottom:1rem;line-height:1.55">${esc(a.description)}</p>` : ''}
      <div class="flex-row" style="flex-wrap:wrap">
        <button class="btn btn-primary" onclick="closeModal();openAnswerKey(${a.id})">📝 Answer Key</button>
        ${canEdit ? `<button class="btn" onclick="closeModal();openEditAssignment(${a.id})">Edit</button>` : ''}
        ${canModerate() ? `<button class="btn btn-danger" onclick="closeModal();deleteAssignment(${a.id})">Delete</button>` : ''}
      </div>`);
  } catch (e) { toast(e.message, 'error'); }
}

// ── Add / Edit Assignment ────────────────────────
function openAddAssignment() {
  showModal(`
    <div class="modal-head">
      <h3>New Assignment</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="saveAssignment(event,null)">
      ${assignmentFields(null)}
      <div id="a-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function openEditAssignment(id) {
  const a = S.assignment?.id === id ? S.assignment : await GET(`/assignments/${id}`);
  S.assignment = a;
  showModal(`
    <div class="modal-head">
      <h3>Edit Assignment</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="saveAssignment(event,${id})">
      ${assignmentFields(a)}
      <div id="a-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

function assignmentFields(a) {
  return `
    <div class="form-group">
      <label>Title</label>
      <input id="a-title" type="text" required value="${esc(a?.title||'')}">
    </div>
    <div class="form-group">
      <label>Description</label>
      <textarea id="a-desc">${esc(a?.description||'')}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Due Date</label>
        <input id="a-date" type="date" required value="${a?.due_date?.slice(0,10)||todayISO()}">
      </div>
      <div class="form-group">
        <label>Team</label>
        <select id="a-team">
          <option value="">— none —</option>
          ${S.teams.map(t => `<option value="${t.id}" ${a?.team_id==t.id?'selected':''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>
    </div>`;
}

async function saveAssignment(e, id) {
  e.preventDefault();
  const body = {
    title:       document.getElementById('a-title').value,
    description: document.getElementById('a-desc').value,
    due_date:    document.getElementById('a-date').value,
    team_id:     document.getElementById('a-team').value || null,
  };
  try {
    if (id) await PUT(`/assignments/${id}`, body);
    else    await POST('/assignments', body);
    closeModal();
    toast('Assignment saved', 'success');
    await loadCalendar();
  } catch (err) {
    document.getElementById('a-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deleteAssignment(id) {
  if (!confirm('Delete this assignment and its answer key?')) return;
  try {
    await DEL(`/assignments/${id}`);
    toast('Deleted', 'success');
    await loadCalendar();
  } catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// ANSWER KEY
// ================================================================
async function openAnswerKey(assignmentId) {
  try {
    const [a, key] = await Promise.all([
      GET(`/assignments/${assignmentId}`),
      GET(`/answer-keys/${assignmentId}`),
    ]);
    S.assignment = a;
    S.answerKey  = key;
    S.view       = 'answer-key';
    renderSidebar();
    renderAnswerKey();
  } catch (e) { toast(e.message, 'error'); }
}

function renderAnswerKey() {
  const main = document.getElementById('main');
  if (!main) return;
  const { assignment: a, answerKey: key } = S;

  const approved = key.entries.filter(e => e.status === 'approved');
  const pending  = key.entries.filter(e => e.status === 'pending');
  const rejected = key.entries.filter(e => e.status === 'rejected');

  // Members see only their own pending entries
  const myPending = pending.filter(e => e.submitted_by === S.user.id);

  main.innerHTML = `
    <div class="page-header">
      <button class="btn btn-sm" onclick="switchView('calendar')">← Back</button>
      <h2>Answer Key — ${esc(a.title)}</h2>
      ${a.team_name ? `<span class="team-dot" style="background:${esc(a.team_color)}"></span><span style="font-size:13px">${esc(a.team_name)}</span>` : ''}
      <span style="color:var(--muted);font-size:12px">Due ${fmtDate(a.due_date)}</span>
    </div>

    ${approved.length ? `
      <div class="label" style="margin-bottom:.5rem">Approved Answers</div>
      ${approved.map(e => entryCard(e)).join('')}
      <hr class="divider">
    ` : ''}

    <div class="label" style="margin-bottom:.5rem">Submit Your Answer</div>
    <div class="section-card" style="margin-bottom:1.25rem">
      <form onsubmit="submitEntry(event,${a.id})">
        <div class="form-group">
          <label>Answer / Contribution</label>
          <textarea id="e-content" required placeholder="Write your answer, notes, or solution…"></textarea>
        </div>
        <div id="e-err"></div>
        <button type="submit" class="btn btn-primary">Submit for Review</button>
      </form>
    </div>

    ${canModerate() && pending.length ? `
      <div class="label" style="margin-bottom:.5rem">Pending Review (${pending.length})</div>
      ${pending.map(e => entryCard(e, true)).join('')}
    ` : ''}

    ${!canModerate() && myPending.length ? `
      <div class="label" style="margin-bottom:.5rem">Your Pending Submissions</div>
      ${myPending.map(e => entryCard(e)).join('')}
    ` : ''}

    ${canModerate() && rejected.length ? `
      <hr class="divider">
      <div class="label" style="margin-bottom:.5rem">Rejected</div>
      ${rejected.map(e => entryCard(e)).join('')}
    ` : ''}
  `;
}

function entryCard(e, withActions = false) {
  return `
    <div class="entry-card">
      <div class="entry-meta">
        <strong style="font-size:12px">${esc(e.submitter_name||'Unknown')}</strong>
        <span class="status-pill ${e.status}">${e.status}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted)">${fmtDate(e.created_at)}</span>
      </div>
      <div class="entry-body">${esc(e.content)}</div>
      ${e.approved_by ? `<div class="entry-footer">${e.status==='approved'?'Approved':'Rejected'} by ${esc(e.approver_name||'')}</div>` : ''}
      ${withActions && e.status === 'pending' ? `
        <div class="flex-row" style="margin-top:.65rem">
          <button class="btn btn-sm btn-primary" onclick="approveEntry(${e.id})">✓ Approve</button>
          <button class="btn btn-sm btn-danger"  onclick="rejectEntry(${e.id})">✗ Reject</button>
        </div>` : ''}
    </div>`;
}

async function submitEntry(e, assignmentId) {
  e.preventDefault();
  const content = document.getElementById('e-content').value;
  try {
    await POST(`/answer-keys/${assignmentId}/entries`, { content });
    toast('Submitted for review!', 'success');
    await openAnswerKey(assignmentId);
  } catch (err) {
    document.getElementById('e-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function approveEntry(id) {
  try { await PUT(`/answer-key-entries/${id}/approve`, {}); toast('Approved', 'success'); await openAnswerKey(S.assignment.id); }
  catch (e) { toast(e.message, 'error'); }
}
async function rejectEntry(id) {
  try { await PUT(`/answer-key-entries/${id}/reject`, {}); toast('Rejected'); await openAnswerKey(S.assignment.id); }
  catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// MOD PANEL  (no IPs, no passwords, no sensitive data)
// ================================================================
async function loadMod() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const [users, teams] = await Promise.all([ GET('/mod/users'), GET('/teams') ]);
    S.modUsers = users;
    S.teams    = teams;
    renderMod(users, teams);
  } catch { main.innerHTML = `<div class="empty">Failed to load moderation panel.</div>`; }
}

function renderMod(users, teams) {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div style="max-width:760px">
      <div class="section-card">
        <div class="section-card-header">
          <h3>Moderation</h3>
        </div>
        <p style="font-size:12px;color:var(--muted);margin-bottom:.9rem">
          Ban/unban users and set contributor status.
          You can only change roles for members and contributors — not owners or other mods.
        </p>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th><th>Role</th><th>Team</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(u => {
                const teamName  = u.team_id ? (teams.find(t=>t.id===u.team_id)?.name||'') : '—';
                const isSelf    = u.id === S.user.id;
                const protected_ = ['owner','mod'].includes(u.role) && !isSelf;
                return `
                  <tr>
                    <td style="font-weight:500">${esc(u.username)}</td>
                    <td>${roleBadge(u)}</td>
                    <td style="color:var(--muted)">${esc(teamName)}</td>
                    <td>${u.banned
                      ? '<span class="status-pill rejected">Banned</span>'
                      : '<span class="status-pill approved">Active</span>'}</td>
                    <td>
                      ${isSelf
                        ? '<span style="color:var(--muted);font-size:12px">You</span>'
                        : `<div class="flex-row" style="gap:.3rem;flex-wrap:wrap">
                             ${!protected_ ? `
                               ${u.banned
                                 ? `<button class="btn btn-sm btn-primary" onclick="modBan(${u.id},false)">Unban</button>`
                                 : `<button class="btn btn-sm btn-danger"  onclick="modBan(${u.id},true)">Ban</button>`
                               }
                               ${u.role !== 'contributor'
                                 ? `<button class="btn btn-sm" onclick="modSetRole(${u.id},'contributor')" title="Can submit answers without approval">Make Contributor</button>`
                                 : `<button class="btn btn-sm" onclick="modSetRole(${u.id},'member')">Demote to Member</button>`
                               }
                             ` : `<span style="color:var(--muted);font-size:12px">Protected</span>`}
                           </div>`
                      }
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

async function modBan(id, ban) {
  try {
    await PUT(`/mod/users/${id}/ban`, { banned: ban });
    toast(ban ? 'User banned' : 'User unbanned', ban ? 'error' : 'success');
    await loadMod();
  } catch (e) { toast(e.message, 'error'); }
}

async function modSetRole(id, role) {
  try {
    await PUT(`/mod/users/${id}/role`, { role });
    toast(`Role set to ${role}`, 'success');
    await loadMod();
  } catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// ADMIN
// ================================================================
async function loadAdmin() {
  const main = document.getElementById('main');
  try {
    const [users, teams] = await Promise.all([ GET('/admin/users'), GET('/teams') ]);
    S.adminUsers = users;
    S.teams      = teams;
    renderAdmin(users, teams);
    loadSearchHistory();
  } catch { main.innerHTML = `<div class="empty">Failed to load admin panel.</div>`; }
}

async function loadSearchHistory() {
  const wrap = document.getElementById('search-history-wrap');
  if (!wrap) return;
  try {
    const rows = await GET('/admin/search-history');
    if (!rows.length) {
      wrap.innerHTML = '<div class="empty" style="padding:.75rem">No searches yet.</div>';
      return;
    }
    wrap.innerHTML = `
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>User</th><th>Query</th><th>Time</th><th></th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${roleBadge({ role: r.role, custom_role_name: null })} <strong>${esc(r.username || '?')}</strong></td>
                <td style="font-family:monospace;font-size:13px">${esc(r.query)}</td>
                <td style="color:var(--muted);font-size:12px">${fmtDate(r.created_at)}</td>
                <td>${S.user.role === 'owner' ? `<button class="btn btn-sm btn-danger" onclick="deleteSearchEntry(${r.id})">×</button>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch { wrap.innerHTML = '<div class="empty" style="padding:.75rem">Could not load history.</div>'; }
}

async function deleteSearchEntry(id) {
  await DEL(`/admin/search-history/${id}`);
  loadSearchHistory();
}

async function clearAllSearchHistory() {
  if (!confirm('Delete ALL search history? This cannot be undone.')) return;
  await apiFetch('/api/admin/search-history', { method: 'DELETE' });
  loadSearchHistory();
}

function pwCell(plain) {
  if (!plain) return '<span style="color:var(--muted);font-size:12px">—</span>';
  // blurred by default, click to toggle
  const id = 'pw-' + Math.random().toString(36).slice(2);
  return `<span id="${id}" class="pw-blur" onclick="togglePw('${id}','${esc(plain)}')" title="Click to reveal" style="cursor:pointer;font-size:12px;filter:blur(4px);user-select:none">${esc(plain)}</span>`;
}

function togglePw(id, plain) {
  const el = document.getElementById(id);
  if (!el) return;
  const blurred = el.style.filter !== 'none';
  el.style.filter = blurred ? 'none' : 'blur(4px)';
}

function renderAdmin(users, teams) {
  const main = document.getElementById('main');
  const isOwner = S.user.role === 'owner';
  main.innerHTML = `
    <div style="max-width:960px">

      <!-- Teams -->
      <div class="section-card">
        <div class="section-card-header">
          <h3>Teams</h3>
          ${isOwner ? `<button class="btn btn-sm" onclick="openAddTeam()">+ Team</button>` : ''}
        </div>
        ${teams.map(t => `
          <div class="flex-row" style="padding:.45rem 0;border-bottom:1px solid var(--border)">
            <span class="color-swatch" style="background:${esc(t.color)}"></span>
            <span style="font-size:13px;font-weight:500">${esc(t.name)}</span>
            <span class="flex-1"></span>
            ${isOwner ? `
              <button class="btn btn-sm" onclick="openEditTeam(${t.id},'${esc(t.name)}','${esc(t.color)}')">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteTeam(${t.id})">Delete</button>
            ` : ''}
          </div>
        `).join('')}
        ${teams.length === 0 ? '<div class="empty" style="padding:1rem">No teams yet.</div>' : ''}
      </div>

      <!-- Custom Roles -->
      <div class="section-card">
        <div class="section-card-header">
          <h3>Custom Roles</h3>
          ${isOwner ? `<button class="btn btn-sm" onclick="openCreateCustomRole()">+ Role</button>` : ''}
        </div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:.75rem">
          Create named roles with any color. Each maps to a permission tier (owner / mod / contributor / member).
          Assigning a custom role to a user automatically sets their permissions to match.
        </p>
        ${S.customRoles.length === 0
          ? '<div class="empty" style="padding:.75rem">No custom roles yet — create one above.</div>'
          : S.customRoles.map(r => `
            <div class="flex-row" style="padding:.45rem 0;border-bottom:1px solid var(--border);gap:.5rem;flex-wrap:wrap">
              <span class="color-swatch" style="background:${esc(r.color)}"></span>
              <span style="font-size:13px;font-weight:500">${esc(r.name)}</span>
              <span style="font-size:11px;color:var(--muted)">(${esc(r.permission_level)} permissions)</span>
              <span class="flex-1"></span>
              <button class="btn btn-sm" onclick="openEditCustomRole(${r.id})">Edit</button>
              <button class="btn btn-sm btn-danger" onclick="deleteCustomRole(${r.id})">Delete</button>
            </div>
          `).join('')}
      </div>

      <!-- Search History -->
      <div class="section-card">
        <div class="section-card-header">
          <h3>🔍 Search History</h3>
          ${isOwner ? `<button class="btn btn-sm btn-danger" onclick="clearAllSearchHistory()">Clear All</button>` : ''}
        </div>
        <div id="search-history-wrap"><div class="empty" style="padding:.75rem">Loading…</div></div>
      </div>

      <!-- Users -->
      <div class="section-card">
        <div class="section-card-header">
          <h3>Users (${users.length})</h3>
          <div class="flex-row" style="gap:.4rem">
            <button class="btn btn-sm" onclick="openCreateUser()">+ Create User</button>
            <a class="btn btn-sm" href="/api/admin/export" download="teamcal-users.csv" title="Download CSV of all users, IPs, and passwords">⬇ Export CSV</a>
          </div>
        </div>
        <p style="font-size:11px;color:var(--muted);margin-bottom:.75rem">
          Passwords shown only for admin-created accounts. Click a blurred password to reveal.
          Self-registered users' passwords are hashed and cannot be recovered — use Reset Password to set a new one.
        </p>
        <div class="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th><th>Password</th><th>Role</th><th>Team</th>
                <th>Status</th><th>Strikes</th><th>IP Address</th><th>Joined</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(u => {
                const strikes = u.strikes || 0;
                const strikesHtml = strikes > 0
                  ? `<span class="strike-count">${'🔴'.repeat(Math.min(strikes,3))} ${strikes}</span>`
                  : '<span class="strike-none">—</span>';
                return `
                <tr>
                  <td style="font-weight:500">${esc(u.username)}</td>
                  <td>${pwCell(u.plain_password)}</td>
                  <td>${roleBadge(u)}</td>
                  <td>${u.team_id ? esc(teams.find(t=>t.id===u.team_id)?.name||'') : '—'}</td>
                  <td>${u.banned
                    ? '<span class="status-pill rejected">Banned</span>'
                    : '<span class="status-pill approved">Active</span>'}</td>
                  <td>${strikesHtml}</td>
                  <td style="color:var(--muted);font-size:12px;font-family:monospace">${esc(u.ip_address)}</td>
                  <td style="color:var(--muted);font-size:12px">${fmtDate(u.created_at)}</td>
                  <td>
                    ${u.id !== S.user.id
                      ? `<div class="flex-row" style="gap:.3rem;flex-wrap:wrap">
                           <button class="btn btn-sm" onclick="openEditUser(${u.id})">Edit</button>
                           <button class="btn btn-sm" onclick="openResetPw(${u.id})">Reset PW</button>
                           <button class="btn btn-sm" style="background:#fde8e8;border-color:#e8b4b4;color:#8b2222" onclick="addStrike(${u.id})">⚠️ Strike</button>
                           ${isOwner && strikes > 0 ? `<button class="btn btn-sm" onclick="removeStrike(${u.id})">↩ −Strike</button>` : ''}
                           ${isOwner ? `<button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})">Del</button>` : ''}
                         </div>`
                      : '<span style="color:var(--muted);font-size:12px">You</span>'}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

// ── Strike system ────────────────────────────────
async function addStrike(userId) {
  const reason = prompt('Reason for strike (optional):');
  if (reason === null) return; // cancelled
  try {
    const data = await POST(`/admin/users/${userId}/strike`, { reason: reason || null });
    const msg = data.auto_banned
      ? `Strike added. User now has ${data.strikes} strikes and has been auto-banned.`
      : `Strike added. User now has ${data.strikes}/3 strikes.`;
    toast(msg, data.auto_banned ? 'error' : 'info', 4000);
    // Refresh admin view
    const [users, teams] = await Promise.all([GET('/admin/users'), GET('/teams')]);
    S.adminUsers = users; S.teams = teams;
    renderAdmin(users, teams);
    loadSearchHistory();
  } catch (e) { toast(e.message, 'error'); }
}

async function removeStrike(userId) {
  if (!confirm('Remove the most recent strike from this user?')) return;
  try {
    const data = await DEL(`/admin/users/${userId}/strike`);
    toast(`Strike removed. User now has ${data.strikes}/3 strikes.`, 'success');
    const [users, teams] = await Promise.all([GET('/admin/users'), GET('/teams')]);
    S.adminUsers = users; S.teams = teams;
    renderAdmin(users, teams);
    loadSearchHistory();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Team CRUD ────────────────────────────────────
function openAddTeam() {
  showModal(`
    <div class="modal-head">
      <h3>New Team</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="saveTeam(event,null)">
      <div class="form-group"><label>Name</label><input id="t-name" required></div>
      <div class="form-group"><label>Color</label><input id="t-color" type="color" value="#3498db"></div>
      <div id="t-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

function openEditTeam(id, name, color) {
  showModal(`
    <div class="modal-head">
      <h3>Edit Team</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="saveTeam(event,${id})">
      <div class="form-group"><label>Name</label><input id="t-name" required value="${esc(name)}"></div>
      <div class="form-group"><label>Color</label><input id="t-color" type="color" value="${esc(color)}"></div>
      <div id="t-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function saveTeam(e, id) {
  e.preventDefault();
  const name  = document.getElementById('t-name').value;
  const color = document.getElementById('t-color').value;
  try {
    if (id) await PUT(`/teams/${id}`, { name, color });
    else    await POST('/teams', { name, color });
    S.teams = await GET('/teams');
    closeModal();
    toast('Team saved', 'success');
    renderSidebar();
    await loadAdmin();
  } catch (err) {
    document.getElementById('t-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deleteTeam(id) {
  if (!confirm('Delete this team? Members will become teamless.')) return;
  try {
    await DEL(`/teams/${id}`);
    S.teams = await GET('/teams');
    S.activeTeams.delete(id);
    toast('Team deleted', 'success');
    renderSidebar();
    await loadAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Create User (admin) ──────────────────────────
function openCreateUser() {
  showModal(`
    <div class="modal-head">
      <h3>Create Account</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:1rem">
      Creates an account and records the password for your reference.
      Share the credentials with the user directly.
    </p>
    <form onsubmit="doCreateUser(event)">
      <div class="form-group">
        <label>Username</label>
        <input id="cu-user" type="text" required minlength="3">
      </div>
      <div class="form-group">
        <label>Password</label>
        <input id="cu-pass" type="text" required minlength="6" placeholder="Set a password for this user">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Role</label>
          <select id="cu-role">
            ${['member','contributor','mod',...(S.user.role==='owner'?['owner']:[])].map(r =>
              `<option value="${r}">${r}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Team</label>
          <select id="cu-team">
            <option value="">— none —</option>
            ${S.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="cu-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Create</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doCreateUser(e) {
  e.preventDefault();
  const body = {
    username: document.getElementById('cu-user').value,
    password: document.getElementById('cu-pass').value,
    role:     document.getElementById('cu-role').value,
    team_id:  document.getElementById('cu-team').value || null,
  };
  try {
    const res = await POST('/admin/users', body);
    closeModal();
    toast(`Account created: ${res.username}`, 'success');
    // Show the credentials one more time in a read-only modal
    showModal(`
      <div class="modal-head">
        <h3>Account Created</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <p style="font-size:13px;margin-bottom:1rem">Share these credentials with the user:</p>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem;font-family:monospace;font-size:13px;line-height:2">
        Username: <strong>${esc(res.username)}</strong><br>
        Password: <strong>${esc(res.plain_password)}</strong>
      </div>
      <button class="btn btn-primary" style="margin-top:1rem;width:100%" onclick="closeModal()">Done</button>
    `);
    await loadAdmin();
  } catch (err) {
    document.getElementById('cu-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

// ── Reset Password ───────────────────────────────
function openResetPw(id) {
  const u = S.adminUsers.find(x => x.id === id);
  if (!u) return;
  showModal(`
    <div class="modal-head">
      <h3>Reset Password — ${esc(u.username)}</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doResetPw(event,${id})">
      <div class="form-group">
        <label>New Password</label>
        <input id="rp-pass" type="text" required minlength="6" placeholder="Enter new password">
      </div>
      <div id="rp-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Set Password</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doResetPw(e, id) {
  e.preventDefault();
  const password = document.getElementById('rp-pass').value;
  const u = S.adminUsers.find(x => x.id === id);
  try {
    await POST(`/admin/users/${id}/reset-password`, { password });
    closeModal();
    // Show confirmation with the new password
    showModal(`
      <div class="modal-head">
        <h3>Password Reset</h3>
        <button class="modal-close" onclick="closeModal()">×</button>
      </div>
      <p style="font-size:13px;margin-bottom:1rem">New credentials for <strong>${esc(u?.username||'')}</strong>:</p>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:.9rem;font-family:monospace;font-size:13px;line-height:2">
        Username: <strong>${esc(u?.username||'')}</strong><br>
        Password: <strong>${esc(password)}</strong>
      </div>
      <button class="btn btn-primary" style="margin-top:1rem;width:100%" onclick="closeModal()">Done</button>
    `);
    await loadAdmin();
  } catch (err) {
    document.getElementById('rp-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

// ── User CRUD ────────────────────────────────────
function openEditUser(id) {
  const u = S.adminUsers.find(x => x.id === id);
  if (!u) return;
  const isOwner = S.user.role === 'owner';
  showModal(`
    <div class="modal-head">
      <h3>Edit User: ${esc(u.username)}</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="saveUser(event,${u.id})">
      <div class="form-group">
        <label>Custom Role <span style="font-size:11px;color:var(--muted)">(overrides base role display + permissions)</span></label>
        <select id="u-custom-role">
          <option value="">— use base role —</option>
          ${S.customRoles.map(r =>
            `<option value="${r.id}" ${u.custom_role_id==r.id?'selected':''}>${esc(r.name)} (${esc(r.permission_level)})</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Base Role <span style="font-size:11px;color:var(--muted)">(fallback when no custom role)</span></label>
        <select id="u-role" ${!isOwner && u.role==='owner' ? 'disabled' : ''}>
          ${['owner','mod','contributor','member'].map(r =>
            `<option value="${r}" ${u.role===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Team</label>
        <select id="u-team">
          <option value="">— none —</option>
          ${S.teams.map(t =>
            `<option value="${t.id}" ${u.team_id==t.id?'selected':''}>${esc(t.name)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group" style="margin-top:.25rem">
        <label class="checkbox-label">
          <input type="checkbox" id="u-banned" ${u.banned?'checked':''}> Banned
        </label>
      </div>
      <div id="u-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function saveUser(e, id) {
  e.preventDefault();
  const customRoleVal = document.getElementById('u-custom-role').value;
  const body = {
    role:           document.getElementById('u-role').value,
    team_id:        document.getElementById('u-team').value || null,
    banned:         document.getElementById('u-banned').checked,
    custom_role_id: customRoleVal ? Number(customRoleVal) : null,
  };
  try {
    await PUT(`/admin/users/${id}`, body);
    S.customRoles = await GET('/custom-roles');
    closeModal();
    toast('User updated', 'success');
    await loadAdmin();
  } catch (err) {
    document.getElementById('u-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

// ── Custom Roles Management ──────────────────────────────────────
function openCreateCustomRole() {
  showModal(`
    <div class="modal-head">
      <h3>New Custom Role</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doSaveCustomRole(event, null)">
      <div class="form-group">
        <label>Role Name</label>
        <input id="cr-name" type="text" required maxlength="40" placeholder="e.g. Troll, VIP, Artist…">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Color</label>
          <input id="cr-color" type="color" value="#7a6652">
        </div>
        <div class="form-group">
          <label>Permission Tier</label>
          <select id="cr-level">
            <option value="member">member — read + chat + submit tickets</option>
            <option value="contributor">contributor — + create assignments</option>
            <option value="mod">mod — + moderate, manage users</option>
            <option value="owner">owner — full access</option>
          </select>
        </div>
      </div>
      <div id="cr-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Create Role</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

function openEditCustomRole(id) {
  const r = S.customRoles.find(x => x.id === id);
  if (!r) return;
  showModal(`
    <div class="modal-head">
      <h3>Edit Role: ${esc(r.name)}</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doSaveCustomRole(event, ${id})">
      <div class="form-group">
        <label>Role Name</label>
        <input id="cr-name" type="text" required maxlength="40" value="${esc(r.name)}">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Color</label>
          <input id="cr-color" type="color" value="${esc(r.color)}">
        </div>
        <div class="form-group">
          <label>Permission Tier</label>
          <select id="cr-level">
            ${['member','contributor','mod','owner'].map(l =>
              `<option value="${l}" ${r.permission_level===l?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div id="cr-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doSaveCustomRole(e, id) {
  e.preventDefault();
  const body = {
    name:             document.getElementById('cr-name').value.trim(),
    color:            document.getElementById('cr-color').value,
    permission_level: document.getElementById('cr-level').value,
  };
  try {
    if (id) await PUT(`/custom-roles/${id}`, body);
    else    await POST('/custom-roles', body);
    S.customRoles = await GET('/custom-roles');
    closeModal();
    toast(id ? 'Role updated' : 'Role created!', 'success');
    await loadAdmin();
  } catch (err) {
    document.getElementById('cr-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deleteCustomRole(id) {
  const r = S.customRoles.find(x => x.id === id);
  if (!confirm(`Delete the "${r?.name}" role? Users with this role will revert to their base role.`)) return;
  try {
    await DEL(`/custom-roles/${id}`);
    S.customRoles = await GET('/custom-roles');
    toast('Role deleted', 'success');
    await loadAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteUser(id) {
  if (!confirm('Permanently delete this user? Their IP address will be released.')) return;
  try {
    await DEL(`/admin/users/${id}`);
    toast('User deleted', 'success');
    await loadAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// CHAT
// ================================================================
async function fetchChat() {
  try {
    const msgs = await GET(`/chat?since=${S.chat.lastId}`);
    if (!msgs.length) return;
    S.chat.msgs = [...S.chat.msgs.slice(-120), ...msgs];
    S.chat.lastId = msgs[msgs.length - 1].id;
    renderChatMsgs();
  } catch { /* silent */ }
}

function renderChatMsgs() {
  const el = document.getElementById('chat-msgs');
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 60;
  el.innerHTML = S.chat.msgs.map(m => `
    <div class="chat-msg">
      <div class="chat-msg-head">
        <span class="chat-msg-user">${esc(m.username||'?')}</span>
        ${roleBadge(m, 'font-size:9px')}
        <span class="chat-msg-time" title="${fmtTime(m.created_at)}">${fmtRelTime(m.created_at)}</span>
      </div>
      <div class="chat-msg-text">${esc(m.message)}</div>
    </div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function chatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

async function sendChat() {
  const inp = document.getElementById('chat-in');
  if (!inp) return;
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';
  inp.style.height = 'auto';
  try { await POST('/chat', { message: msg }); await fetchChat(); }
  catch (e) { toast(e.message, 'error'); }
}

function startChat() {
  fetchChat();
  clearInterval(S.chat.timer);
  S.chat.timer = setInterval(fetchChat, 3000);
}

// ================================================================
// MODAL
// ================================================================
function showModal(html, extraClass = '') {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = 'modal-ov';
  ov.innerHTML = `<div class="modal${extraClass ? ' ' + extraClass : ''}">${html}</div>`;
  ov.addEventListener('click', e => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
}

function closeModal() {
  document.getElementById('modal-ov')?.remove();
}

// ================================================================
// BOARD (Blog + Announcements)
// ================================================================
async function loadBoard() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const posts = await GET('/posts');
    renderBoard(posts);
  } catch { main.innerHTML = `<div class="empty">Failed to load board.</div>`; }
}

function renderBoard(posts) {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div style="max-width:760px">
      <div class="section-card-header" style="margin-bottom:.75rem">
        <h2 style="font-size:1rem;font-weight:600">📌 Board</h2>
        ${canModerate() ? `<button class="btn btn-primary btn-sm" onclick="openCreatePost()">+ New Post</button>` : ''}
      </div>

      ${posts.length === 0
        ? `<div class="empty">Nothing posted yet.</div>`
        : posts.map(p => postCard(p)).join('')}
    </div>`;
}

function postCard(p) {
  const typeBadge = `<span class="post-type-badge ${p.type}">${p.type === 'announcement' ? '📢 Announcement' : '✍️ Blog'}</span>`;
  return `
    <div class="post-card">
      <div class="post-meta">
        ${p.pinned ? '<span style="font-size:11px">📌</span>' : ''}
        ${typeBadge}
        <span style="font-size:11px;color:var(--muted)">by ${esc(p.author_name||'unknown')}</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted)">${fmtDate(p.created_at)}</span>
      </div>
      <div class="post-title">${esc(p.title)}</div>
      <div class="post-body">${esc(p.body)}</div>
      <div class="post-foot">
        <button class="btn btn-sm" onclick="openPostDetail(${p.id})">💬 Comments</button>
        ${canModerate() ? `
          <button class="btn btn-sm" onclick="openEditPost(${p.id})">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deletePost(${p.id})">Delete</button>
        ` : ''}
      </div>
    </div>`;
}

function openCreatePost() {
  showModal(`
    <div class="modal-head">
      <h3>New Post</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doCreatePost(event)">
      <div class="form-row">
        <div class="form-group">
          <label>Type</label>
          <select id="p-type">
            <option value="blog">✍️ Blog</option>
            <option value="announcement">📢 Announcement</option>
          </select>
        </div>
        <div class="form-group" style="flex:0;align-self:flex-end;padding-bottom:.9rem">
          <label class="checkbox-label" style="white-space:nowrap">
            <input type="checkbox" id="p-pin"> Pin to top
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>Title</label>
        <input id="p-title" type="text" required maxlength="160">
      </div>
      <div class="form-group">
        <label>Body</label>
        <textarea id="p-body" required style="min-height:120px"></textarea>
      </div>
      <div id="p-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Publish</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doCreatePost(e) {
  e.preventDefault();
  const body = {
    type:   document.getElementById('p-type').value,
    title:  document.getElementById('p-title').value,
    body:   document.getElementById('p-body').value,
    pinned: document.getElementById('p-pin').checked,
  };
  try {
    await POST('/posts', body);
    closeModal();
    toast('Post published!', 'success');
    await loadBoard();
  } catch (err) {
    document.getElementById('p-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function openEditPost(id) {
  let post;
  try { post = await GET(`/posts/${id}`); } catch { return; }
  showModal(`
    <div class="modal-head">
      <h3>Edit Post</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doEditPost(event,${id})">
      <div class="form-row">
        <div class="form-group">
          <label>Type</label>
          <select id="ep-type">
            <option value="blog" ${post.type==='blog'?'selected':''}>✍️ Blog</option>
            <option value="announcement" ${post.type==='announcement'?'selected':''}>📢 Announcement</option>
          </select>
        </div>
        <div class="form-group" style="flex:0;align-self:flex-end;padding-bottom:.9rem">
          <label class="checkbox-label" style="white-space:nowrap">
            <input type="checkbox" id="ep-pin" ${post.pinned?'checked':''}> Pin to top
          </label>
        </div>
      </div>
      <div class="form-group">
        <label>Title</label>
        <input id="ep-title" type="text" required value="${esc(post.title)}">
      </div>
      <div class="form-group">
        <label>Body</label>
        <textarea id="ep-body" required style="min-height:120px">${esc(post.body)}</textarea>
      </div>
      <div id="ep-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doEditPost(e, id) {
  e.preventDefault();
  const body = {
    type:   document.getElementById('ep-type').value,
    title:  document.getElementById('ep-title').value,
    body:   document.getElementById('ep-body').value,
    pinned: document.getElementById('ep-pin').checked,
  };
  try {
    await PUT(`/posts/${id}`, body);
    closeModal();
    toast('Post updated', 'success');
    await loadBoard();
  } catch (err) {
    document.getElementById('ep-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deletePost(id) {
  if (!confirm('Delete this post and all its comments?')) return;
  try { await DEL(`/posts/${id}`); toast('Deleted', 'success'); await loadBoard(); }
  catch (e) { toast(e.message, 'error'); }
}

async function openPostDetail(id) {
  let post;
  try { post = await GET(`/posts/${id}`); } catch { return; }
  const renderComments = (comments) => comments.length === 0
    ? '<div style="font-size:12px;color:var(--muted);padding:.4rem 0">No comments yet. Be the first!</div>'
    : comments.map(c => `
        <div class="post-comment">
          <div class="post-comment-head">
            <span class="post-comment-user">${esc(c.username||'?')}</span>
            ${roleBadge(c, 'font-size:9px')}
            <span class="post-comment-time">${fmtRelTime(c.created_at)}</span>
            ${canModerate() || c.user_id === S.user.id
              ? `<button class="btn btn-sm btn-danger" style="margin-left:auto;padding:1px 6px;font-size:11px" onclick="deleteComment(${c.id},${id})">×</button>`
              : ''}
          </div>
          <div class="post-comment-text">${esc(c.content)}</div>
        </div>`
      ).join('');

  showModal(`
    <div class="modal-head">
      <h3>${esc(post.title)}</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <div style="font-size:13px;color:var(--muted);white-space:pre-wrap;line-height:1.65;margin-bottom:1rem">${esc(post.body)}</div>
    <div class="label" style="margin-bottom:.4rem">Comments (${post.comments.length})</div>
    <div id="post-comments-wrap" class="post-comments">
      ${renderComments(post.comments)}
    </div>
    <form onsubmit="doAddComment(event,${id})" style="margin-top:.9rem">
      <div class="form-group" style="margin-bottom:.5rem">
        <textarea id="comment-input" required placeholder="Write a comment…" rows="2" style="min-height:0"></textarea>
      </div>
      <div id="comment-err"></div>
      <button type="submit" class="btn btn-primary btn-sm">Post Comment</button>
    </form>`);
}

async function doAddComment(e, postId) {
  e.preventDefault();
  const content = document.getElementById('comment-input').value.trim();
  try {
    await POST(`/posts/${postId}/comments`, { content });
    toast('Comment added', 'success');
    closeModal();
    await openPostDetail(postId);
  } catch (err) {
    document.getElementById('comment-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deleteComment(commentId, postId) {
  try {
    await DEL(`/post-comments/${commentId}`);
    toast('Comment removed', 'success');
    closeModal();
    await openPostDetail(postId);
  } catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// TICKETS
// ================================================================
const TICKET_STATUS_LABELS   = { open: 'Open', 'in-progress': 'In Progress', resolved: 'Resolved', closed: 'Closed' };
const TICKET_PRIORITY_LABELS = { low: 'Low', normal: 'Normal', high: 'High' };
const TICKET_TYPE_LABELS     = { bug: '🐛 Bug', suggestion: '💡 Suggestion' };

async function loadTickets() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="empty">Loading tickets…</div>`;
  try {
    S.tickets = await GET('/tickets');
    renderTickets();
  } catch { main.innerHTML = `<div class="empty">Failed to load tickets.</div>`; }
}

function renderTickets() {
  const main = document.getElementById('main');
  const isMod = canModerate();

  // Filter state (stored locally)
  const activeFilter = renderTickets._filter || 'all';

  const counts = { all: S.tickets.length };
  for (const t of S.tickets) {
    counts[t.status] = (counts[t.status] || 0) + 1;
  }

  const visible = activeFilter === 'all'
    ? S.tickets
    : S.tickets.filter(t => t.status === activeFilter);

  const filterBtn = (key, label) => `
    <button class="filter-btn ${activeFilter===key?'active':''}"
            onclick="setTicketFilter('${key}')">${label}${counts[key]?' <span class=badge-inline>${counts[key]}</span>':''}</button>
  `;

  main.innerHTML = `
    <div style="max-width:800px">
      <div class="section-card-header" style="margin-bottom:.75rem">
        <h2 style="font-size:1rem;font-weight:600">🎫 Tickets</h2>
        <button class="btn btn-primary btn-sm" onclick="openSubmitTicket()">+ Submit Ticket</button>
      </div>

      <div class="filter-bar">
        ${filterBtn('all',        'All')}
        ${filterBtn('open',       'Open')}
        ${filterBtn('in-progress','In Progress')}
        ${filterBtn('resolved',   'Resolved')}
        ${filterBtn('closed',     'Closed')}
      </div>

      ${visible.length === 0
        ? `<div class="empty">No tickets here yet.</div>`
        : visible.map(t => ticketCard(t, isMod)).join('')
      }
    </div>`;
}

renderTickets._filter = 'open';

function setTicketFilter(f) {
  renderTickets._filter = f;
  renderTickets();
}

function ticketCard(t, isMod) {
  const priorityClass = { low: 'pill-low', normal: 'pill-normal', high: 'pill-high' }[t.priority] || '';
  const statusClass   = { open: 'pill-open', 'in-progress': 'pill-inprogress', resolved: 'pill-resolved', closed: 'pill-closed' }[t.status] || '';
  const isMine = t.submitted_by === S.user.id;

  return `
    <div class="ticket-card" id="tc-${t.id}">
      <div class="ticket-head">
        <span class="ticket-type">${TICKET_TYPE_LABELS[t.type] || t.type}</span>
        <span class="status-pill ${statusClass}">${TICKET_STATUS_LABELS[t.status] || t.status}</span>
        <span class="status-pill ${priorityClass}" style="font-size:9px">${TICKET_PRIORITY_LABELS[t.priority]} priority</span>
        <span style="margin-left:auto;font-size:11px;color:var(--muted)">${fmtDate(t.created_at)}</span>
      </div>
      <div class="ticket-title">${esc(t.title)}</div>
      <div class="ticket-body">${esc(t.description)}</div>
      ${t.mod_note ? `<div class="ticket-mod-note">💬 Staff: ${esc(t.mod_note)}</div>` : ''}
      <div class="ticket-foot">
        <span style="font-size:11px;color:var(--muted)">by ${esc(t.submitter_name||'unknown')}</span>
        ${t.resolver_name ? `<span style="font-size:11px;color:var(--muted)">· resolved by ${esc(t.resolver_name)}</span>` : ''}
        <span style="flex:1"></span>
        ${isMod ? `<button class="btn btn-sm" onclick="openManageTicket(${t.id})">Manage</button>` : ''}
        ${!isMod && isMine && t.status === 'open' ? `<button class="btn btn-sm btn-danger" onclick="deleteMyTicket(${t.id})">Delete</button>` : ''}
        ${isOwner() && isMod ? `<button class="btn btn-sm btn-danger" onclick="deleteTicketAdmin(${t.id})">Delete</button>` : ''}
      </div>
    </div>`;
}

function openSubmitTicket() {
  showModal(`
    <div class="modal-head">
      <h3>Submit a Ticket</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <form onsubmit="doSubmitTicket(event)">
      <div class="form-row">
        <div class="form-group">
          <label>Type</label>
          <select id="tk-type">
            <option value="bug">🐛 Bug Report</option>
            <option value="suggestion">💡 Suggestion</option>
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="tk-priority">
            <option value="low">Low</option>
            <option value="normal" selected>Normal</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Title</label>
        <input id="tk-title" type="text" required maxlength="120" placeholder="Short summary…">
      </div>
      <div class="form-group">
        <label>Description</label>
        <textarea id="tk-desc" required placeholder="Describe the bug or suggestion in detail…" style="min-height:100px"></textarea>
      </div>
      <div id="tk-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Submit</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doSubmitTicket(e) {
  e.preventDefault();
  const body = {
    type:        document.getElementById('tk-type').value,
    priority:    document.getElementById('tk-priority').value,
    title:       document.getElementById('tk-title').value,
    description: document.getElementById('tk-desc').value,
  };
  try {
    await POST('/tickets', body);
    closeModal();
    toast('Ticket submitted!', 'success');
    await loadTickets();
    renderSidebar(); // refresh badge
  } catch (err) {
    document.getElementById('tk-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

function openManageTicket(id) {
  const t = S.tickets.find(x => x.id === id);
  if (!t) return;
  showModal(`
    <div class="modal-head">
      <h3>Manage Ticket #${t.id}</h3>
      <button class="modal-close" onclick="closeModal()">×</button>
    </div>
    <p style="font-size:13px;font-weight:600;margin-bottom:.3rem">${esc(t.title)}</p>
    <p style="font-size:12px;color:var(--muted);margin-bottom:1rem;white-space:pre-wrap">${esc(t.description)}</p>
    <form onsubmit="doManageTicket(event,${id})">
      <div class="form-row">
        <div class="form-group">
          <label>Status</label>
          <select id="tm-status">
            ${Object.entries(TICKET_STATUS_LABELS).map(([v,l]) =>
              `<option value="${v}" ${t.status===v?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>Priority</label>
          <select id="tm-priority">
            ${Object.entries(TICKET_PRIORITY_LABELS).map(([v,l]) =>
              `<option value="${v}" ${t.priority===v?'selected':''}>${l}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>Staff Note (visible to submitter)</label>
        <textarea id="tm-note" placeholder="Optional note…">${esc(t.mod_note||'')}</textarea>
      </div>
      <div id="tm-err"></div>
      <div class="flex-row" style="margin-top:.9rem">
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </form>`);
}

async function doManageTicket(e, id) {
  e.preventDefault();
  const body = {
    status:   document.getElementById('tm-status').value,
    priority: document.getElementById('tm-priority').value,
    mod_note: document.getElementById('tm-note').value,
  };
  try {
    await PUT(`/tickets/${id}`, body);
    closeModal();
    toast('Ticket updated', 'success');
    await loadTickets();
    renderSidebar();
  } catch (err) {
    document.getElementById('tm-err').innerHTML = `<div class="error-msg">${esc(err.message)}</div>`;
  }
}

async function deleteMyTicket(id) {
  if (!confirm('Delete your ticket?')) return;
  try { await DEL(`/tickets/${id}`); toast('Deleted', 'success'); await loadTickets(); renderSidebar(); }
  catch (e) { toast(e.message, 'error'); }
}

async function deleteTicketAdmin(id) {
  if (!confirm('Permanently delete this ticket?')) return;
  try { await DEL(`/tickets/${id}`); toast('Deleted', 'success'); await loadTickets(); renderSidebar(); }
  catch (e) { toast(e.message, 'error'); }
}

// ================================================================
// SEARCH (DuckDuckGo-style)
// ================================================================

function openBrowseUrl(url) {
  const pane        = document.getElementById('search-browse-pane');
  const placeholder = document.getElementById('search-browse-placeholder');
  if (!pane) return;
  pane.style.display = 'flex';
  if (placeholder) placeholder.style.display = 'none';
  pane.innerHTML = `
    <div class="browse-bar">
      <span class="browse-url" title="${esc(url)}">${esc(url)}</span>
      <a href="${esc(url)}" target="_blank" rel="noopener" class="btn btn-sm browse-open-btn">↗ New tab</a>
      <button class="btn btn-sm" onclick="closeBrowsePane()">✕</button>
    </div>
    <iframe src="${esc(url)}" class="browse-frame" title="Browse"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"></iframe>
  `;
}

function closeBrowsePane() {
  const pane        = document.getElementById('search-browse-pane');
  const placeholder = document.getElementById('search-browse-placeholder');
  if (pane) pane.style.display = 'none';
  if (placeholder) placeholder.style.display = 'flex';
}

function renderSearchView(query = '') {
  const main = document.getElementById('main');
  if (!main) return;

  const ddgLogo = `<svg width="20" height="20" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;margin-right:.35rem;flex-shrink:0"><circle cx="64" cy="64" r="64" fill="#DE5833"/><circle cx="64" cy="57" r="30" fill="#fff"/><circle cx="72" cy="50" r="8" fill="#4A4A4A"/><circle cx="74" cy="48" r="3" fill="#fff"/></svg>`;

  if (!query) {
    // Home / empty state — centered like DDG homepage
    main.innerHTML = `
      <div class="ddg-home">
        <div class="ddg-home-logo">
          <svg width="80" height="80" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="64" cy="64" r="64" fill="#DE5833"/><circle cx="64" cy="57" r="30" fill="#fff"/><circle cx="72" cy="50" r="8" fill="#4A4A4A"/><circle cx="74" cy="48" r="3" fill="#fff"/></svg>
          <span>DuckDuckGo</span>
        </div>
        <form class="ddg-home-form" onsubmit="doSearch(event)">
          <div class="ddg-home-input-wrap">
            <input id="search-q" class="ddg-home-input" type="text" placeholder="Search the web privately…" autocomplete="off" autofocus>
            <button type="submit" class="ddg-home-btn">Search</button>
          </div>
        </form>
        <p class="ddg-home-tagline">Your privacy. Protected. Results from DuckDuckGo.</p>
      </div>`;
    return;
  }

  // Results layout
  main.innerHTML = `
    <div class="ddg-results-page">
      <div class="ddg-results-header">
        <div class="ddg-results-logo" onclick="renderSearchView()" style="cursor:pointer" title="New search">
          ${ddgLogo}<span>DuckDuckGo</span>
        </div>
        <form class="ddg-results-search-form" onsubmit="doSearch(event)">
          <div class="ddg-results-input-wrap">
            <input id="search-q" class="ddg-results-input" type="text"
              value="${esc(query)}" autocomplete="off">
            <button type="submit" class="ddg-results-btn">🔍</button>
          </div>
        </form>
      </div>

      <div class="ddg-results-body">
        <div class="ddg-results-left">
          <div id="ddg-instant" class="ddg-instant-wrap"></div>
          <div id="ddg-web" class="ddg-web-wrap">
            <div class="ddg-web-loading">Searching…</div>
          </div>
        </div>
        <div class="ddg-results-right">
          <div id="search-browse-pane" class="search-browse-pane" style="display:none"></div>
          <div id="search-browse-placeholder" class="search-browse-placeholder">
            <div class="browse-ph-icon">🌐</div>
            <div>Click any result to<br>preview it here</div>
          </div>
        </div>
      </div>
    </div>`;

  fetchDDGInstant(query);
  fetchDDGResults(query);
}

async function doSearch(e) {
  e.preventDefault();
  const q = (document.getElementById('search-q')?.value || '').trim();
  if (!q) return;
  renderSearchView(q);
}

// Instant answer (Wikipedia summary, answer box, related topics)
async function fetchDDGInstant(query) {
  const el = document.getElementById('ddg-instant');
  if (!el) return;
  try {
    const res  = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { credentials: 'include' });
    const data = await res.json();
    let html   = '';

    if (data.AbstractText) {
      html += `
        <div class="ddg-ia-card">
          ${data.Image ? `<img src="${esc('https://duckduckgo.com' + data.Image)}" class="ddg-ia-img" alt="">` : ''}
          <div class="ddg-ia-body">
            <div class="ddg-ia-source">
              ${data.AbstractSource ? `<a href="${esc(data.AbstractURL)}" onclick="openBrowseUrl('${esc(data.AbstractURL)}');return false;" class="ddg-ia-source-link">${esc(data.AbstractSource)}</a>` : ''}
            </div>
            <p class="ddg-ia-text">${esc(data.AbstractText)}</p>
          </div>
        </div>`;
    }
    if (data.Answer) {
      html += `<div class="ddg-ia-card ddg-ia-answer"><span class="ddg-ia-answer-label">Answer</span><span class="ddg-ia-answer-val">${esc(data.Answer)}</span></div>`;
    }
    if (data.Definition) {
      html += `<div class="ddg-ia-card"><div class="ddg-ia-def-label">Definition</div><p>${esc(data.Definition)}</p>${data.DefinitionSource ? `<a href="${esc(data.DefinitionURL)}" onclick="openBrowseUrl('${esc(data.DefinitionURL)}');return false;" class="ddg-ia-more">Source: ${esc(data.DefinitionSource)} →</a>` : ''}</div>`;
    }

    el.innerHTML = html;
  } catch (_) {}
}

// Full web results
async function fetchDDGResults(query) {
  const el = document.getElementById('ddg-web');
  if (!el) return;
  try {
    const res  = await fetch(`/api/search/results?q=${encodeURIComponent(query)}`, { credentials: 'include' });
    const data = await res.json();
    const results = data.results || [];

    if (!results.length) {
      el.innerHTML = `<div class="ddg-no-results">No web results found. <a href="https://duckduckgo.com/?q=${encodeURIComponent(query)}" target="_blank" rel="noopener" class="ddg-ext-link">Try on DuckDuckGo ↗</a></div>`;
      return;
    }

    el.innerHTML = results.map((r, i) => `
      <div class="ddg-result" onclick="openBrowseUrl('${esc(r.url).replace(/'/g,"\\'")}')">
        <div class="ddg-result-meta">
          <img class="ddg-result-favicon" src="${esc(r.favicon)}" alt="" loading="lazy"
            onerror="this.style.display='none'">
          <span class="ddg-result-displayurl">${esc(r.displayUrl)}</span>
          <a href="${esc(r.url)}" target="_blank" rel="noopener" class="ddg-result-opentab"
            onclick="event.stopPropagation()" title="Open in new tab">↗</a>
        </div>
        <a class="ddg-result-title" href="${esc(r.url)}"
          onclick="openBrowseUrl('${esc(r.url).replace(/'/g,"\\'")}');return false;">${esc(r.title)}</a>
        ${r.snippet ? `<p class="ddg-result-snippet">${esc(r.snippet)}</p>` : ''}
      </div>`).join('');

  } catch (err) {
    if (el) el.innerHTML = `<div class="ddg-no-results">Couldn't load results. <a href="https://duckduckgo.com/?q=${encodeURIComponent(query)}" target="_blank" rel="noopener" class="ddg-ext-link">Search on DuckDuckGo ↗</a></div>`;
  }
}

// ================================================================
// AI HOMEWORK SOLVER
// ================================================================
let _hwImageBase64 = null;
let _hwSolution    = null;
let _hwTeamId      = '';
let _hwDueDate     = '';
let _hwTitle       = 'AI Homework';

function renderHomeworkView() {
  const main = document.getElementById('main');
  if (!main) return;
  const teamOpts = S.teams.map(t =>
    `<option value="${t.id}">${esc(t.name)}</option>`
  ).join('');

  main.innerHTML = `
    <div class="hw-page">
      <div class="hw-header">
        <div class="hw-title">🤖 AI Homework Solver</div>
        <p class="hw-subtitle">Upload a photo or scan of your homework — AI reads it and solves it step by step.</p>
      </div>

      <!-- Step 1: Upload -->
      <div id="hw-step1" class="hw-step">
        <div class="hw-dropzone" id="hw-drop"
          onclick="document.getElementById('hw-file').click()"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="hwDrop(event)">
          <div class="hw-drop-icon">📷</div>
          <div class="hw-drop-text">Drop homework image here</div>
          <div class="hw-drop-hint">or click to browse — JPG, PNG, PDF scan, etc.</div>
          <input type="file" id="hw-file" accept="image/*" style="display:none" onchange="hwFileSelected(this)">
        </div>
      </div>

      <!-- Step 2: Confirm team/date (hidden until image chosen) -->
      <div id="hw-step2" class="hw-step" style="display:none">
        <div class="hw-step2-grid">
          <div class="hw-preview-col">
            <img id="hw-img-preview" class="hw-img-preview" alt="Homework preview">
            <button class="btn btn-sm" onclick="hwReset()" style="margin-top:.5rem">↩ Change image</button>
          </div>
          <div class="hw-form-col">
            <h3 style="margin-bottom:1rem">Before solving…</h3>
            <div class="form-group">
              <label>Which team is this for?</label>
              <select id="hw-team-sel">
                <option value="">— No team —</option>
                ${teamOpts}
              </select>
            </div>
            <div class="form-group">
              <label>Due date</label>
              <input type="date" id="hw-due-input" value="${todayISO()}">
            </div>
            <button class="btn btn-primary hw-solve-btn" onclick="hwSolve()">
              🤖 Solve with AI
            </button>
            <p style="font-size:.75rem;color:var(--muted);margin-top:.6rem">Requires OPENAI_API_KEY set in Railway settings.</p>
          </div>
        </div>
      </div>

      <!-- Step 3: Loading -->
      <div id="hw-step3" class="hw-step" style="display:none">
        <div class="hw-loading-state">
          <div class="hw-spinner"></div>
          <div class="hw-loading-msg">AI is reading and solving your homework…</div>
          <div class="hw-loading-sub">Usually takes 10–30 seconds</div>
        </div>
      </div>

      <!-- Step 4: Result -->
      <div id="hw-step4" class="hw-step" style="display:none">
        <div class="hw-result-bar">
          <button class="btn" onclick="hwReset()">↩ Solve another</button>
          <button class="btn btn-primary" id="hw-cal-btn" onclick="hwAddToCalendar()">📅 Add to Calendar</button>
        </div>
        <div id="hw-result-content" class="hw-result-content"></div>
      </div>
    </div>`;

  // Reset state if returning to the view
  if (!_hwImageBase64) hwReset();
}

function hwDrop(e) {
  e.preventDefault();
  document.getElementById('hw-drop').classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f && f.type.startsWith('image/')) hwLoadFile(f);
  else toast('Please drop an image file', 'error');
}

function hwFileSelected(input) {
  const f = input.files[0];
  if (f) hwLoadFile(f);
}

function hwLoadFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    _hwImageBase64 = ev.target.result;
    const preview = document.getElementById('hw-img-preview');
    if (preview) preview.src = _hwImageBase64;
    document.getElementById('hw-step1').style.display = 'none';
    document.getElementById('hw-step2').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function hwReset() {
  _hwImageBase64 = null;
  _hwSolution    = null;
  _hwTitle       = 'AI Homework';
  const s1 = document.getElementById('hw-step1');
  const s2 = document.getElementById('hw-step2');
  const s3 = document.getElementById('hw-step3');
  const s4 = document.getElementById('hw-step4');
  if (s1) s1.style.display = 'block';
  if (s2) s2.style.display = 'none';
  if (s3) s3.style.display = 'none';
  if (s4) s4.style.display = 'none';
  const fi = document.getElementById('hw-file');
  if (fi) fi.value = '';
}

async function hwSolve() {
  if (!_hwImageBase64) return;
  _hwTeamId  = document.getElementById('hw-team-sel')?.value  || '';
  _hwDueDate = document.getElementById('hw-due-input')?.value || todayISO();

  document.getElementById('hw-step2').style.display = 'none';
  document.getElementById('hw-step3').style.display = 'flex';

  try {
    const res  = await fetch('/api/ai/homework', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: _hwImageBase64 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI error');

    _hwSolution = data.solution;
    // Extract suggested title
    const m = data.solution.match(/##\s*Suggested Title\s*\n+([^\n#]+)/i);
    if (m) _hwTitle = m[1].trim().replace(/^[*_\s]+|[*_\s]+$/g, '');

    document.getElementById('hw-step3').style.display = 'none';
    document.getElementById('hw-step4').style.display = 'block';
    document.getElementById('hw-result-content').innerHTML = hwRenderMarkdown(data.solution);
  } catch (err) {
    document.getElementById('hw-step3').style.display = 'none';
    document.getElementById('hw-step2').style.display = 'block';
    toast('AI error: ' + err.message, 'error');
  }
}

async function hwAddToCalendar() {
  const btn = document.getElementById('hw-cal-btn');
  try {
    await POST('/assignments', {
      title:       _hwTitle || 'AI Homework',
      description: (_hwSolution || '').slice(0, 3000),
      due_date:    _hwDueDate || todayISO(),
      team_id:     _hwTeamId || null,
    });
    toast('Added to calendar! ✅', 'success');
    if (btn) { btn.textContent = '✅ Added!'; btn.disabled = true; }
  } catch (err) { toast(err.message, 'error'); }
}

// Simple markdown → HTML (safe — input is AI output, not user input)
function hwRenderMarkdown(md) {
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // headers
    .replace(/^#### (.+)$/gm,'<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    // inline
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,    '<em>$1</em>')
    .replace(/`([^`]+)`/g,    '<code>$1</code>')
    // lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    // paragraphs: blank lines between non-tag blocks
    .replace(/\n\n+/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^(?!<[hlipbcu])(.+)/gm, match => match) // keep as-is inside tags
    // wrap in paragraph
    .replace(/^(.)/m, '<p>$1')
    + '</p>';
}

// ================================================================
// GAMES (gn-math.dev)
// ================================================================
const GNM_COVERS = 'https://cdn.jsdelivr.net/gh/freebuisness/covers@main';
const GNM_HTML   = 'https://cdn.jsdelivr.net/gh/freebuisness/html@main';
const GNM_ZONES  = 'https://cdn.jsdelivr.net/gh/freebuisness/assets@latest/zones.json';

let _gnmGames      = null;   // cached full list
let _gnmFilter     = '';     // current search string
let _gnmCategory   = 'All';  // current category
const GNM_PAGE     = 40;     // cards per page
let _gnmPage       = 1;

function gnmUrl(raw) {
  if (!raw) return null;
  return raw
    .replace('{HTML_URL}',  GNM_HTML)
    .replace('{COVER_URL}', GNM_COVERS);
}

async function loadGames() {
  const main = document.getElementById('main');
  if (!main) return;

  if (!_gnmGames) {
    main.innerHTML = `<div class="games-loading"><span class="spinner"></span> Loading games…</div>`;
    try {
      const res  = await fetch(GNM_ZONES);
      const data = await res.json();
      _gnmGames  = data.filter(g => g.id >= 0 && g.name && g.url);
    } catch {
      main.innerHTML = `<div class="games-loading">Failed to load games. Try again later.</div>`;
      return;
    }
  }

  _gnmFilter   = '';
  _gnmCategory = 'All';
  _gnmPage     = 1;
  renderGamesView();
}

function gnmCategories() {
  if (!_gnmGames) return ['All'];
  const cats = new Set();
  for (const g of _gnmGames) {
    if (g.category) cats.add(g.category);
    if (g.tags) (Array.isArray(g.tags) ? g.tags : [g.tags]).forEach(t => cats.add(t));
  }
  return ['All', ...[...cats].sort()];
}

function gnmFiltered() {
  if (!_gnmGames) return [];
  let list = _gnmGames;
  if (_gnmFilter) {
    const q = _gnmFilter.toLowerCase();
    list = list.filter(g => g.name.toLowerCase().includes(q) || (g.author || '').toLowerCase().includes(q));
  }
  if (_gnmCategory !== 'All') {
    list = list.filter(g =>
      g.category === _gnmCategory ||
      (Array.isArray(g.tags) ? g.tags.includes(_gnmCategory) : g.tags === _gnmCategory)
    );
  }
  return list;
}

function renderGamesView() {
  const main = document.getElementById('main');
  if (!main) return;

  const filtered = gnmFiltered();
  const paged    = filtered.slice(0, _gnmPage * GNM_PAGE);
  const hasMore  = paged.length < filtered.length;

  main.innerHTML = `
    <div class="games-page">
      <div class="games-toolbar">
        <div class="games-title">🎮 Games <span class="games-count">${filtered.length} games</span></div>
        <input id="gnm-search" class="search-input" type="text" placeholder="Search games…"
          value="${esc(_gnmFilter)}" oninput="gnmDoSearch(this.value)">
      </div>

      ${S.user ? `<div id="gnm-recent-wrap">
        <div class="games-section-title">🕹️ Recently Played</div>
        <div id="gnm-recent" class="games-grid games-grid-sm">
          <div class="games-loading"><span class="spinner"></span> Loading…</div>
        </div>
      </div>` : ''}

      <div class="games-section-title">All Games</div>
      <div class="games-grid" id="gnm-grid">
        ${paged.map(g => gnmCard(g)).join('')}
        ${!paged.length ? `<div class="games-empty">No games found for "<strong>${esc(_gnmFilter)}</strong>"</div>` : ''}
      </div>

      ${hasMore ? `<div class="games-more-row">
        <button class="btn btn-primary" onclick="gnmLoadMore()">Load more (${filtered.length - paged.length} remaining)</button>
      </div>` : ''}

      <div class="games-credit">Games provided by <a href="https://gn-math.dev" target="_blank" rel="noopener">gn-math.dev</a></div>
    </div>
  `;

  if (S.user) loadRecentGames();
}

async function loadRecentGames() {
  const wrap = document.getElementById('gnm-recent');
  if (!wrap) return;
  try {
    const recentRes = await fetch('/api/games/recent', { credentials: 'include' });
    const recent = recentRes.ok ? await recentRes.json() : [];
    if (!recent || !recent.length) {
      wrap.innerHTML = `<div class="games-empty" style="grid-column:1/-1">No games played yet — click any game to start!</div>`;
      return;
    }
    wrap.innerHTML = recent.map(r => {
      // Find full game object to get cover
      const g = _gnmGames ? _gnmGames.find(x => String(x.id) === String(r.game_id)) : null;
      const cover = g ? gnmUrl(g.cover) : null;
      const name  = esc(r.game_name);
      return `
        <div class="game-card game-card-recent" onclick="openGame(${r.game_id})" title="${name}">
          <div class="game-card-img">
            ${cover ? `<img src="${esc(cover)}" alt="${name}" loading="lazy"
              onerror="this.style.display='none';this.parentElement.classList.add('no-img')">` : ''}
            <span class="game-card-play">▶</span>
          </div>
          <div class="game-card-name">${name}</div>
          <div class="game-card-plays">${r.play_count}× played</div>
        </div>`;
    }).join('');
  } catch (_) {
    wrap.innerHTML = '';
  }
}

function gnmCard(g) {
  const cover = gnmUrl(g.cover);
  const name  = esc(g.name);
  return `
    <div class="game-card" onclick="openGame(${g.id})" title="${name}">
      <div class="game-card-img">
        <img src="${esc(cover)}" alt="${name}" loading="lazy"
          onerror="this.style.display='none';this.parentElement.classList.add('no-img')">
        <span class="game-card-play">▶</span>
      </div>
      <div class="game-card-name">${name}</div>
    </div>`;
}

function gnmDoSearch(val) {
  _gnmFilter = val;
  _gnmPage   = 1;
  renderGamesView();
}

function gnmLoadMore() {
  _gnmPage++;
  renderGamesView();
}

async function openGame(id) {
  if (!_gnmGames) return;
  const g = _gnmGames.find(x => x.id === id);
  if (!g) return;

  const rawUrl = gnmUrl(g.url) || g.url;
  if (!rawUrl) return;

  // If it's an external link (discord, etc.) open directly
  const isExternal = rawUrl.startsWith('http') && !rawUrl.includes('jsdelivr');
  const gameUrl = isExternal
    ? rawUrl
    : `/play/${g.id}?url=${encodeURIComponent(rawUrl)}`;

  // Open as about:blank tab so the URL bar stays clean, content loaded via iframe
  const w = window.open('', '_blank');
  if (w) {
    const name = esc(g.name || 'Game');
    w.document.open();
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${name}</title><style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}iframe{display:block;width:100%;height:100%;border:none}</style></head><body><iframe src="${gameUrl}" allowfullscreen allow="autoplay;fullscreen;pointer-lock" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock allow-top-navigation"></iframe></body></html>`);
    w.document.close();
  }

  // Record play progress for logged-in users (fire-and-forget)
  if (S.user) {
    try {
      await fetch('/api/games/play', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game_id: String(g.id), game_name: g.name })
      });
      // Refresh recently-played section if visible
      const recentWrap = document.getElementById('gnm-recent');
      if (recentWrap) loadRecentGames();
    } catch (_) {}
  }
}

// ── Go ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// Global: ESC closes modals
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});
