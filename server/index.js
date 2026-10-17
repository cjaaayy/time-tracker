const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SessionStore, UserStore, ExclusionStore, PayoutStore, RoleStore, SettingsStore, configureBackend } = require('./storage');
const { createMySqlBackend } = require('./mysqlBackend');
const { normalizeSession, summarize } = require('./domain');

const host = process.env.TIME_TRACKER_HOST || '127.0.0.1';
const port = Number(process.env.TIME_TRACKER_PORT || 8080);
const dataDirectory = path.resolve(process.env.TIME_TRACKER_DATA_DIR || path.join(__dirname, 'data'));
const publicDirectory = path.join(__dirname, 'public');
let sessions;
let users;
let exclusions;
let payouts;
let roles;
let settings;
let mysqlBackend;
const webSessions = new Map();
const PERMISSIONS = [
  ['view_own_summary', 'Eigene Auswertung ansehen'],
  ['view_team_summary', 'Teamübersicht ansehen'],
  ['view_global_summary', 'Globale anonyme Statistik ansehen'],
  ['view_all_summaries', 'Auswertungen anderer Benutzer ansehen'],
  ['view_sessions', 'Sessions ansehen'],
  ['manage_exclusions', 'Projekt-/Branch-Einträge ausschließen'],
  ['view_allowances', 'Zulagen ansehen'],
  ['manage_payouts', 'Zulagen als ausgezahlt markieren'],
  ['manage_users', 'Benutzer bestätigen und Rollen zuweisen'],
  ['manage_roles', 'Rollen und Rechte verwalten'],
];

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      await mysqlBackend.ping();
      return json(response, 200, { status: 'ok', database: 'mysql' });
    }
    if (url.pathname.startsWith('/api/auth/')) return await handleAuth(request, response, url);
    if (url.pathname.startsWith('/api/admin/')) {
      const user = authenticateWeb(request);
      if (!user) return json(response, 401, { error: 'Nicht angemeldet' });
      return await handleAdmin(request, response, url, user);
    }
    if (url.pathname.startsWith('/api/')) {
      const user = authenticate(request);
      if (!user) return json(response, 401, { error: 'Nicht autorisiert' });
      return await handleApi(request, response, url, user);
    }
    return serveStatic(response, url.pathname);
  } catch (error) {
    return json(response, 500, { error: 'Interner Serverfehler' });
  }
});

async function handleAuth(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    try {
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const password = validatePassword(body.password);
      const salt = crypto.randomBytes(16).toString('hex');
      const firstUser = users.list().length === 0;
      const apiKey = firstUser ? createApiKey() : null;
      const user = users.create({
        id: crypto.randomUUID(), username, salt,
        passwordHash: hashPassword(password, salt), apiKeyHash: apiKey ? hashApiKey(apiKey) : null,
        createdAt: new Date().toISOString(), role: firstUser ? 'admin' : 'user',
        approved: firstUser, active: true,
      });
      createLogin(response, user, false);
      return json(response, 201, { user: publicUser(user), ...(apiKey ? { apiKey } : {}) });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(request);
    const user = users.findByUsername(String(body.username || ''));
    if (!user || user.active === false || !safeEqual(hashPassword(String(body.password || ''), user.salt), user.passwordHash)) {
      return json(response, 401, { error: 'Benutzername oder Passwort ist falsch' });
    }
    createLogin(response, user, Boolean(body.rememberMe));
    return json(response, 200, { user: publicUser(user) });
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    const sessionId = cookie(request, 'tt_session');
    if (sessionId) { webSessions.delete(sessionId); persistWebSessions(); }
    setSessionCookie(response, '', 0);
    return json(response, 204);
  }
  const user = authenticateWeb(request);
  if (!user) return json(response, 401, { error: 'Nicht angemeldet' });
  if (request.method === 'GET' && url.pathname === '/api/auth/me') return json(response, 200, { user: publicUser(user) });
  if (request.method === 'POST' && url.pathname === '/api/auth/api-key') {
    const apiKey = createApiKey();
    if (!user.approved) return json(response, 403, { error: 'Konto wartet auf Freigabe' });
    users.updateApiKey(user.id, hashApiKey(apiKey));
    return json(response, 200, { apiKey });
  }
  return json(response, 404, { error: 'Nicht gefunden' });
}

async function handleApi(request, response, url, user) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { status: 'ok' });
  if (!user.approved) return json(response, 403, { error: 'Konto wartet auf Freigabe' });
  if (request.method === 'GET' && url.pathname === '/api/sessions') {
    if (!hasPermission(user, 'view_sessions')) return json(response, 403, { error: 'Keine Berechtigung für Sessions' });
    const selectedUserId = hasPermission(user, 'view_all_summaries') ? (url.searchParams.get('userId') || user.id) : user.id;
    if (!users.list().some((entry) => entry.id === selectedUserId && entry.active !== false)) return json(response, 404, { error: 'Aktiver Benutzer nicht gefunden' });
    return json(response, 200, { sessions: sessions.list(selectedUserId) });
  }
  if (request.method === 'POST' && url.pathname === '/api/sessions') {
    try {
      const body = await readJson(request);
      const values = Array.isArray(body.sessions) ? body.sessions : [body];
      if (values.length > 1000) return json(response, 413, { error: 'Maximal 1000 Sessions pro Anfrage' });
      const normalized = values.map((value) => ({ ...normalizeSession(value), userId: user.id }));
      return json(response, 200, { accepted: sessions.upsert(normalized), sessions: normalized });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
    if (!hasPermission(user, 'view_sessions')) return json(response, 403, { error: 'Keine Berechtigung' });
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length));
    return sessions.remove(id, user.id) ? json(response, 204) : json(response, 404, { error: 'Session nicht gefunden' });
  }
  if (request.method === 'GET' && url.pathname === '/api/summary') {
    try {
      if (!hasPermission(user, 'view_own_summary')) return json(response, 403, { error: 'Keine Berechtigung für Auswertungen' });
      const selectedUserId = hasPermission(user, 'view_all_summaries') && url.searchParams.get('userId') ? url.searchParams.get('userId') : user.id;
      const selectedUser = users.list().find((entry) => entry.id === selectedUserId && entry.active !== false);
      if (!selectedUser) return json(response, 404, { error: 'Aktiver Benutzer nicht gefunden' });
      const allSessions = sessions.list(selectedUserId);
      const excluded = exclusions.list(selectedUserId);
      const result = summarize(activeSessionSegments(allSessions, excluded), url.searchParams.get('from'), url.searchParams.get('to'), settings.get().hourlyRateEuro);
      result.excludedBreakdown = closedBreakdown(allSessions, excluded, url.searchParams.get('from'), url.searchParams.get('to'));
      return json(response, 200, result);
    }
    catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/global-summary') {
    try {
      if (!hasPermission(user, 'view_global_summary')) return json(response, 403, { error: 'Keine Berechtigung für die globale Statistik' });
      const allSegments = users.list().filter((entry) => entry.approved).flatMap((member) =>
        activeSessionSegments(sessions.list(member.id), exclusions.list(member.id)));
      const result = summarize(allSegments, url.searchParams.get('from'), url.searchParams.get('to'), settings.get().hourlyRateEuro);
      result.breakdown = [];
      result.daily = result.daily.map((day) => ({ ...day, activities: [] }));
      return json(response, 200, { ...result, anonymous: true });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/exclusions') {
    try {
      if (!hasPermission(user, 'manage_exclusions')) return json(response, 403, { error: 'Keine Berechtigung für Ausschlüsse' });
      const body = await readJson(request);
      const selectedUserId = hasPermission(user, 'view_all_summaries') && body.userId ? String(body.userId) : user.id;
      const projectName = String(body.projectName || '').trim();
      const branchName = String(body.branchName || '').trim();
      if (!projectName || !branchName) return json(response, 400, { error: 'Projekt und Branch sind erforderlich' });
      const entry = exclusions.exclude({
        userId: selectedUserId, projectName, branchName,
        excludedById: user.id, excludedByName: user.username, excludedAt: new Date().toISOString(),
      });
      return json(response, 200, { exclusion: entry });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/team-summary') {
    try {
      if (!hasPermission(user, 'view_team_summary')) return json(response, 403, { error: 'Keine Berechtigung für die Teamübersicht' });
      const rangeStart = new Date(url.searchParams.get('from'));
      const rangeEnd = new Date(url.searchParams.get('to'));
      const weekMillis = 7 * 86_400_000;
      if (Number.isNaN(rangeStart.getTime()) || Number.isNaN(rangeEnd.getTime()) || rangeEnd <= rangeStart) throw new Error('Ungültiger Zeitraum');
      if (rangeEnd - rangeStart > 12 * weekMillis) throw new Error('Maximal 12 Kalenderwochen');
      const members = users.list().filter((entry) => entry.approved && entry.active !== false);
      const weeks = [];
      for (let start = rangeStart.getTime(); start < rangeEnd.getTime(); start += weekMillis) {
        const end = Math.min(start + weekMillis, rangeEnd.getTime());
        const totals = members.map((member) => {
          const excluded = exclusions.list(member.id);
          const includedSessions = activeSessionSegments(sessions.list(member.id), excluded);
          return summarize(includedSessions, new Date(start).toISOString(), new Date(end).toISOString(), settings.get().hourlyRateEuro).totalMillis;
        });
        const averageMillis = totals.length ? Math.round(totals.reduce((sum, value) => sum + value, 0) / totals.length) : null;
        weeks.push({
          from: new Date(start).toISOString(), to: new Date(end).toISOString(), averageMillis,
          values: Object.fromEntries(members.map((member, index) => [member.id, totals[index]])),
        });
      }
      return json(response, 200, { members: members.map(publicUser), weeks });
    } catch (error) { return json(response, 400, { error: error.message }); }
  }
  return json(response, 404, { error: 'Nicht gefunden' });
}

async function handleAdmin(request, response, url, admin) {
  if (request.method === 'GET' && url.pathname === '/api/admin/allowances') {
    if (!hasPermission(admin, 'view_allowances')) return json(response, 403, { error: 'Keine Berechtigung für Zulagen' });
    const now = new Date();
    const members = users.list().filter((entry) => entry.approved && entry.active !== false);
    const activeIds = new Set(members.map((member) => member.id));
    const open = members.map((member) => allowanceFor(member, now));
    return json(response, 200, { hourlyRateEuro: settings.get().hourlyRateEuro, open, history: payouts.list().filter((entry) => activeIds.has(entry.userId)).map((entry) => ({ ...entry, username: users.list().find((user) => user.id === entry.userId)?.username || 'Unbekannt' })) });
  }
  if (request.method === 'PUT' && url.pathname === '/api/admin/allowances/settings') {
    if (!hasPermission(admin, 'manage_payouts')) return json(response, 403, { error: 'Keine Berechtigung zur Zulagenverwaltung' });
    const body = await readJson(request); const hourlyRateEuro = Number(body.hourlyRateEuro);
    if (!Number.isFinite(hourlyRateEuro) || hourlyRateEuro < 0 || hourlyRateEuro > 100_000) return json(response, 400, { error: 'Stundensatz muss zwischen 0 und 100.000 Euro liegen' });
    return json(response, 200, { settings: settings.update({ hourlyRateEuro: Math.round(hourlyRateEuro * 100) / 100 }) });
  }
  const payoutMatch = url.pathname.match(/^\/api\/admin\/allowances\/([^/]+)\/pay$/);
  if (request.method === 'POST' && payoutMatch) {
    if (!hasPermission(admin, 'manage_payouts')) return json(response, 403, { error: 'Keine Berechtigung für Auszahlungen' });
    const member = users.list().find((entry) => entry.id === decodeURIComponent(payoutMatch[1]) && entry.approved);
    if (!member) return json(response, 404, { error: 'Benutzer nicht gefunden' });
    const allowance = allowanceFor(member, new Date());
    const payout = payouts.add({
      id: crypto.randomUUID(), userId: member.id, from: allowance.from, to: allowance.to,
      durationMillis: allowance.durationMillis, amountEuro: allowance.amountEuro,
      paidById: admin.id, paidByName: admin.username, paidAt: new Date().toISOString(),
    });
    return json(response, 200, { payout });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!hasPermission(admin, 'manage_users') && !hasPermission(admin, 'view_all_summaries')) return json(response, 403, { error: 'Keine Berechtigung für Benutzer' });
    return json(response, 200, { users: users.list().map(publicUser) });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/roles') {
    if (!hasPermission(admin, 'manage_roles') && !hasPermission(admin, 'manage_users')) return json(response, 403, { error: 'Keine Berechtigung für Rollen' });
    return json(response, 200, { roles: roles.list(), permissions: PERMISSIONS.map(([id, name]) => ({ id, name })) });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/roles') {
    if (!hasPermission(admin, 'manage_roles')) return json(response, 403, { error: 'Keine Berechtigung zur Rollenverwaltung' });
    const body = await readJson(request);
    const id = String(body.id || body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!id || !name) return json(response, 400, { error: 'Rollenname ist erforderlich' });
    const allowed = new Set(PERMISSIONS.map(([permission]) => permission));
    const permissions = [...new Set(Array.isArray(body.permissions) ? body.permissions.filter((permission) => allowed.has(permission)) : [])];
    const existing = roles.find(id);
    if (existing?.system) return json(response, 400, { error: 'Systemrollen können nicht überschrieben werden' });
    return json(response, 200, { role: roles.save({ id, name, system: false, permissions }) });
  }
  const roleMatch = url.pathname.match(/^\/api\/admin\/roles\/([^/]+)$/);
  if (request.method === 'PUT' && roleMatch) {
    if (!hasPermission(admin, 'manage_roles')) return json(response, 403, { error: 'Keine Berechtigung zur Rollenverwaltung' });
    const id = decodeURIComponent(roleMatch[1]); const existing = roles.find(id);
    if (!existing) return json(response, 404, { error: 'Rolle nicht gefunden' });
    const body = await readJson(request); const allowed = new Set(PERMISSIONS.map(([permission]) => permission));
    const permissions = [...new Set(Array.isArray(body.permissions) ? body.permissions.filter((permission) => allowed.has(permission)) : [])];
    const name = existing.system ? existing.name : (String(body.name || existing.name).trim().slice(0, 80) || existing.name);
    return json(response, 200, { role: roles.save({ ...existing, name, permissions }) });
  }
  if (request.method === 'DELETE' && roleMatch) {
    if (!hasPermission(admin, 'manage_roles')) return json(response, 403, { error: 'Keine Berechtigung zur Rollenverwaltung' });
    const id = decodeURIComponent(roleMatch[1]);
    if (id === 'admin' || id === 'user') return json(response, 400, { error: 'Die Rollen admin und user können nicht gelöscht werden' });
    if (!roles.remove(id)) return json(response, 404, { error: 'Rolle nicht gefunden' });
    users.replaceRole(id, 'user');
    return json(response, 200, { deleted: id, fallbackRole: 'user' });
  }
  const assignMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (request.method === 'POST' && assignMatch) {
    if (!hasPermission(admin, 'manage_users')) return json(response, 403, { error: 'Keine Berechtigung zur Benutzerverwaltung' });
    const body = await readJson(request); const role = roles.find(String(body.role || ''));
    if (!role) return json(response, 404, { error: 'Rolle nicht gefunden' });
    const target = users.list().find((entry) => entry.id === decodeURIComponent(assignMatch[1]));
    if (!target) return json(response, 404, { error: 'Benutzer nicht gefunden' });
    return json(response, 200, { user: publicUser(users.update(target.id, { role: role.id })) });
  }
  const deleteUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (request.method === 'DELETE' && deleteUserMatch) {
    if (!hasPermission(admin, 'manage_users')) return json(response, 403, { error: 'Keine Berechtigung zur Benutzerverwaltung' });
    const userId = decodeURIComponent(deleteUserMatch[1]); const target = users.list().find((entry) => entry.id === userId);
    if (!target) return json(response, 404, { error: 'Benutzer nicht gefunden' });
    if (target.approved && target.active !== false) return json(response, 400, { error: 'Nur deaktivierte oder nicht bestätigte Benutzer können gelöscht werden' });
    sessions.removeUser(userId); exclusions.removeUser(userId); payouts.removeUser(userId); users.remove(userId);
    for (const [sessionId, entry] of webSessions) if (entry.userId === userId) webSessions.delete(sessionId);
    persistWebSessions();
    return json(response, 200, { deleted: userId });
  }
  const match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(approve|promote|deactivate|activate)$/);
  if (request.method === 'POST' && match) {
    if (!hasPermission(admin, 'manage_users')) return json(response, 403, { error: 'Keine Berechtigung zur Benutzerverwaltung' });
    const userId = decodeURIComponent(match[1]);
    const action = match[2];
    const target = users.list().find((entry) => entry.id === userId);
    if (!target) return json(response, 404, { error: 'Benutzer nicht gefunden' });
    if (action === 'approve') return json(response, 200, { user: publicUser(users.update(userId, { approved: true, approvedAt: new Date().toISOString(), approvedBy: admin.id })) });
    if (action === 'deactivate') return json(response, 200, { user: publicUser(users.update(userId, { active: false, deactivatedAt: new Date().toISOString(), deactivatedBy: admin.id })) });
    if (action === 'activate') return json(response, 200, { user: publicUser(users.update(userId, { active: true, activatedAt: new Date().toISOString(), activatedBy: admin.id })) });
    return json(response, 200, { user: publicUser(users.update(userId, { role: 'admin', approved: true, promotedAt: new Date().toISOString(), promotedBy: admin.id })) });
  }
  return json(response, 404, { error: 'Nicht gefunden' });
}

function allowanceFor(member, now) {
  const history = payouts.list(member.id);
  const memberSessions = sessions.list(member.id);
  const earliest = memberSessions.length ? memberSessions.reduce((value, session) => session.startedAt < value ? session.startedAt : value, memberSessions[0].startedAt) : new Date(now.getTime() - 1).toISOString();
  const from = history.length ? history[0].to : earliest;
  const to = now.toISOString();
  const result = summarize(activeSessionSegments(memberSessions, exclusions.list(member.id)), from, to, settings.get().hourlyRateEuro);
  return { userId: member.id, username: member.username, from, to, durationMillis: result.totalMillis, amountEuro: result.totalValueEuro };
}

function activeSessionSegments(allSessions, excluded) {
  return allSessions.map((session) => {
    const cutoffs = excluded.filter((entry) => entry.projectName === session.projectName && entry.branchName === session.branchName)
      .map((entry) => Date.parse(entry.excludedAt)).filter(Number.isFinite);
    const latest = cutoffs.length ? Math.max(...cutoffs) : -Infinity;
    return clipSession(session, Math.max(Date.parse(session.startedAt), latest), Date.parse(session.endedAt));
  }).filter(Boolean);
}

function closedBreakdown(allSessions, excluded, from, to) {
  const grouped = new Map();
  for (const exclusion of excluded.slice().sort((a, b) => a.excludedAt.localeCompare(b.excludedAt))) {
    const key = `${exclusion.projectName}\u0000${exclusion.branchName}`;
    const previous = grouped.get(key) || -Infinity;
    const cutoff = Date.parse(exclusion.excludedAt);
    const segments = allSessions.filter((session) => session.projectName === exclusion.projectName && session.branchName === exclusion.branchName)
      .map((session) => clipSession(session, Math.max(Date.parse(session.startedAt), previous), Math.min(Date.parse(session.endedAt), cutoff))).filter(Boolean);
    const summary = summarize(segments, from, to, settings.get().hourlyRateEuro);
    for (const row of summary.breakdown) row.exclusion = exclusion;
    if (summary.breakdown.length) {
      const existing = grouped.get(`${key}\u0000rows`) || [];
      grouped.set(`${key}\u0000rows`, [...existing, ...summary.breakdown]);
    }
    grouped.set(key, cutoff);
  }
  return [...grouped.entries()].filter(([key]) => key.endsWith('\u0000rows')).flatMap(([, rows]) => rows);
}

function clipSession(session, start, end) {
  const originalStart = Date.parse(session.startedAt), originalEnd = Date.parse(session.endedAt);
  const clippedStart = Math.max(originalStart, start), clippedEnd = Math.min(originalEnd, end);
  if (clippedEnd <= clippedStart) return null;
  const share = (clippedEnd - clippedStart) / (originalEnd - originalStart);
  return {
    ...session, id: `${session.id}:${clippedStart}:${clippedEnd}`,
    startedAt: new Date(clippedStart).toISOString(), endedAt: new Date(clippedEnd).toISOString(),
    durationMillis: Math.round((session.durationMillis ?? originalEnd - originalStart) * share),
    charactersWritten: Math.round((session.charactersWritten || 0) * share),
    nonEmptyLinesWritten: Math.round((session.nonEmptyLinesWritten || 0) * share),
  };
}

function authenticate(request) {
  const webUser = authenticateWeb(request);
  if (webUser) return webUser;
  const supplied = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const apiUser = supplied ? users.findByApiKeyHash(hashApiKey(supplied)) : null;
  return apiUser?.approved && apiUser.active !== false ? apiUser : null;
}
function authenticateWeb(request) {
  const sessionId = cookie(request, 'tt_session'); const entry = webSessions.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { webSessions.delete(sessionId); persistWebSessions(); return null; }
  return users.list().find((user) => user.id === entry.userId && user.active !== false) || null;
}
function createLogin(response, user, rememberMe = false) {
  const sessionId = crypto.randomBytes(32).toString('base64url');
  webSessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + (rememberMe ? 30 : 0.5) * 86400000 });
  persistWebSessions();
  setSessionCookie(response, sessionId, rememberMe ? 30 * 86400 : null);
}
function setSessionCookie(response, value, maxAge) {
  const secure = process.env.TIME_TRACKER_SECURE_COOKIES === 'true' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `tt_session=${value}; Path=/; HttpOnly; SameSite=Strict${secure}${maxAge === null ? '' : `; Max-Age=${maxAge}`}`);
}
function cookie(request, name) {
  const match = String(request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : '';
}
function persistWebSessions() {
  if (mysqlBackend) mysqlBackend.set('web_sessions', { version: 1, sessions: [...webSessions.entries()] });
}
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function hashApiKey(apiKey) { return crypto.createHash('sha256').update(apiKey).digest('hex'); }
function createApiKey() { return `tt_${crypto.randomBytes(32).toString('base64url')}`; }
function safeEqual(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function validateUsername(value) {
  const username = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw new Error('Benutzername: 3–40 Zeichen, nur Buchstaben, Zahlen, Punkt, Minus und Unterstrich');
  return username;
}
function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10 || password.length > 200) throw new Error('Passwort muss mindestens 10 Zeichen lang sein');
  return password;
}
function hasPermission(user, permission) { return Boolean(roles.find(user?.role)?.permissions.includes(permission)); }
function publicUser(user) { return { id: user.id, username: user.username, createdAt: user.createdAt, role: user.role, permissions: roles.find(user.role)?.permissions || [], approved: user.approved, active: user.active !== false }; }

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1_000_000) throw new Error('Anfrage ist zu groß'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(publicDirectory, relative);
  if (!file.startsWith(publicDirectory + path.sep) && file !== path.join(publicDirectory, 'index.html')) return json(response, 403, { error: 'Verboten' });
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(response, 404, { error: 'Nicht gefunden' });
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  fs.createReadStream(file).pipe(response);
}
function json(response, status, body) {
  if (!response.hasHeader('Content-Type')) response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('X-Frame-Options', 'DENY'); response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store'); response.statusCode = status;
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
async function bootstrap() {
  mysqlBackend = await createMySqlBackend();
  if (!mysqlBackend.get('users') && fs.existsSync(dataDirectory)) {
    const legacySessions = new SessionStore(dataDirectory);
    const legacyUsers = new UserStore(dataDirectory);
    const legacyExclusions = new ExclusionStore(dataDirectory);
    const legacyPayouts = new PayoutStore(dataDirectory);
    const legacyRoles = new RoleStore(dataDirectory);
    const legacySettings = new SettingsStore(dataDirectory);
    if (legacyUsers.list().length) {
      mysqlBackend.set('sessions', { version: 1, sessions: legacySessions.all() });
      mysqlBackend.set('users', { version: 1, users: legacyUsers.list() });
      mysqlBackend.set('exclusions', { version: 1, exclusions: legacyExclusions.all() });
      mysqlBackend.set('payouts', { version: 1, payouts: legacyPayouts.list() });
      mysqlBackend.set('roles', { version: 2, roles: legacyRoles.list() });
      mysqlBackend.set('settings', { version: 1, ...legacySettings.get() });
      await mysqlBackend.flush();
      process.stdout.write('Bestehende JSON-Daten wurden einmalig nach MySQL migriert\n');
    }
  }
  configureBackend(mysqlBackend);
  const storedWebSessions = mysqlBackend.get('web_sessions')?.sessions;
  if (Array.isArray(storedWebSessions)) {
    for (const [sessionId, entry] of storedWebSessions) if (entry?.expiresAt > Date.now()) webSessions.set(sessionId, entry);
  }
  sessions = new SessionStore(dataDirectory);
  users = new UserStore(dataDirectory);
  exclusions = new ExclusionStore(dataDirectory);
  payouts = new PayoutStore(dataDirectory);
  roles = new RoleStore(dataDirectory);
  settings = new SettingsStore(dataDirectory);
  server.listen(port, host, () => process.stdout.write(`Time Tracker läuft auf http://${host}:${port}\nDatenbank: MySQL\n`));
}

async function shutdown(signal) {
  process.stdout.write(`${signal}: Server wird beendet\n`);
  server.close(async () => {
    try { await mysqlBackend?.close(); process.exit(0); }
    catch (error) { process.stderr.write(`MySQL konnte nicht sauber geschlossen werden: ${error.message}\n`); process.exit(1); }
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
bootstrap().catch((error) => { process.stderr.write(`Serverstart fehlgeschlagen: ${error.message}\n`); process.exit(1); });
