const $ = (selector) => document.querySelector(selector);
let authMode = 'login', weekOffset = 0, monthOffset = 0, viewMode = 'week', currentUser = null, adminUsers = [], availableRoles = [], currentPage = 'overview', pendingExclusion = null, pendingPayout = null, pendingRoleDelete = null, pendingUserDelete = null;

$('#login-tab').addEventListener('click', () => setAuthMode('login'));
$('#register-tab').addEventListener('click', () => setAuthMode('register'));
$('#auth-form').addEventListener('submit', authenticate);
$('#logout').addEventListener('click', logout);
$('#api-key-button').addEventListener('click', () => $('#api-dialog').showModal());
$('#generate-key').addEventListener('click', generateApiKey);
$('#copy-key').addEventListener('click', () => navigator.clipboard.writeText($('#api-key').textContent));
$('#confirm-exclusion').addEventListener('click', confirmExclusion);
$('#confirm-payout').addEventListener('click', confirmPayout);
$('#confirm-role-delete').addEventListener('click', confirmRoleDelete);
$('#confirm-user-delete').addEventListener('click', confirmUserDelete);
$('#role-form').addEventListener('submit', saveRole);
$('#rate-form').addEventListener('submit', saveHourlyRate);
$('#previous').addEventListener('click', () => { if (viewMode === 'week' || currentPage === 'sessions' || currentPage === 'team') weekOffset--; else monthOffset--; loadPage(); });
$('#next').addEventListener('click', () => { if (viewMode === 'week' || currentPage === 'sessions' || currentPage === 'team') weekOffset++; else monthOffset++; loadPage(); });
$('#today').addEventListener('click', () => { weekOffset = 0; monthOffset = 0; loadPage(); });
$('#refresh').addEventListener('click', loadPage);
$('#user-filter').addEventListener('change', loadPage);
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setViewMode(button.dataset.mode)));

function setAuthMode(mode) {
  authMode = mode; $('#login-tab').classList.toggle('active', mode === 'login'); $('#register-tab').classList.toggle('active', mode === 'register');
  $('#auth-title').textContent = mode === 'login' ? 'Willkommen zurück' : 'Konto erstellen';
  $('#auth-submit').textContent = mode === 'login' ? 'Anmelden' : 'Registrieren'; $('#auth-message').textContent = '';
  $('#remember-label').hidden = mode !== 'login';
}
async function authenticate(event) {
  event.preventDefault(); $('#auth-message').textContent = '';
  const response = await fetch(`/api/auth/${authMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value, rememberMe: authMode === 'login' && $('#remember-me').checked }) });
  const body = await response.json(); if (!response.ok) { $('#auth-message').textContent = body.error; return; }
  await showDashboard(body.user); if (body.apiKey) { $('#api-key').textContent = body.apiKey; $('#api-dialog').showModal(); }
}
async function restoreLogin() { const response = await fetch('/api/auth/me'); if (response.ok) await showDashboard((await response.json()).user); }
async function showDashboard(user) {
  currentUser = user; $('#auth-view').hidden = true; $('#dashboard').hidden = false; $('#account-name').textContent = `${user.username} · ${user.role}`;
  $('#admin-sidebar').hidden = !user.approved; document.querySelectorAll('[data-permission]').forEach((element) => { element.hidden = !can(element.dataset.permission); }); $('#user-filter-label').hidden = !can('view_all_summaries');
  $('#pending-view').hidden = user.approved; $('#approved-content').hidden = !user.approved; $('#api-key-button').hidden = !user.approved;
  if (!user.approved) return;
  if (can('manage_users') || can('view_all_summaries')) await loadAdminUsers();
  showPage('overview');
}
async function logout() { await fetch('/api/auth/logout', { method: 'POST' }); currentUser = null; $('#dashboard').hidden = true; $('#auth-view').hidden = false; $('#auth-form').reset(); }
async function generateApiKey() { const response = await fetch('/api/auth/api-key', { method: 'POST' }); const body = await response.json(); $('#api-key').textContent = response.ok ? body.apiKey : body.error; }

async function loadAdminUsers() {
  const response = await fetch('/api/admin/users'); if (!response.ok) return;
  adminUsers = (await response.json()).users;
  const approved = adminUsers.filter((user) => user.approved && user.active); const selected = $('#user-filter').value || currentUser.id;
  $('#user-filter').replaceChildren(...approved.map((user) => { const option = document.createElement('option'); option.value = user.id; option.textContent = user.username; option.selected = user.id === selected; return option; }));
  $('#user-filter-label').hidden = false;
}
function showPage(page) {
  const button = document.querySelector(`.nav-item[data-page="${page}"]`);
  currentPage = button && !button.hidden ? page : (document.querySelector('.nav-item:not([hidden])')?.dataset.page || 'overview');
  document.querySelectorAll('.page-view').forEach((view) => { view.hidden = view.id !== `${currentPage}-view`; });
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === currentPage));
  const titles = { overview: ['Auswertung', 'Wochenübersicht'], team: ['Zusammenarbeit', 'Teamübersicht'], global: ['Anonymisiert', 'Globale Statistik'], allowances: ['Abrechnung', 'Zulagen'], sessions: ['Arbeitsdaten', 'Sessions'], users: ['Administration', 'Benutzerverwaltung'], roles: ['Administration', 'Rollen & Rechte'] };
  [$('#page-eyebrow').textContent, $('#page-title').textContent] = titles[currentPage];
  if (currentPage === 'overview' || currentPage === 'global') updateViewTitle();
  $('.toolbar').hidden = ['users', 'roles', 'allowances'].includes(currentPage); $('#view-switch').hidden = !['overview', 'global'].includes(currentPage); $('#user-filter-label').hidden = !['overview', 'sessions'].includes(currentPage) || !can('view_all_summaries'); loadPage();
}
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  $('#summary-content').hidden = mode === 'calendar'; $('#calendar-content').hidden = mode !== 'calendar';
  $('#global-summary-content').hidden = mode === 'calendar'; $('#global-calendar-content').hidden = mode !== 'calendar';
  updateViewTitle();
  loadPage();
}
function updateViewTitle() {
  const prefix = currentPage === 'global' ? 'Globale ' : '';
  $('#page-title').textContent = viewMode === 'week' ? `${prefix}Wochenübersicht` : viewMode === 'month' ? `${prefix}Monatsübersicht` : `${prefix}Kalenderansicht`;
}
async function loadPage() {
  if (!currentUser?.approved) return;
  if (currentPage === 'users') return loadUsers();
  if (currentPage === 'roles') return loadRoles();
  if (currentPage === 'allowances') return loadAllowances();
  if (currentPage === 'team') return loadTeam();
  const range = currentPage === 'sessions' || viewMode === 'week' ? weekRange(weekOffset) : monthRange(monthOffset); $('#week').textContent = range.label;
  const userQuery = can('view_all_summaries') ? `&userId=${encodeURIComponent($('#user-filter').value || currentUser.id)}` : '';
  try {
    if (currentPage === 'overview') {
      const response = await fetch(`/api/summary?from=${encodeURIComponent(range.start.toISOString())}&to=${encodeURIComponent(range.end.toISOString())}${userQuery}`);
      if (!response.ok) throw new Error('Auswertung konnte nicht geladen werden.');
      const summary = await response.json(); renderSummary(summary); if (viewMode === 'calendar') renderCalendar(summary.daily || [], range);
    } else if (currentPage === 'global') {
      const response = await fetch(`/api/global-summary?from=${encodeURIComponent(range.start.toISOString())}&to=${encodeURIComponent(range.end.toISOString())}`);
      if (!response.ok) throw new Error('Globale Statistik konnte nicht geladen werden.');
      const summary = await response.json(); renderGlobalSummary(summary); if (viewMode === 'calendar') renderCalendar(summary.daily || [], range, '#global-calendar-grid');
    } else if (can('view_sessions')) {
      const response = await fetch(`/api/sessions?userId=${encodeURIComponent($('#user-filter').value || currentUser.id)}`);
      if (!response.ok) throw new Error('Sessions konnten nicht geladen werden.'); renderSessions((await response.json()).sessions, range);
    }
    $('#message').textContent = '';
  } catch (error) { $('#message').textContent = error.message; }
}
async function loadAllowances() {
  try {
    const response = await fetch('/api/admin/allowances');
    if (!response.ok) throw new Error((await response.json()).error || 'Zulagen konnten nicht geladen werden.');
    const data = await response.json();
    $('#rate-form').hidden = !can('manage_payouts'); $('#hourly-rate').value = data.hourlyRateEuro;
    $('#open-allowances').replaceChildren(...(data.open.length ? data.open.map((entry) => allowanceRow(entry, false)) : [emptyRow('Keine Benutzer vorhanden.', 6)]));
    $('#allowance-history').replaceChildren(...(data.history.length ? data.history.map((entry) => allowanceRow(entry, true)) : [emptyRow('Noch keine Auszahlungen.', 6)]));
    $('#message').textContent = '';
  } catch (error) { $('#message').textContent = error.message; }
}
async function saveHourlyRate(event) {
  event.preventDefault();
  const response = await fetch('/api/admin/allowances/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hourlyRateEuro: Number($('#hourly-rate').value) }) });
  if (!response.ok) { $('#message').textContent = (await response.json()).error; return; }
  $('#message').textContent = 'Stundensatz gespeichert.'; await loadAllowances();
}
function allowanceRow(entry, paid) {
  const copyText = allowanceCopyText(entry);
  const row = tr([entry.username, `${shortDate(entry.from)} – ${shortDate(entry.to)}`, duration(entry.durationMillis), money(entry.amountEuro)]);
  const copyCell = document.createElement('td'); const copyButton = document.createElement('button'); copyButton.className = 'copy-value'; copyButton.textContent = copyText; copyButton.title = 'In Zwischenablage kopieren'; copyButton.addEventListener('click', () => navigator.clipboard.writeText(copyText)); copyCell.append(copyButton); row.append(copyCell);
  const action = document.createElement('td');
  if (paid) action.textContent = entry.paidByName;
  else if (can('manage_payouts')) { const button = document.createElement('button'); button.className = 'pay-button'; button.textContent = '✓'; button.title = 'Als ausgezahlt markieren'; button.addEventListener('click', () => requestPayout(entry)); action.append(button); }
  else action.textContent = '—';
  row.append(action); return row;
}
function requestPayout(entry) {
  pendingPayout = entry;
  $('#payout-description').textContent = `${entry.username}: ${money(entry.amountEuro)} für ${duration(entry.durationMillis)} (${shortDate(entry.from)} – ${shortDate(entry.to)})`;
  $('#payout-dialog').showModal();
}
async function confirmPayout() {
  if (!pendingPayout) return;
  const entry = pendingPayout; const button = $('#confirm-payout'); button.disabled = true; button.textContent = 'Wird gespeichert …';
  const response = await fetch(`/api/admin/allowances/${encodeURIComponent(entry.userId)}/pay`, { method: 'POST' });
  if (!response.ok) $('#message').textContent = (await response.json()).error || 'Auszahlung konnte nicht gespeichert werden.';
  else { $('#payout-dialog').close(); pendingPayout = null; await loadAllowances(); }
  button.disabled = false; button.textContent = 'Ja, als ausgezahlt markieren';
}
function allowanceCopyText(entry) { return `${entry.amountEuro.toFixed(2).replace('.', ',')} Entwicklerzuglagen (${shortDate(entry.from)} - ${shortDate(entry.to)}, ${duration(entry.durationMillis)})`; }
function shortDate(value) { return new Date(value).toLocaleDateString('de-DE'); }
async function loadTeam() {
  const current = weekRange(weekOffset);
  const start = new Date(current.start); start.setDate(start.getDate() - 7 * 7);
  const end = new Date(current.end);
  $('#week').textContent = `${weekLabel(start)} – ${weekLabel(current.start)}`;
  try {
    const response = await fetch(`/api/team-summary?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    if (!response.ok) {
      const fallbackMembers = can('view_all_summaries') && adminUsers.length ? adminUsers.filter((user) => user.approved) : [currentUser];
      renderTeam({ members: fallbackMembers, weeks: fallbackTeamWeeks(start) });
      $('#message').textContent = '';
      return;
    }
    renderTeam(await response.json());
    $('#message').textContent = '';
  } catch (error) { $('#message').textContent = error.message; }
}
async function loadUsers() {
  await Promise.all([loadAdminUsers(), loadRoleData()]); $('#pending-count').textContent = `${adminUsers.filter((user) => !user.approved).length} ausstehend`;
  $('#users').replaceChildren(...adminUsers.map((user) => {
    const row = tr([user.username, !user.active ? 'Deaktiviert' : user.approved ? 'Bestätigt' : 'Ausstehend']);
    const roleCell = document.createElement('td'); const select = document.createElement('select');
    select.replaceChildren(...availableRoles.map((role) => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.name; option.selected = role.id === user.role; return option; }));
    select.addEventListener('change', () => assignRole(user.id, select.value)); roleCell.append(select); row.append(roleCell);
    row.append(tr([new Date(user.createdAt).toLocaleDateString('de-DE')]).firstChild);
    const actions = document.createElement('td');
    if (!user.approved) actions.append(actionButton('Bestätigen', () => adminAction(user.id, 'approve')));
    if (user.active) actions.append(actionButton('Deaktivieren', () => adminAction(user.id, 'deactivate')));
    else actions.append(actionButton('Aktivieren', () => adminAction(user.id, 'activate')));
    if (!user.approved || !user.active) actions.append(actionButton('Endgültig löschen', () => requestUserDelete(user), 'danger'));
    row.append(actions); return row;
  }));
}
function requestUserDelete(user) {
  pendingUserDelete = user; $('#user-delete-description').textContent = `${user.username} (${user.approved ? 'deaktiviert' : 'nicht bestätigt'})`; $('#user-delete-dialog').showModal();
}
async function confirmUserDelete() {
  if (!pendingUserDelete) return;
  const response = await fetch(`/api/admin/users/${encodeURIComponent(pendingUserDelete.id)}`, { method: 'DELETE' });
  if (!response.ok) { $('#message').textContent = (await response.json()).error; $('#user-delete-dialog').close(); return; }
  $('#user-delete-dialog').close(); pendingUserDelete = null; $('#message').textContent = 'Benutzer und alle zugehörigen Daten wurden gelöscht.'; await loadUsers();
}
async function assignRole(userId, role) {
  const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  if (!response.ok) $('#message').textContent = (await response.json()).error; else await loadAdminUsers();
}
async function loadRoleData() {
  const response = await fetch('/api/admin/roles'); if (!response.ok) return null;
  const data = await response.json(); availableRoles = data.roles; return data;
}
async function loadRoles() {
  const data = await loadRoleData(); if (!data) { $('#message').textContent = 'Rollen konnten nicht geladen werden.'; return; }
  $('#permission-options').replaceChildren(...data.permissions.map((permission) => {
    const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'permission'; input.value = permission.id; label.append(input, document.createTextNode(permission.name)); return label;
  }));
  $('#role-list').replaceChildren(...data.roles.map((role) => {
    const card = document.createElement('article'); const title = document.createElement('strong'); title.textContent = role.name;
    const id = document.createElement('small'); id.textContent = role.system ? `${role.id} · Systemrolle` : role.id;
    const rights = document.createElement('div'); rights.className = 'permission-grid role-permissions';
    rights.append(...data.permissions.map((permission) => {
      const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = permission.id; input.checked = role.permissions.includes(permission.id); label.append(input, document.createTextNode(permission.name)); return label;
    }));
    const actions = document.createElement('div'); actions.className = 'role-actions';
    const save = document.createElement('button'); save.className = 'primary'; save.textContent = 'Rechte speichern'; save.addEventListener('click', () => updateRole(role, rights));
    actions.append(save);
    if (!role.system) { const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Rolle löschen'; remove.addEventListener('click', () => requestRoleDelete(role)); actions.append(remove); }
    card.append(title, id, rights, actions); return card;
  }));
}
async function updateRole(role, container) {
  const permissions = [...container.querySelectorAll('input:checked')].map((input) => input.value);
  const response = await fetch(`/api/admin/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: role.name, permissions }) });
  if (!response.ok) { $('#message').textContent = (await response.json()).error; return; }
  $('#message').textContent = 'Berechtigungen gespeichert.'; await loadRoles();
}
function requestRoleDelete(role) {
  pendingRoleDelete = role; $('#role-delete-description').textContent = `${role.name} (${role.id})`; $('#role-delete-dialog').showModal();
}
async function confirmRoleDelete() {
  if (!pendingRoleDelete) return;
  const response = await fetch(`/api/admin/roles/${encodeURIComponent(pendingRoleDelete.id)}`, { method: 'DELETE' });
  if (!response.ok) { $('#message').textContent = (await response.json()).error; $('#role-delete-dialog').close(); return; }
  $('#role-delete-dialog').close(); pendingRoleDelete = null; $('#message').textContent = 'Rolle gelöscht. Betroffene Benutzer verwenden jetzt user.'; await loadRoles();
}
async function saveRole(event) {
  event.preventDefault();
  const permissions = [...document.querySelectorAll('#permission-options input:checked')].map((input) => input.value);
  const response = await fetch('/api/admin/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#role-name').value, permissions }) });
  if (!response.ok) { $('#message').textContent = (await response.json()).error; return; }
  event.target.reset(); $('#message').textContent = ''; await loadRoles();
}
function actionButton(text, action, className = '') { const button = document.createElement('button'); button.textContent = text; button.className = className; button.addEventListener('click', action); return button; }
async function adminAction(userId, action) { const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/${action}`, { method: 'POST' }); if (!response.ok) $('#message').textContent = (await response.json()).error; await loadUsers(); }
function renderSummary(summary) {
  const breakdown = (summary.breakdown || []).slice().sort((a, b) => b.durationMillis - a.durationMillis);
  const excluded = (summary.excludedBreakdown || []).slice().sort((a, b) => b.durationMillis - a.durationMillis);
  $('#period-time-label').textContent = viewMode === 'month' ? 'Monatszeit' : 'Wochenzeit'; $('#total-time').textContent = duration(summary.totalMillis); $('#total-value').textContent = money(summary.totalValueEuro); $('#total-characters').textContent = number(summary.totalCharactersWritten); $('#total-lines').textContent = number(summary.totalNonEmptyLinesWritten);
  const rows = [...breakdown.map((row) => breakdownRow(row, false)), ...excluded.map((row) => breakdownRow(row, true))];
  $('#breakdown').replaceChildren(...(rows.length ? rows : [emptyRow('Keine Daten in diesem Zeitraum.', 7)]));
  renderBranchChart(breakdown);
}
function renderGlobalSummary(summary) {
  $('#global-period-label').textContent = viewMode === 'month' ? 'Globale Monatszeit' : 'Globale Wochenzeit';
  $('#global-time').textContent = duration(summary.totalMillis); $('#global-value').textContent = money(summary.totalValueEuro);
  $('#global-characters').textContent = number(summary.totalCharactersWritten); $('#global-lines').textContent = number(summary.totalNonEmptyLinesWritten);
}
function breakdownRow(entry, excluded) {
  const row = tr([entry.projectName, entry.branchName, duration(entry.durationMillis), number(entry.charactersWritten), number(entry.nonEmptyLinesWritten), money(entry.valueEuro)]);
  if (excluded) {
    row.className = 'excluded-row';
    const note = document.createElement('small'); note.className = 'exclusion-note'; note.textContent = `Ausgeschlossen von ${entry.exclusion?.excludedByName || 'Unbekannt'}`;
    const struckProject = document.createElement('s'); struckProject.textContent = entry.projectName; row.firstChild.replaceChildren(note, struckProject);
    row.append(document.createElement('td'));
  } else {
    const action = document.createElement('td'); const button = document.createElement('button'); button.className = 'trash-button'; button.textContent = '🗑';
    button.title = `${entry.projectName} · ${entry.branchName} aus Statistiken ausschließen`; button.setAttribute('aria-label', button.title);
    button.addEventListener('click', () => requestExclusion(entry)); action.append(button); row.append(action);
  }
  return row;
}
function requestExclusion(entry) {
  pendingExclusion = entry;
  $('#exclude-description').textContent = `${entry.projectName} · ${entry.branchName}`;
  $('#exclude-dialog').showModal();
}
async function confirmExclusion() {
  if (!pendingExclusion) return;
  const entry = pendingExclusion; const button = $('#confirm-exclusion'); button.disabled = true; button.textContent = 'Wird ausgeschlossen …';
  const userId = can('view_all_summaries') ? ($('#user-filter').value || currentUser.id) : currentUser.id;
  try {
    const response = await fetch('/api/exclusions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, projectName: entry.projectName, branchName: entry.branchName }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 404 ? 'Der Server verwendet noch die alte Version. Bitte den Server neu starten.' : body.error || 'Eintrag konnte nicht ausgeschlossen werden.');
    $('#exclude-dialog').close(); pendingExclusion = null; $('#message').textContent = ''; await loadPage();
  } catch (error) { $('#message').textContent = error.message; $('#exclude-dialog').close(); }
  finally { button.disabled = false; button.textContent = 'Ja, ausschließen'; }
}
function renderBranchChart(breakdown) {
  const branches = new Map();
  breakdown.forEach((row) => branches.set(row.branchName, (branches.get(row.branchName) || 0) + row.durationMillis));
  const values = [...branches.entries()].sort((a, b) => b[1] - a[1]);
  const total = values.reduce((sum, entry) => sum + entry[1], 0);
  const colors = ['#6ee7d8', '#60a5fa', '#c084fc', '#fbbf24', '#fb7185', '#a3e635', '#f97316', '#94a3b8'];
  const canvas = $('#branch-chart'); const context = canvas.getContext('2d'); const size = 460;
  canvas.width = size; canvas.height = size; context.clearRect(0, 0, size, size);
  let angle = -Math.PI / 2;
  const slices = values.map(([name, millis], index) => {
    const start = angle; const end = angle + (total ? millis / total * Math.PI * 2 : 0);
    context.beginPath(); context.moveTo(size / 2, size / 2); context.arc(size / 2, size / 2, size / 2 - 2, start, end); context.closePath();
    context.fillStyle = colors[index % colors.length]; context.fill(); angle = end;
    return { name, millis, percent: total ? millis / total * 100 : 0, start, end };
  });
  canvas.setAttribute('aria-label', total ? values.map(([name, millis]) => `${name}: ${Math.round(millis / total * 100)} Prozent`).join(', ') : 'Keine Branchdaten');
  canvas.onmousemove = (event) => showBranchTooltip(event, canvas, slices);
  canvas.onmouseleave = () => { $('#branch-tooltip').hidden = true; };
  $('#branch-legend').replaceChildren(...(values.length ? values.map(([name, millis], index) => {
    const item = document.createElement('div'); const dot = document.createElement('i'); dot.style.background = colors[index % colors.length];
    const label = document.createElement('span'); label.textContent = `${name} · ${Math.round(millis / total * 100)} %`;
    const time = document.createElement('strong'); time.textContent = duration(millis); item.append(dot, label, time); return item;
  }) : [Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Keine Daten in diesem Zeitraum.' })]));
}
function showBranchTooltip(event, canvas, slices) {
  const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left - rect.width / 2, y = event.clientY - rect.top - rect.height / 2;
  const radius = Math.hypot(x, y); if (radius > rect.width / 2 || radius < rect.width * .135) { $('#branch-tooltip').hidden = true; return; }
  let angle = Math.atan2(y, x); if (angle < -Math.PI / 2) angle += Math.PI * 2;
  const slice = slices.find((entry) => angle >= entry.start && angle < entry.end);
  if (!slice) { $('#branch-tooltip').hidden = true; return; }
  const tooltip = $('#branch-tooltip'); tooltip.textContent = `${slice.name} · ${duration(slice.millis)} · ${slice.percent.toFixed(1).replace('.', ',')} %`;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8))}px`;
}
function renderTeam(data) {
  const header = document.createElement('tr'); header.append(th('Teammitglied'));
  data.weeks.forEach((week) => { const cell = th(weekLabel(new Date(week.from))); cell.title = `Durchschnitt: ${week.averageMillis === null ? 'N/A' : duration(week.averageMillis)}`; header.append(cell); });
  $('#team-head').replaceChildren(header);
  $('#team-body').replaceChildren(...(data.members.length ? data.members.map((member) => {
    const row = document.createElement('tr'); const name = document.createElement('th'); name.scope = 'row'; name.textContent = member.username; row.append(name);
    data.weeks.forEach((week) => {
      const millis = week.values[member.id]; const cell = document.createElement('td'); cell.textContent = millis === null || millis === undefined ? 'N/A' : duration(millis);
      const deviation = millis !== null && millis !== undefined && week.averageMillis ? (millis - week.averageMillis) / week.averageMillis : 0;
      if (Math.abs(deviation) > 0.005) {
        const alpha = 0.12 + Math.min(1, Math.abs(deviation)) * 0.38;
        cell.style.backgroundColor = deviation > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(234, 179, 8, ${alpha})`;
      }
      cell.title = millis === null || millis === undefined ? 'Keine Daten vorhanden' : `${deviation >= 0 ? '+' : ''}${Math.round(deviation * 100)} % zum Wochendurchschnitt (${week.averageMillis === null ? 'N/A' : duration(week.averageMillis)})`; row.append(cell);
    }); return row;
  }) : [emptyRow('Noch keine bestätigten Teammitglieder.', data.weeks.length + 1)]));
}
function fallbackTeamWeeks(start) { return Array.from({ length: 8 }, (_, index) => { const from = new Date(start); from.setDate(from.getDate() + index * 7); return { from: from.toISOString(), averageMillis: null, values: {} }; }); }
function th(text) { const cell = document.createElement('th'); cell.textContent = text; return cell; }
function renderCalendar(days, range, target = '#calendar-grid') {
  days = Array.isArray(days) ? days : [];
  const byDate = new Map(days.map((day) => [localDateKey(new Date(day.date)), day]));
  const maximum = Math.max(1, ...days.map((day) => day.durationMillis));
  const cells = [];
  const firstWeekday = range.start.getDay() || 7;
  for (let index = 1; index < firstWeekday; index++) { const blank = document.createElement('div'); blank.className = 'calendar-day outside'; cells.push(blank); }
  for (let date = new Date(range.start); date < range.end; date.setDate(date.getDate() + 1)) {
    const day = byDate.get(localDateKey(date)); const cell = document.createElement('article');
    const heat = day ? Math.max(1, Math.ceil((day.durationMillis / maximum) * 5)) : 0;
    cell.className = `calendar-day${heat ? ` heat-${heat}` : ''}`;
    const numberElement = document.createElement('strong'); numberElement.textContent = String(date.getDate()); cell.append(numberElement);
    if (day) {
      const time = document.createElement('span'); time.className = 'calendar-time'; time.textContent = duration(day.durationMillis); cell.append(time);
      const activities = document.createElement('div'); activities.className = 'calendar-activities';
      day.activities.slice(0, 3).forEach((activity) => { const item = document.createElement('small'); item.textContent = `${activity.projectName} · ${activity.branchName}`; activities.append(item); });
      cell.append(activities); cell.title = day.activities.map((activity) => `${activity.projectName} · ${activity.branchName}: ${duration(activity.durationMillis)}`).join('\n');
    }
    cells.push(cell);
  }
  $(target).replaceChildren(...cells);
}
function renderSessions(sessions, range) { const visible = sessions.filter((session) => Date.parse(session.endedAt) > range.start && Date.parse(session.startedAt) < range.end); $('#sessions').replaceChildren(...(visible.length ? visible.map((session) => tr([new Date(session.startedAt).toLocaleString('de-DE'), new Date(session.endedAt).toLocaleString('de-DE'), session.projectName, session.branchName, duration(session.durationMillis), number(session.charactersWritten), number(session.nonEmptyLinesWritten)])) : [emptyRow('Keine Sessions in dieser Kalenderwoche.', 7)])); }
function tr(values) { const row = document.createElement('tr'); for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); } return row; }
function emptyRow(text, columns) { const row = tr([text]); row.firstChild.colSpan = columns; row.firstChild.className = 'empty'; return row; }
function weekRange(offset) { const now = new Date(), day = now.getDay() || 7, start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1 + offset * 7), end = new Date(start); end.setDate(end.getDate() + 7); const thursday = new Date(start); thursday.setDate(thursday.getDate() + 3); const yearStart = new Date(thursday.getFullYear(), 0, 1), week = Math.ceil((((thursday - yearStart) / 86400000) + yearStart.getDay() + 1) / 7); return { start, end, label: `KW ${week} / ${thursday.getFullYear()}` }; }
function weekLabel(date) { const day = date.getDay() || 7, thursday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day + 4), yearStart = new Date(thursday.getFullYear(), 0, 1), week = Math.ceil((((thursday - yearStart) / 86400000) + yearStart.getDay() + 1) / 7); return `KW ${week}/${thursday.getFullYear()}`; }
function monthRange(offset) { const now = new Date(), start = new Date(now.getFullYear(), now.getMonth() + offset, 1), end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1); return { start, end, label: new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(start) }; }
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function duration(ms) { const seconds = Math.floor((ms || 0) / 1000); return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60].map((v) => String(v).padStart(2, '0')).join(':'); }
function money(value) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value); }
function number(value) { return new Intl.NumberFormat('de-DE').format(value || 0); }
function can(permission) { return currentUser?.permissions?.includes(permission) || false; }
restoreLogin();
