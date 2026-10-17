const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSession, summarize } = require('../domain');

test('normalisiert eine Session und berechnet 750 Euro pro Stunde', () => {
  const session = normalizeSession({
    id: 'one', projectName: 'Plugin', projectPath: '/work/plugin', branchName: 'main',
    startedAt: '2026-07-20T08:00:00.000Z', endedAt: '2026-07-20T09:00:00.000Z', charactersWritten: 1200, nonEmptyLinesWritten: 30,
  });
  const result = summarize([session], '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z');
  assert.equal(result.totalMillis, 3_600_000);
  assert.equal(result.totalValueEuro, 750);
  assert.equal(result.breakdown[0].branchName, 'main');
  assert.equal(result.totalCharactersWritten, 1200);
  assert.equal(result.totalNonEmptyLinesWritten, 30);
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].activities[0].projectName, 'Plugin');
});

test('schneidet Sessions an der Kalenderwochengrenze ab', () => {
  const session = normalizeSession({
    projectName: 'Plugin', branchName: 'feature',
    startedAt: '2026-07-19T23:30:00.000Z', endedAt: '2026-07-20T00:30:00.000Z',
  });
  const result = summarize([session], '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z');
  assert.equal(result.totalMillis, 1_800_000);
  assert.equal(result.totalValueEuro, 375);
});

test('weist ungültige Zeiträume zurück', () => {
  assert.throws(() => normalizeSession({
    projectName: 'Plugin', branchName: 'main',
    startedAt: '2026-07-20T09:00:00.000Z', endedAt: '2026-07-20T08:00:00.000Z',
  }));
});

test('zieht pausierte Zeit von der Sessiondauer ab', () => {
  const session = normalizeSession({ projectName: 'Plugin', branchName: 'main', startedAt: '2026-07-20T08:00:00.000Z', endedAt: '2026-07-20T09:00:00.000Z', durationMillis: 1_800_000 });
  const result = summarize([session], '2026-07-20T00:00:00.000Z', '2026-07-27T00:00:00.000Z');
  assert.equal(result.totalMillis, 1_800_000);
  assert.equal(result.totalValueEuro, 375);
});

test('berechnet Zulagen mit konfigurierbarem Stundensatz', () => {
  const session = normalizeSession({ projectName: 'Plugin', branchName: 'main', startedAt: '2026-07-20T08:00:00.000Z', endedAt: '2026-07-20T09:00:00.000Z' });
  const result = summarize([session], '2026-07-20T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 42.5);
  assert.equal(result.hourlyRateEuro, 42.5);
  assert.equal(result.totalValueEuro, 42.5);
});
