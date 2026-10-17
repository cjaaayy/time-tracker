const fs = require('node:fs');
const path = require('node:path');
let persistentBackend = null;
function configureBackend(backend) { persistentBackend = backend; }

class SessionStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.file = path.join(dataDirectory, 'sessions.json');
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.sessions = this.#read();
  }

  list(userId) {
    return this.sessions.filter((session) => session.userId === userId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  all() { return [...this.sessions]; }

  upsert(incoming) {
    const key = (session) => `${session.userId}\u0000${session.id}`;
    const byId = new Map(this.sessions.map((session) => [key(session), session]));
    for (const session of incoming) byId.set(key(session), session);
    this.sessions = [...byId.values()];
    this.#write();
    return incoming.length;
  }

  remove(id, userId) {
    const remaining = this.sessions.filter((session) => session.id !== id || session.userId !== userId);
    if (remaining.length === this.sessions.length) return false;
    this.sessions = remaining;
    this.#write();
    return true;
  }

  removeUser(userId) {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((session) => session.userId !== userId);
    if (this.sessions.length !== before) this.#write();
    return before - this.sessions.length;
  }

  #read() {
    if (persistentBackend) return Array.isArray(persistentBackend.get('sessions')?.sessions) ? persistentBackend.get('sessions').sessions : [];
    if (!fs.existsSync(this.file)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('sessions', { version: 1, sessions: this.sessions }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    const payload = JSON.stringify({ version: 1, sessions: this.sessions }, null, 2);
    fs.writeFileSync(temporaryFile, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

class UserStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'users.json');
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.users = this.#read();
  }

  list() { return [...this.users]; }
  findByUsername(username) { return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase()); }
  findByApiKeyHash(hash) { return this.users.find((user) => user.apiKeyHash === hash); }

  create(user) {
    if (this.findByUsername(user.username)) throw new Error('Benutzername ist bereits vergeben');
    this.users.push(user);
    this.#write();
    return user;
  }

  updateApiKey(userId, apiKeyHash) {
    const user = this.users.find((entry) => entry.id === userId);
    if (!user) throw new Error('Benutzer nicht gefunden');
    user.apiKeyHash = apiKeyHash;
    this.#write();
  }

  update(userId, changes) {
    const user = this.users.find((entry) => entry.id === userId);
    if (!user) throw new Error('Benutzer nicht gefunden');
    Object.assign(user, changes);
    this.#write();
    return user;
  }

  replaceRole(roleId, fallbackRole = 'user') {
    let changed = false;
    for (const user of this.users) {
      if (user.role === roleId) { user.role = fallbackRole; changed = true; }
    }
    if (changed) this.#write();
    return changed;
  }

  remove(userId) {
    const before = this.users.length;
    this.users = this.users.filter((user) => user.id !== userId);
    if (this.users.length !== before) this.#write();
    return before !== this.users.length;
  }

  #read() {
    if (persistentBackend) return normalizeUsers(persistentBackend.get('users')?.users);
    if (!fs.existsSync(this.file)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return normalizeUsers(parsed.users);
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('users', { version: 1, users: this.users }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, users: this.users }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

class ExclusionStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'exclusions.json');
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.exclusions = this.#read();
  }

  list(userId) { return this.exclusions.filter((entry) => entry.userId === userId); }
  all() { return [...this.exclusions]; }

  exclude(entry) {
    const duplicate = this.exclusions.find((value) =>
      value.userId === entry.userId && value.projectName === entry.projectName && value.branchName === entry.branchName &&
      Math.abs(Date.parse(value.excludedAt) - Date.parse(entry.excludedAt)) < 2_000);
    if (duplicate) return duplicate;
    const stored = { id: entry.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...entry };
    this.exclusions.push(stored);
    this.#write();
    return stored;
  }

  removeUser(userId) {
    this.exclusions = this.exclusions.filter((entry) => entry.userId !== userId);
    this.#write();
  }

  #read() {
    if (persistentBackend) return Array.isArray(persistentBackend.get('exclusions')?.exclusions) ? persistentBackend.get('exclusions').exclusions : [];
    if (!fs.existsSync(this.file)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return Array.isArray(parsed.exclusions) ? parsed.exclusions : [];
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('exclusions', { version: 1, exclusions: this.exclusions }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, exclusions: this.exclusions }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

class PayoutStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'payouts.json');
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.payouts = this.#read();
  }

  list(userId) {
    return this.payouts.filter((entry) => !userId || entry.userId === userId)
      .sort((a, b) => b.to.localeCompare(a.to));
  }

  add(entry) {
    this.payouts.push(entry);
    this.#write();
    return entry;
  }

  removeUser(userId) {
    this.payouts = this.payouts.filter((entry) => entry.userId !== userId);
    this.#write();
  }

  #read() {
    if (persistentBackend) return Array.isArray(persistentBackend.get('payouts')?.payouts) ? persistentBackend.get('payouts').payouts : [];
    if (!fs.existsSync(this.file)) return [];
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return Array.isArray(parsed.payouts) ? parsed.payouts : [];
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('payouts', { version: 1, payouts: this.payouts }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, payouts: this.payouts }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

class RoleStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'roles.json');
    fs.mkdirSync(dataDirectory, { recursive: true });
    this.roles = this.#read();
  }

  list() { return this.roles.map((role) => ({ ...role, permissions: [...role.permissions] })); }
  find(id) { return this.roles.find((role) => role.id === id); }

  save(role) {
    const index = this.roles.findIndex((entry) => entry.id === role.id);
    if (index >= 0) this.roles[index] = role;
    else this.roles.push(role);
    this.#write();
    return role;
  }

  remove(id) {
    const role = this.find(id);
    if (!role || role.system) return false;
    this.roles = this.roles.filter((entry) => entry.id !== id);
    this.#write();
    return true;
  }

  #read() {
    const defaults = [
      { id: 'admin', name: 'Administrator', system: true, permissions: ['view_own_summary', 'view_team_summary', 'view_global_summary', 'view_all_summaries', 'view_sessions', 'manage_exclusions', 'view_allowances', 'manage_payouts', 'manage_users', 'manage_roles'] },
      { id: 'user', name: 'Benutzer', system: true, permissions: ['view_own_summary', 'view_team_summary', 'view_global_summary', 'manage_exclusions'] },
    ];
    if (!persistentBackend && !fs.existsSync(this.file)) return defaults;
    const parsed = persistentBackend ? (persistentBackend.get('roles') || {}) : JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(parsed.roles)) return defaults;
    if ((parsed.version || 1) < 2) {
      for (const role of parsed.roles) {
        if (role.id === 'admin' || role.id === 'user') role.permissions = [...new Set([...(role.permissions || []), 'view_global_summary'])];
      }
    }
    const byId = new Map(defaults.map((role) => [role.id, role]));
    parsed.roles.forEach((role) => byId.set(role.id, role));
    return [...byId.values()];
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('roles', { version: 2, roles: this.roles }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 2, roles: this.roles }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

class SettingsStore {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'settings.json');
    this.settings = this.#read();
  }

  get() { return { ...this.settings }; }
  update(changes) { Object.assign(this.settings, changes); this.#write(); return this.get(); }

  #read() {
    if (!persistentBackend && !fs.existsSync(this.file)) return { hourlyRateEuro: 750 };
    const parsed = persistentBackend ? (persistentBackend.get('settings') || {}) : JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { hourlyRateEuro: Number.isFinite(parsed.hourlyRateEuro) ? parsed.hourlyRateEuro : 750 };
  }

  #write() {
    if (persistentBackend) { persistentBackend.set('settings', { version: 1, ...this.settings }); return; }
    const temporaryFile = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, ...this.settings }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryFile, this.file);
  }
}

function normalizeUsers(values) {
  if (!Array.isArray(values)) return [];
  return values.map((user, index) => ({
    ...user,
    role: user.role || (index === 0 ? 'admin' : 'user'),
    approved: user.approved === undefined ? true : Boolean(user.approved),
    active: user.active === undefined ? true : Boolean(user.active),
  }));
}

module.exports = { SessionStore, UserStore, ExclusionStore, PayoutStore, RoleStore, SettingsStore, configureBackend };
