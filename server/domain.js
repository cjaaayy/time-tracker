const crypto = require('node:crypto');

const HOURLY_RATE = 750;
const MAX_SESSION_MILLIS = 31 * 24 * 60 * 60 * 1000;

function normalizeSession(value) {
  if (!value || typeof value !== 'object') throw new Error('Session fehlt');
  const startedAt = parseDate(value.startedAt, 'startedAt');
  const endedAt = parseDate(value.endedAt, 'endedAt');
  const duration = endedAt.getTime() - startedAt.getTime();
  if (duration <= 0) throw new Error('endedAt muss nach startedAt liegen');
  if (duration > MAX_SESSION_MILLIS) throw new Error('Eine Session darf höchstens 24 Stunden dauern');

  const activeDuration = value.durationMillis === undefined ? duration : nonNegativeInteger(value.durationMillis);
  if (activeDuration > duration) throw new Error('durationMillis darf die Sessiondauer nicht überschreiten');

  return {
    id: cleanText(value.id, 100) || crypto.randomUUID(),
    projectName: requiredText(value.projectName, 'projectName', 200),
    projectPath: cleanText(value.projectPath, 1000),
    branchName: requiredText(value.branchName, 'branchName', 500),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    charactersWritten: nonNegativeInteger(value.charactersWritten),
    nonEmptyLinesWritten: nonNegativeInteger(value.nonEmptyLinesWritten),
    durationMillis: activeDuration,
  };
}

function summarize(sessions, rangeStart, rangeEnd, hourlyRateEuro = HOURLY_RATE) {
  const start = parseDate(rangeStart, 'from').getTime();
  const end = parseDate(rangeEnd, 'to').getTime();
  if (end <= start) throw new Error('to muss nach from liegen');

  const groups = new Map();
  const daily = new Map();
  let totalMillis = 0;
  let totalCharactersWritten = 0;
  let totalNonEmptyLinesWritten = 0;
  for (const session of sessions) {
    const clippedStart = Math.max(Date.parse(session.startedAt), start);
    const clippedEnd = Math.min(Date.parse(session.endedAt), end);
    const wallDuration = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    const wallOverlap = Math.max(0, clippedEnd - clippedStart);
    const millis = Math.round((session.durationMillis ?? wallDuration) * (wallOverlap / wallDuration));
    if (!wallOverlap) continue;
    totalMillis += millis;
    const share = wallOverlap / wallDuration;
    totalCharactersWritten += Math.round((session.charactersWritten || 0) * share);
    totalNonEmptyLinesWritten += Math.round((session.nonEmptyLinesWritten || 0) * share);
    const key = `${session.projectName}\u0000${session.branchName}`;
    const current = groups.get(key) || {
      projectName: session.projectName,
      branchName: session.branchName,
      durationMillis: 0,
      valueEuro: 0,
      charactersWritten: 0,
      nonEmptyLinesWritten: 0,
    };
    current.durationMillis += millis;
    current.valueEuro = money(current.durationMillis, hourlyRateEuro);
    current.charactersWritten += Math.round((session.charactersWritten || 0) * share);
    current.nonEmptyLinesWritten += Math.round((session.nonEmptyLinesWritten || 0) * share);
    groups.set(key, current);

    for (let dayStart = start; dayStart < end; dayStart += 86_400_000) {
      const dayEnd = Math.min(dayStart + 86_400_000, end);
      const dayOverlap = Math.max(0, Math.min(Date.parse(session.endedAt), dayEnd) - Math.max(Date.parse(session.startedAt), dayStart));
      if (!dayOverlap) continue;
      const dayShare = dayOverlap / wallDuration;
      const date = new Date(dayStart).toISOString();
      const bucket = daily.get(date) || { date, durationMillis: 0, charactersWritten: 0, nonEmptyLinesWritten: 0, activities: new Map() };
      bucket.durationMillis += Math.round((session.durationMillis ?? wallDuration) * dayShare);
      bucket.charactersWritten += Math.round((session.charactersWritten || 0) * dayShare);
      bucket.nonEmptyLinesWritten += Math.round((session.nonEmptyLinesWritten || 0) * dayShare);
      const activityKey = `${session.projectName}\u0000${session.branchName}`;
      const activity = bucket.activities.get(activityKey) || { projectName: session.projectName, branchName: session.branchName, durationMillis: 0 };
      activity.durationMillis += Math.round((session.durationMillis ?? wallDuration) * dayShare);
      bucket.activities.set(activityKey, activity);
      daily.set(date, bucket);
    }
  }

  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    hourlyRateEuro,
    totalMillis,
    totalValueEuro: money(totalMillis, hourlyRateEuro),
    totalCharactersWritten,
    totalNonEmptyLinesWritten,
    breakdown: [...groups.values()].sort((a, b) =>
      a.projectName.localeCompare(b.projectName) || a.branchName.localeCompare(b.branchName)),
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
      ...day,
      activities: [...day.activities.values()].sort((a, b) => b.durationMillis - a.durationMillis),
    })),
  };
}

function money(milliseconds, hourlyRateEuro = HOURLY_RATE) {
  return Math.round((milliseconds / 3_600_000) * hourlyRateEuro * 100) / 100;
}

function parseDate(value, name) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error(`${name} ist kein gültiger Zeitpunkt`);
  return date;
}

function requiredText(value, name, maxLength) {
  const result = cleanText(value, maxLength);
  if (!result) throw new Error(`${name} darf nicht leer sein`);
  return result;
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) throw new Error('Metriken müssen nichtnegative Zahlen sein');
  return Math.floor(number);
}

module.exports = { HOURLY_RATE, normalizeSession, summarize };
