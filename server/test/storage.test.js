const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExclusionStore, PayoutStore, RoleStore, UserStore, SettingsStore, SessionStore } = require('../storage');

test('speichert Ausschlüsse mit Urheber dauerhaft und ohne Duplikate', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-storage-'));
  try {
    const entry = {
      userId: 'user-1', projectName: 'Plugin', branchName: 'main',
      excludedById: 'admin-1', excludedByName: 'Admin', excludedAt: new Date().toISOString(),
    };
    const store = new ExclusionStore(directory);
    store.exclude(entry);
    store.exclude(entry);

    const reloaded = new ExclusionStore(directory);
    assert.equal(reloaded.list('user-1').length, 1);
    assert.equal(reloaded.list('user-1')[0].excludedByName, 'Admin');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('speichert den Zulagenstundensatz und löscht Benutzerdaten kaskadiert', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-settings-'));
  try {
    const settings = new SettingsStore(directory);
    settings.update({ hourlyRateEuro: 123.45 });
    assert.equal(new SettingsStore(directory).get().hourlyRateEuro, 123.45);
    const sessions = new SessionStore(directory);
    sessions.upsert([{ id: 's1', userId: 'u1', startedAt: '2026-07-01T00:00:00.000Z' }]);
    assert.equal(sessions.removeUser('u1'), 1);
    assert.equal(new SessionStore(directory).list('u1').length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('speichert abgeschlossene Zulagenzeiträume dauerhaft', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-payout-'));
  try {
    const payout = {
      id: 'payout-1', userId: 'user-1', from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.000Z',
      durationMillis: 3_600_000, amountEuro: 750, paidByName: 'Admin',
    };
    new PayoutStore(directory).add(payout);
    const reloaded = new PayoutStore(directory).list('user-1');
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].amountEuro, 750);
    assert.equal(reloaded[0].paidByName, 'Admin');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('liefert Systemrollen und speichert eigene Rollen mit Berechtigungen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-role-'));
  try {
    const store = new RoleStore(directory);
    assert.ok(store.find('admin').permissions.includes('manage_roles'));
    assert.ok(store.find('user').permissions.includes('view_own_summary'));
    store.save({ id: 'teamleitung', name: 'Teamleitung', system: false, permissions: ['view_team_summary', 'view_all_summaries'] });
    const reloaded = new RoleStore(directory).find('teamleitung');
    assert.deepEqual(reloaded.permissions, ['view_team_summary', 'view_all_summaries']);
    const users = new UserStore(directory);
    users.create({ id: 'u1', username: 'mitglied', role: 'teamleitung', approved: true, active: true });
    assert.equal(new RoleStore(directory).remove('teamleitung'), true);
    users.replaceRole('teamleitung', 'user');
    assert.equal(new UserStore(directory).list()[0].role, 'user');
    users.update('u1', { active: false });
    assert.equal(new UserStore(directory).list()[0].active, false);
    assert.equal(new RoleStore(directory).remove('admin'), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
