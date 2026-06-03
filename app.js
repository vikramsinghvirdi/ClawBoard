// ═══════════════════════════════════════════════════════════════════════
// ClawBoard — App Logic v2
// Drag-drop (cross-column + within-column reorder), validation,
// Discord notifications, claw animation, agent auto-pickup,
// local activity feed, OpenClaw integration
// ═══════════════════════════════════════════════════════════════════════

// ─── State ───────────────────────────────────────────────────────────
const COLUMNS = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
let tasksData = {};
COLUMNS.forEach(c => tasksData[c] = []);

let openclawAgents = [];
let openclawChannels = [];
let setupStatus = null;
let availableModels = [];

// Local activity feed (board-level events)
let localActivityLog = [];
const MAX_LOCAL_ACTIVITY = 50;

// Map channel IDs to readable names (populated from bindings)
const channelNameMap = {};

// ─── DOM References ──────────────────────────────────────────────────
const addBtn = document.getElementById('add-task-btn');
const dialog = document.getElementById('task-dialog');
const reviewDialog = document.getElementById('review-dialog');
const onboardingDialog = document.getElementById('onboarding-dialog');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelModalBtn = document.getElementById('cancel-task-btn');
const deleteModalBtn = document.getElementById('delete-task-btn');
const taskForm = document.getElementById('task-form');
const modalTitleText = document.getElementById('modal-title-text');

const inputId = document.getElementById('task-id');
const inputCol = document.getElementById('task-col');
const inputTitle = document.getElementById('task-title');
const inputDetails = document.getElementById('task-details');
const inputAssigned = document.getElementById('task-assigned');
const inputPriority = document.getElementById('task-priority');

// Review dialog
const closeReviewBtn = document.getElementById('close-review-btn');
const approveReviewBtn = document.getElementById('approve-review-btn');
const rejectReviewBtn = document.getElementById('reject-review-btn');
const reviewFeedback = document.getElementById('review-feedback');
const reviewTaskInfo = document.getElementById('review-task-info');
const closeOnboardingBtn = document.getElementById('close-onboarding-btn');
const dismissOnboardingBtn = document.getElementById('dismiss-onboarding-btn');
const refreshSetupBtn = document.getElementById('refresh-setup-btn');
const boardChannelInput = document.getElementById('board-channel-id');
const saveBoardChannelBtn = document.getElementById('save-board-channel-btn');
const clearBoardChannelBtn = document.getElementById('clear-board-channel-btn');
const boardChannelHelp = document.getElementById('board-channel-help');
const openAgentDirectoryBtn = document.getElementById('open-agent-directory-btn');
const agentDirectoryDialog = document.getElementById('agent-directory-dialog');
const closeAgentDirectoryBtn = document.getElementById('close-agent-directory-btn');
const agentDirectoryList = document.getElementById('agent-directory-list');
const agentDirectorySource = document.getElementById('agent-directory-source');
const setupSourceNote = document.getElementById('setup-source-note');
const agentFilter = document.getElementById('agent-filter');
const agentFilterToggle = document.getElementById('agent-filter-toggle');
const agentFilterLabel = document.getElementById('agent-filter-label');
const agentFilterMenu = document.getElementById('agent-filter-menu');
const clearFiltersBtn = document.getElementById('clear-filters-btn');
const logDateFrom = document.getElementById('log-date-from');
const logDateTo = document.getElementById('log-date-to');
const logSearchInput = document.getElementById('log-search-input');
const clearLogSearchBtn = document.getElementById('clear-log-search-btn');
const fileActivityLog = document.getElementById('file-activity-log');
const logResultSummary = document.getElementById('log-result-summary');

let reviewingTask = null;
let reviewingCol = null;
let onboardingDismissed = false;
let selectedAgentFilters = new Set();
let workspaceLogState = { date: '', dates: [], entries: [] };

function closeDialogOnBackdropClick(dialogEl) {
  if (!dialogEl) return;
  dialogEl.addEventListener('click', (event) => {
    if (event.target === dialogEl) {
      dialogEl.close();
    }
  });
}

// ─── Initialization ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Load stored local activity
  try {
    const stored = localStorage.getItem('clawboard-activity');
    if (stored) localActivityLog = JSON.parse(stored);
  } catch (e) { /* ignore */ }
  onboardingDismissed = localStorage.getItem('clawboard-onboarding-dismissed') === 'true';
  loadStoredAgentFilters();

  // Load OpenClaw data first, then tasks
  await fetchSetup();
  await Promise.all([
    fetchAgents(),
    fetchChannels()
  ]);
  await fetchTasks();
  fetchActivity();

  // Event listeners
  addBtn.addEventListener('click', () => openModal(null));
  closeModalBtn.addEventListener('click', () => dialog.close());
  cancelModalBtn.addEventListener('click', () => dialog.close());
  deleteModalBtn.addEventListener('click', deleteTask);
  taskForm.addEventListener('submit', saveTask);
  closeDialogOnBackdropClick(dialog);

  // Review dialog
  closeReviewBtn.addEventListener('click', () => reviewDialog.close());
  approveReviewBtn.addEventListener('click', () => handleReview(true));
  rejectReviewBtn.addEventListener('click', () => handleReview(false));
  closeDialogOnBackdropClick(reviewDialog);

  // Sidebar toggle
  const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
  const sidebarWrapper = document.getElementById('sidebar-wrapper');
  const workspaceLayout = document.querySelector('.workspace-layout');
  const toggleIcon = toggleSidebarBtn.querySelector('.toggle-icon');

  const sidebarState = localStorage.getItem('sidebar-collapsed');
  const shouldCollapse = sidebarState === null || sidebarState === 'true';
  if (shouldCollapse) {
    sidebarWrapper.classList.add('collapsed');
    workspaceLayout.classList.add('sidebar-collapsed');
    toggleIcon.classList.add('flipped');
  } else {
    toggleIcon.classList.remove('flipped');
  }

  toggleSidebarBtn.addEventListener('click', () => {
    const isCollapsed = sidebarWrapper.classList.toggle('collapsed');
    workspaceLayout.classList.toggle('sidebar-collapsed', isCollapsed);
    toggleIcon.classList.toggle('flipped', isCollapsed);
    localStorage.setItem('sidebar-collapsed', isCollapsed);
  });

  // Filters
  agentFilterToggle.addEventListener('click', () => {
    const isOpen = agentFilterToggle.getAttribute('aria-expanded') === 'true';
    setAgentFilterMenuOpen(!isOpen);
  });
  clearFiltersBtn.addEventListener('click', () => {
    selectedAgentFilters.clear();
    persistAgentFilters();
    syncAgentFilterControls();
    renderBoard();
  });
  document.addEventListener('click', (event) => {
    if (!agentFilter.contains(event.target)) setAgentFilterMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setAgentFilterMenuOpen(false);
  });
  logSearchInput?.addEventListener('input', renderWorkspaceLogs);
  logDateFrom?.addEventListener('change', () => fetchActivity());
  logDateTo?.addEventListener('change', () => fetchActivity());
  clearLogSearchBtn?.addEventListener('click', () => {
    if (logSearchInput) logSearchInput.value = '';
    if (logDateFrom) logDateFrom.value = '';
    if (logDateTo) logDateTo.value = '';
    fetchActivity();
    logSearchInput?.focus();
  });

  // Setup drag-and-drop on all columns
  setupDragAndDrop();

  // Poll for updates made by background agents
  setInterval(() => {
    if (!draggedTaskId) {
      fetchTasks();
    }
  }, 5000);

  // ─── Theme Toggle Logic ───
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const iconDark = document.getElementById('theme-icon-dark');
  const iconLight = document.getElementById('theme-icon-light');

  function updateTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
      iconLight.style.display = 'none';
      iconDark.style.display = 'block';
    } else {
      document.documentElement.removeAttribute('data-theme');
      iconLight.style.display = 'block';
      iconDark.style.display = 'none';
    }
    localStorage.setItem('clawboard-theme', theme);
  }

  const savedTheme = localStorage.getItem('clawboard-theme') || 'dark';
  updateTheme(savedTheme);

  themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    updateTheme(current === 'light' ? 'dark' : 'light');
  });

  // ─── Tabs Logic ───
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById('workspace-layout').style.display = targetId === 'workspace-layout' ? 'flex' : 'none';
      document.getElementById('workspace-logs-layout').style.display = targetId === 'workspace-logs-layout' ? 'block' : 'none';
    });
  });
  document.getElementById('workspace-logs-layout').style.display = 'none';

  openAgentDirectoryBtn?.addEventListener('click', () => openAgentDirectory());
  closeAgentDirectoryBtn?.addEventListener('click', () => agentDirectoryDialog.close());
  closeDialogOnBackdropClick(agentDirectoryDialog);

  // Onboarding dialog
  closeOnboardingBtn.addEventListener('click', () => onboardingDialog.close());
  dismissOnboardingBtn.addEventListener('click', () => {
    onboardingDismissed = true;
    localStorage.setItem('clawboard-onboarding-dismissed', 'true');
    onboardingDialog.close();
  });
  refreshSetupBtn.addEventListener('click', async () => {
    await fetchSetup({ allowAutoOpen: false });
    showToast('Setup status refreshed', 'info');
  });
  saveBoardChannelBtn?.addEventListener('click', () => saveBoardChannelSetting(boardChannelInput.value));
  clearBoardChannelBtn?.addEventListener('click', () => {
    boardChannelInput.value = '';
    saveBoardChannelSetting('');
  });
  closeDialogOnBackdropClick(onboardingDialog);

  if (shouldShowOnboarding()) {
    openOnboarding();
  }
});

// ─── Local Activity Feed ─────────────────────────────────────────────
function addActivity(emoji, message) {
  const entry = {
    emoji,
    message,
    timestamp: new Date().toISOString(),
    timeLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  localActivityLog.unshift(entry);
  if (localActivityLog.length > MAX_LOCAL_ACTIVITY) {
    localActivityLog = localActivityLog.slice(0, MAX_LOCAL_ACTIVITY);
  }
  // Persist
  try { localStorage.setItem('clawboard-activity', JSON.stringify(localActivityLog)); } catch (e) { /* ignore */ }
  renderLocalActivity();
}

function renderLocalActivity() {
  const container = document.getElementById('local-activity-log');
  if (!container) return;

  if (localActivityLog.length === 0) {
    container.innerHTML = '<div class="activity-placeholder">No board activity yet</div>';
    return;
  }

  container.innerHTML = localActivityLog.slice(0, MAX_LOCAL_ACTIVITY).map(entry => `
    <div class="activity-item local-activity-entry">
      <span class="activity-emoji">${entry.emoji}</span>
      <span class="activity-text">${escapeHtml(entry.message)}</span>
      <span class="activity-time">${entry.timeLabel}</span>
    </div>
  `).join('');
}

function formatActivityLine(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  return html;
}

function parseWorkspaceLogEntries(content = '') {
  const entries = [];
  let section = '';

  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const heading = trimmed.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      section = heading[1].trim();
      entries.push({
        type: 'heading',
        section,
        text: section,
        html: formatActivityLine(section)
      });
      return;
    }

    const text = trimmed.replace(/^[-*]\s+/, '');
    entries.push({
      type: 'entry',
      section,
      text,
      html: formatActivityLine(text)
    });
  });

  return entries;
}

function updateLogDateBounds(dates = []) {
  const days = [...new Set(dates.map(date => date.slice(0, 10)).filter(Boolean))].sort();
  if (logDateFrom) {
    logDateFrom.min = days[0] || '';
    logDateFrom.max = days[days.length - 1] || '';
  }
  if (logDateTo) {
    logDateTo.min = days[0] || '';
    logDateTo.max = days[days.length - 1] || '';
  }
}

function getLogRangeLabel() {
  const from = logDateFrom?.value || '';
  const to = logDateTo?.value || '';
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `through ${to}`;
  return 'all dates';
}

function renderWorkspaceLogs() {
  if (!fileActivityLog || !logResultSummary) return;

  const query = (logSearchInput?.value || '').trim().toLowerCase();
  const entries = workspaceLogState.entries.filter(entry => {
    if (!query) return true;
    return `${entry.section} ${entry.text}`.toLowerCase().includes(query);
  });
  const visibleEntries = entries.filter(entry => entry.type === 'entry').length;
  const totalEntries = workspaceLogState.entries.filter(entry => entry.type === 'entry').length;
  const dateLabel = getLogRangeLabel();

  if (workspaceLogState.entries.length === 0) {
    fileActivityLog.innerHTML = '<p class="activity-placeholder">No workspace logs found.</p>';
    logResultSummary.textContent = 'No logs found.';
    return;
  }

  if (entries.length === 0) {
    fileActivityLog.innerHTML = '<p class="activity-placeholder">No logs match your search.</p>';
    logResultSummary.textContent = `0 of ${totalEntries} logs on ${dateLabel}.`;
    return;
  }

  fileActivityLog.innerHTML = entries.map(entry => {
    if (entry.type === 'heading') {
      return `<div class="activity-log-heading">${entry.html}</div>`;
    }
    return `<div class="activity-item workspace-log-entry">${entry.html}</div>`;
  }).join('');

  logResultSummary.textContent = query
    ? `${visibleEntries} of ${totalEntries} logs on ${dateLabel}.`
    : `${totalEntries} logs on ${dateLabel}.`;
}

async function fetchActivity(date = '') {
  if (!fileActivityLog) return;

  fileActivityLog.innerHTML = '<p class="activity-placeholder">Loading logs...</p>';
  if (logResultSummary) logResultSummary.textContent = 'Loading workspace logs...';

  try {
    const params = new URLSearchParams();
    const dateFrom = logDateFrom?.value || '';
    const dateTo = logDateTo?.value || '';
    if (date) params.set('date', date);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const query = params.toString() ? `?${params}` : '';
    const res = await fetch(`/api/activity${query}`);
    if (!res.ok) throw new Error('Network error');
    const data = await res.json();

    workspaceLogState = {
      date: data.date || '',
      dates: data.dates || [],
      entries: parseWorkspaceLogEntries(data.content || '')
    };

    updateLogDateBounds(workspaceLogState.dates);
    renderWorkspaceLogs();
  } catch (err) {
    console.error('Error fetching activity:', err);
    workspaceLogState = { date: '', dates: [], entries: [] };
    fileActivityLog.innerHTML = '<p class="activity-placeholder">Failed to load workspace logs.</p>';
    if (logResultSummary) logResultSummary.textContent = 'Failed to load logs.';
  }
}

// ─── Setup Status ───────────────────────────────────────────────────
async function fetchSetup(options = {}) {
  const { allowAutoOpen = true } = options;
  try {
    const res = await fetch('/api/setup');
    if (!res.ok) throw new Error('Network error');
    setupStatus = await res.json();
    availableModels = setupStatus.availableModels || [];
    renderSetupBanner();
    renderOnboarding();
    if (allowAutoOpen && shouldShowOnboarding()) {
      openOnboarding();
    }
  } catch (err) {
    console.error('Failed to fetch setup status:', err);
  }
}

function setupIssues() {
  if (!setupStatus) return [];
  const issues = [];
  if (!setupStatus.openclawConfigExists) {
    issues.push({ label: 'OpenClaw config', detail: `Expected ${setupStatus.openclawConfigPath}` });
  }
  if (setupStatus.agentsCount === 0) {
    issues.push({ label: 'Agents', detail: 'No OpenClaw agents found' });
  }
  if (setupStatus.bindingsCount === 0) {
    issues.push({ label: 'Discord bindings', detail: 'No agent channel bindings found' });
  }
  if (!setupStatus.discordTokenConfigured) {
    issues.push({ label: 'Discord token', detail: 'Discord bot token is not configured' });
  }
  if (!setupStatus.boardChannelConfigured) {
    issues.push({ label: 'Board status channel', detail: 'Optional, but recommended for status updates' });
  }
  return issues;
}

function shouldShowOnboarding() {
  return setupStatus && setupIssues().length > 0 && !onboardingDismissed && !onboardingDialog.open;
}

function renderSetupBanner() {
  const banner = document.getElementById('setup-banner');
  if (!banner || !setupStatus) return;

  const issues = setupIssues();

  const healthy = issues.length === 0;
  banner.className = `setup-banner ${healthy ? 'healthy' : 'needs-setup'}`;
  banner.innerHTML = healthy
    ? `<span class="setup-dot"></span><span>OpenClaw ready · ${setupStatus.agentsCount} agent${setupStatus.agentsCount !== 1 ? 's' : ''} · ${availableModels.length} model${availableModels.length !== 1 ? 's' : ''}</span><button id="open-onboarding-btn" class="btn btn-secondary setup-action" type="button">Setup</button>`
    : `<span class="setup-dot"></span><div><strong>Setup needed</strong><span>${issues.map(issue => escapeHtml(issue.label)).join(' · ')}</span></div><button id="open-onboarding-btn" class="btn btn-secondary setup-action" type="button">Fix setup</button>`;
  banner.hidden = false;

  document.getElementById('open-onboarding-btn')?.addEventListener('click', () => openOnboarding());
}

function renderOnboarding() {
  if (!setupStatus) return;
  const checklist = document.getElementById('onboarding-checklist');
  const paths = document.getElementById('setup-paths');
  if (!checklist || !paths) return;
  renderConfigSourceNotes();

  const checks = [
    {
      ok: setupStatus.openclawConfigExists,
      label: 'OpenClaw config',
      detail: setupStatus.openclawConfigExists ? 'Found openclaw.json' : `Create or point OPENCLAW_CONFIG to ${setupStatus.openclawConfigPath}`
    },
    {
      ok: setupStatus.agentsCount > 0,
      label: 'Agents',
      detail: `${setupStatus.agentsCount} configured`
    },
    {
      ok: setupStatus.bindingsCount > 0,
      label: 'Discord bindings',
      detail: `${setupStatus.bindingsCount} agent channel binding${setupStatus.bindingsCount !== 1 ? 's' : ''}`
    },
    {
      ok: setupStatus.discordTokenConfigured,
      label: 'Discord bot token',
      detail: setupStatus.discordTokenConfigured ? 'Configured' : 'Required for Discord notifications'
    },
    {
      ok: setupStatus.boardChannelConfigured,
      label: 'Board status channel',
      detail: setupStatus.boardChannelConfigured ? setupStatus.boardChannelId : 'Optional; use BOARD_CHANNEL_ID or clawboard.json'
    }
  ];

  checklist.innerHTML = checks.map(check => `
    <div class="setup-check ${check.ok ? 'ok' : 'pending'}">
      <span class="setup-check-icon">${check.ok ? '✓' : '!'}</span>
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <span>${escapeHtml(check.detail)}</span>
      </div>
    </div>
  `).join('');

  const pathRows = [
    ['OpenClaw config', setupStatus.openclawConfigPath],
    ['KANBAN.md', setupStatus.kanbanPath],
    ['Memory logs', setupStatus.memoryDir],
    ['ClawBoard config', setupStatus.clawboardConfigPath]
  ];

  paths.innerHTML = pathRows.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value || 'Not configured')}</dd>
    </div>
  `).join('');

  renderBoardChannelSetting();
}

function openOnboarding() {
  renderOnboarding();
  onboardingDialog.showModal();
}

function loadStoredAgentFilters() {
  try {
    const stored = JSON.parse(localStorage.getItem('clawboard-agent-filters') || '[]');
    if (Array.isArray(stored)) selectedAgentFilters = new Set(stored.map(String));
  } catch (err) {
    selectedAgentFilters = new Set();
  }
}

function persistAgentFilters() {
  localStorage.setItem('clawboard-agent-filters', JSON.stringify([...selectedAgentFilters]));
}

function setAgentFilterMenuOpen(isOpen) {
  if (!agentFilterToggle || !agentFilterMenu) return;
  agentFilterToggle.setAttribute('aria-expanded', String(isOpen));
  agentFilterMenu.hidden = !isOpen;
}

function agentMatchesTask(task, agentId) {
  if (!task.assigned) return false;
  if (task.assigned === agentId) return true;
  const agent = openclawAgents.find(item => item.id === agentId);
  return Boolean(agent && task.assigned === agent.name);
}

function taskMatchesSelectedAgents(task) {
  if (selectedAgentFilters.size === 0) return true;
  return [...selectedAgentFilters].some(agentId => agentMatchesTask(task, agentId));
}

function updateAgentFilterLabel() {
  if (!agentFilterLabel || !clearFiltersBtn) return;

  const selected = [...selectedAgentFilters]
    .map(agentId => openclawAgents.find(agent => agent.id === agentId)?.name || agentId)
    .filter(Boolean);

  if (selected.length === 0) {
    agentFilterLabel.textContent = '🤖 All Agents';
  } else if (selected.length === 1) {
    agentFilterLabel.textContent = selected[0];
  } else {
    agentFilterLabel.textContent = `${selected.length} agents selected`;
  }

  clearFiltersBtn.disabled = selected.length === 0;
}

function syncAgentFilterControls() {
  if (!agentFilterMenu) return;
  agentFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selectedAgentFilters.has(input.value);
  });
  updateAgentFilterLabel();
}

function renderAgentFilterOptions() {
  if (!agentFilterMenu) return;

  const validAgentIds = new Set(openclawAgents.map(agent => agent.id));
  selectedAgentFilters = new Set([...selectedAgentFilters].filter(agentId => validAgentIds.has(agentId)));

  agentFilterMenu.innerHTML = '';

  if (openclawAgents.length === 0) {
    agentFilterMenu.innerHTML = '<p class="agent-filter-empty">No OpenClaw agents found.</p>';
    updateAgentFilterLabel();
    return;
  }

  openclawAgents.forEach(agent => {
    const row = document.createElement('label');
    row.className = 'agent-filter-option';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = agent.id;
    checkbox.checked = selectedAgentFilters.has(agent.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedAgentFilters.add(agent.id);
      else selectedAgentFilters.delete(agent.id);
      persistAgentFilters();
      syncAgentFilterControls();
      renderBoard();
    });

    const name = document.createElement('span');
    name.textContent = agent.name;

    const meta = document.createElement('span');
    meta.className = 'agent-filter-meta';
    meta.textContent = agent.id;

    row.append(checkbox, name, meta);
    agentFilterMenu.appendChild(row);
  });

  persistAgentFilters();
  updateAgentFilterLabel();
}

function isDemoConfigPath(configPath = '') {
  return /\/demo\/openclaw\.json$|clawboard-(demo|check|media)-openclaw\.json$/.test(String(configPath));
}

function sourceSummary() {
  if (!setupStatus) return 'Agents load from your active OpenClaw config.';
  const path = setupStatus.openclawConfigPath || 'OpenClaw config not found';
  if (isDemoConfigPath(path)) return 'Demo agents are loaded from the bundled sample OpenClaw config';
  return `Agents are loaded from ${path}`;
}

function renderConfigSourceNotes() {
  const summary = sourceSummary();
  const demoNote = setupStatus && isDemoConfigPath(setupStatus.openclawConfigPath)
    ? ' This is sample data for screenshots. Run ./start.sh without demo overrides to see your real OpenClaw agents.'
    : '';
  if (setupSourceNote) setupSourceNote.textContent = `${summary}.${demoNote}`;
  if (agentDirectorySource) agentDirectorySource.textContent = `${summary}.${demoNote}`;
}

function renderBoardChannelSetting() {
  if (!boardChannelInput || !boardChannelHelp || !setupStatus) return;

  boardChannelInput.value = setupStatus.savedBoardChannelId || setupStatus.boardChannelId || '';
  const activeChannel = setupStatus.boardChannelId || 'Not configured';
  const envNote = setupStatus.envBoardChannelIdConfigured
    ? ' BOARD_CHANNEL_ID is set for this server; saved changes apply now, but the env value wins after restart.'
    : '';
  boardChannelHelp.textContent = `Active board channel: ${activeChannel}.${envNote}`;
}

function canAutoInvokeAgents() {
  return Boolean(setupStatus?.autoInvokeAgents);
}

async function saveBoardChannelSetting(boardChannelId) {
  const normalized = String(boardChannelId || '').trim();
  if (saveBoardChannelBtn) saveBoardChannelBtn.disabled = true;
  if (clearBoardChannelBtn) clearBoardChannelBtn.disabled = true;

  try {
    const res = await fetch('/api/settings/board-channel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardChannelId: normalized })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save board channel');

    await fetchSetup({ allowAutoOpen: false });
    showToast(data.boardChannelId ? 'Board channel saved' : 'Board channel cleared', 'success');
  } catch (err) {
    console.error('Failed to save board channel:', err);
    showToast(err.message || 'Failed to save board channel', 'error');
  } finally {
    if (saveBoardChannelBtn) saveBoardChannelBtn.disabled = false;
    if (clearBoardChannelBtn) clearBoardChannelBtn.disabled = false;
  }
}

// ─── Fetch OpenClaw Agents ───────────────────────────────────────────
async function fetchAgents() {
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error('Network error');
    openclawAgents = await res.json();

    const agentSelect = inputAssigned;
    agentSelect.innerHTML = '<option value="">Unassigned</option>';

    openclawAgents.forEach(agent => {
      agentSelect.appendChild(new Option(agent.name, agent.id));
    });

    renderAgentFilterOptions();
    renderAgentSidebar();
    renderAgentDirectory();
  } catch (err) {
    console.error('Failed to fetch agents:', err);
  }
}

function getModelOptions(currentModel) {
  const models = new Set(availableModels);
  if (currentModel && currentModel !== 'unknown') models.add(currentModel);
  return Array.from(models).sort((a, b) => a.localeCompare(b));
}

async function updateAgentModel(agentId, model, selectEl) {
  const agent = openclawAgents.find(a => a.id === agentId);
  const previousModel = agent?.model || '';
  selectEl.disabled = true;

  try {
    const res = await fetch('/api/agent-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, model })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Model update failed');

    if (agent) agent.model = data.agent.model;
    if (!availableModels.includes(data.agent.model)) availableModels.push(data.agent.model);
    showToast(`Model updated for ${data.agent.name}`, 'success');
    renderAgentSidebar();
  } catch (err) {
    console.error('Failed to update model:', err);
    if (previousModel) selectEl.value = previousModel;
    showToast('Failed to update agent model', 'error');
  } finally {
    selectEl.disabled = false;
  }
}

// ─── Fetch Discord Channel Bindings ──────────────────────────────────
async function fetchChannels() {
  try {
    const res = await fetch('/api/channels');
    if (!res.ok) throw new Error('Network error');
    openclawChannels = await res.json();

    const seen = new Set();

    openclawChannels.forEach(binding => {
      if (seen.has(binding.channelId)) return;
      seen.add(binding.channelId);

      const friendly = `#${binding.agentId}`;
      channelNameMap[binding.channelId] = friendly;
      channelNameMap[`#${binding.channelId}`] = friendly;
    });
    renderAgentDirectory();
  } catch (err) {
    console.error('Failed to fetch channels:', err);
  }
}

function getAgentDirectoryRows() {
  return openclawAgents.map(agent => {
    const binding = openclawChannels.find(b => b.agentId === agent.id);
    let totalCount = 0;
    COLUMNS.forEach(col => {
      totalCount += (tasksData[col] || []).filter(t => t.assigned === agent.id || t.assigned === agent.name).length;
    });

    return {
      agent,
      binding,
      totalCount,
      channelLabel: binding ? `#${binding.agentId}` : 'Not bound',
      channelId: binding?.channelId || ''
    };
  });
}

function renderAgentDirectory() {
  if (!agentDirectoryList) return;
  renderConfigSourceNotes();

  if (openclawAgents.length === 0) {
    agentDirectoryList.innerHTML = '<div class="activity-placeholder">No OpenClaw agents found yet.</div>';
    return;
  }

  agentDirectoryList.innerHTML = getAgentDirectoryRows().map(({ agent, binding, totalCount, channelLabel, channelId }) => `
    <div class="agent-directory-row ${binding ? '' : 'missing-binding'}">
      <div class="agent-directory-main">
        <strong>${escapeHtml(agent.name)}</strong>
        <span>${escapeHtml(agent.id)} · ${totalCount} task${totalCount !== 1 ? 's' : ''}</span>
      </div>
      <div class="agent-directory-meta">
        <span class="agent-model-pill">${escapeHtml(agent.model || 'No model')}</span>
        <span class="channel-pill">${escapeHtml(channelLabel)}</span>
        ${channelId ? `<code>${escapeHtml(channelId)}</code>` : '<span class="missing-channel">No Discord channel binding</span>'}
      </div>
    </div>
  `).join('');
}

function openAgentDirectory() {
  renderAgentDirectory();
  agentDirectoryDialog.showModal();
}

// ─── Render Agent Sidebar ────────────────────────────────────────────
function renderAgentSidebar() {
  const container = document.getElementById('agent-list');
  if (openclawAgents.length === 0) {
    container.innerHTML = '<div class="activity-placeholder">No agents configured</div>';
    return;
  }

  const emojiMap = { main: '🧠' };

  const processedAgents = openclawAgents.map(agent => {
    const emoji = emojiMap[agent.id] || '🤖';
    const binding = openclawChannels.find(b => b.agentId === agent.id);
    const channelLabel = binding ? `#${binding.agentId}` : 'No channel';

    // Count tasks & determine status
    let inProgressCount = 0;
    let totalCount = 0;
    COLUMNS.forEach(col => {
      const count = (tasksData[col] || []).filter(t => t.assigned === agent.id || t.assigned === agent.name).length;
      if (['Todo', 'In Progress', 'In Review'].includes(col)) {
        totalCount += count;
      }
      if (col === 'In Progress') inProgressCount = count;
    });

    return { ...agent, emoji, channelLabel, inProgressCount, totalCount };
  });

  // Sort by In Progress count (descending), then total tasks (descending)
  processedAgents.sort((a, b) => {
    if (b.inProgressCount !== a.inProgressCount) return b.inProgressCount - a.inProgressCount;
    return b.totalCount - a.totalCount;
  });

  container.innerHTML = processedAgents.map(agent => {
    const statusText = agent.inProgressCount > 0 ? 'Working' : 'Idle';
    const statusClass = agent.inProgressCount > 0 ? 'working' : 'idle';
    const tooltipText = agent.inProgressCount > 0 ? 'Agent has a task in the In Progress column' : 'Agent has no tasks in progress';
    const modelOptions = getModelOptions(agent.model);
    const modelControl = modelOptions.length
      ? `<select class="agent-model-select" data-agent-id="${escapeAttr(agent.id)}" title="Agent model">
          ${modelOptions.map(model => `<option value="${escapeAttr(model)}" ${model === agent.model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')}
        </select>`
      : `<p class="agent-role">${escapeHtml(agent.model)}</p>`;

    return `
      <div class="agent-item">
        <div class="agent-avatar-wrapper">
          <span class="agent-avatar">${agent.emoji}</span>
          <span class="agent-pulse ${agent.inProgressCount > 0 ? 'active' : ''}"></span>
        </div>
        <div class="agent-details">
          <h4>${escapeHtml(agent.name)}</h4>
          ${modelControl}
          <div class="agent-status-row">
            <span class="agent-status-badge ${statusClass}" title="${tooltipText}">${statusText}</span>
            <span class="agent-channel-text">${agent.channelLabel} · ${agent.totalCount} task${agent.totalCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.agent-model-select').forEach(select => {
    select.addEventListener('change', () => {
      updateAgentModel(select.dataset.agentId, select.value, select);
    });
  });
}

// ─── Fetch Tasks ─────────────────────────────────────────────────────
async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Network error');
    const data = await res.json();

    COLUMNS.forEach(col => {
      tasksData[col] = (data[col] || []).map(t => {
        t.channel = cleanChannel(t.channel);
        if (!t.priority) t.priority = 'medium';
        if (!t.createdAt) t.createdAt = new Date().toISOString();
        return t;
      });
    });

    renderBoard();
    renderAgentSidebar();
    renderAgentDirectory();
    renderLocalActivity();
  } catch (err) {
    console.error('Error fetching tasks:', err);
    showToast('Failed to load tasks from KANBAN.md', 'error');
  }
}

// ─── Save Tasks ──────────────────────────────────────────────────────
async function saveTasksToServer() {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasksData)
    });
    if (!res.ok) throw new Error('Save failed');
  } catch (err) {
    console.error('Error saving tasks:', err);
    showToast('Failed to save to KANBAN.md', 'error');
  }
}

// ─── Send Discord Notification ──────────────────────────────────────
async function notifyDiscord(task, fromCol, toCol) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, fromCol, toCol })
    });
  } catch (err) {
    console.error('Discord notification failed:', err);
  }
}

// ─── Render Board ────────────────────────────────────────────────────
function renderBoard() {
  COLUMNS.forEach(colName => {
    let list = [...(tasksData[colName] || [])];

    list = list.filter(taskMatchesSelectedAgents);

    const countId = `count-${colName.replace(/\s+/g, '-')}`;
    const countEl = document.getElementById(countId);
    if (countEl) countEl.textContent = list.length;

    const containerId = `col-${colName.replace(/\s+/g, '-')}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';

    if (list.length === 0) {
      container.innerHTML = '<div class="empty-col-message">No tasks</div>';
      return;
    }

    list.forEach((task, index) => {
      const card = createCardElement(task, colName, index, list.length);
      container.appendChild(card);
    });
  });
}

// ─── Create Card Element ─────────────────────────────────────────────
function createCardElement(task, colName, index, total) {
  const card = document.createElement('div');
  const activeClass = colName === 'In Progress' ? 'active-task-glow' : '';
  card.className = `task-card ${task.completed ? 'completed-task' : ''} ${activeClass}`;
  card.draggable = true;
  card.dataset.id = task.id;
  card.dataset.column = colName;
  card.dataset.index = index;
  card.dataset.priority = task.priority || 'medium';

  // Agent info
  let assigneeClass = '';
  let assigneeInitials = '';
  let agentDisplayName = '';
  if (task.assigned) {
    const agentId = task.assigned.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    assigneeClass = `assignee-${agentId}`;

    const agent = openclawAgents.find(a => a.id === task.assigned || a.name === task.assigned);
    agentDisplayName = agent ? agent.name : task.assigned;
    const parts = agentDisplayName.split(/(?=[A-Z])|\s+/);
    assigneeInitials = parts.filter(Boolean).map(n => n[0]).join('').substring(0, 2).toUpperCase();
  }

  // Channel display
  let channelDisplay = '';
  if (task.channel) {
    const rawChannel = task.channel.trim();
    if (channelNameMap[rawChannel]) {
      channelDisplay = channelNameMap[rawChannel];
    } else if (channelNameMap[rawChannel.replace(/^#/, '')]) {
      channelDisplay = channelNameMap[rawChannel.replace(/^#/, '')];
    } else {
      channelDisplay = rawChannel;
    }
  }

  // Priority label
  const priorityLabels = { critical: '🔴', high: '🟠', medium: '', low: '🟢' };
  const priorityIcon = priorityLabels[task.priority] || '';

  // Extract ID and keep a clean title
  let displayTitle = String(task.title || '').trim();
  let taskId = String(task.id || '').trim();
  const idMatch = displayTitle.match(/^\[(CB-\d+)\]\s*(.*)/);
  if (idMatch) {
    taskId = idMatch[1];
    displayTitle = idMatch[2];
  }
  if (!displayTitle) {
    displayTitle = taskId ? `Ticket ${taskId}` : 'Untitled task';
  }
  const taskIdBadge = taskId ? `<span class="task-id-badge">${escapeHtml(taskId)}</span>` : '<span class="task-id-badge">NO-ID</span>';
  const taskTitleText = escapeHtml(displayTitle || 'Untitled task');

  card.innerHTML = `
    <div class="card-top-row task-heading">
      ${taskIdBadge}
      ${priorityIcon ? `<span class="priority-dot">${priorityIcon}</span>` : ''}
      <span class="task-title-text">${taskTitleText}</span>
    </div>
    <div class="task-meta">
      <div class="task-meta-left">
        ${channelDisplay ? `<span class="task-channel-tag">${escapeHtml(channelDisplay)}</span>` : ''}
        ${agentDisplayName ? `<span class="task-agent-tag">${escapeHtml(agentDisplayName)}</span>` : ''}
      </div>
      <div class="task-meta-right">
        ${task.assigned ? `
          <div class="task-assignee ${assigneeClass}" title="${escapeHtml(agentDisplayName)}">
            <span class="assignee-icon">${assigneeInitials || '🤖'}</span>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  // Defensive fallback: never leave card header visually blank.
  const headerTitle = card.querySelector('.task-heading');
  if (headerTitle && !headerTitle.textContent.trim()) {
    headerTitle.textContent = `${taskId || task.id || 'NO-ID'} ${displayTitle || 'Untitled task'}`;
  }

  // Click to edit (but not reorder buttons)
  card.addEventListener('click', (e) => {
    if (e.target.closest('.reorder-btn')) return;
    if (colName === 'In Review') {
      openReviewDialog(task, colName);
    } else {
      openModal(task, colName);
    }
  });



  // Drag events
  card.addEventListener('dragstart', handleDragStart);
  card.addEventListener('dragend', handleDragEnd);

  return card;
}

// ─── Within-Column Reorder ──────────────────────────────────────────
function reorderTaskWithinColumn(taskId, colName, targetIndex) {
  const list = tasksData[colName];
  const idx = list.findIndex(t => t.id === taskId);
  if (idx === -1) return;

  if (targetIndex === -1) targetIndex = list.length;

  if (targetIndex > idx) targetIndex--;

  const [task] = list.splice(idx, 1);
  list.splice(targetIndex, 0, task);

  renderBoard();
  saveTasksToServer();
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ─── Drag & Drop ─────────────────────────────────────────────────────
let draggedTaskId = null;
let draggedSourceCol = null;

function handleDragStart(e) {
  draggedTaskId = this.dataset.id;
  draggedSourceCol = this.dataset.column;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.id);

  document.querySelectorAll('.board-column').forEach(col => {
    col.classList.add('potential-target');
  });
}

function handleDragEnd() {
  this.classList.remove('dragging');
  draggedTaskId = null;
  draggedSourceCol = null;

  document.querySelectorAll('.board-column').forEach(col => {
    col.classList.remove('potential-target', 'drag-over');
  });
  document.querySelectorAll('.drop-placeholder').forEach(p => p.remove());
}

function setupDragAndDrop() {
  COLUMNS.forEach(colName => {
    const containerId = `col-${colName.replace(/\s+/g, '-')}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.closest('.board-column').classList.add('drag-over');

      const afterElement = getDragAfterElement(container, e.clientY);
      let ph = container.querySelector('.drop-placeholder');
      if (!ph) {
        ph = document.createElement('div');
        ph.className = 'drop-placeholder';
      }

      if (afterElement == null) {
        container.appendChild(ph);
      } else {
        container.insertBefore(ph, afterElement);
      }
    });

    container.addEventListener('dragleave', (e) => {
      if (!container.contains(e.relatedTarget)) {
        container.closest('.board-column').classList.remove('drag-over');
        container.querySelectorAll('.drop-placeholder').forEach(p => p.remove());
      }
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      container.closest('.board-column').classList.remove('drag-over');

      const ph = container.querySelector('.drop-placeholder');
      let targetIndex = -1;

      if (ph) {
        const children = [...container.children];
        const phIndex = children.indexOf(ph);
        let cardCount = 0;
        for (let i = 0; i < phIndex; i++) {
            if (children[i].classList.contains('task-card')) cardCount++;
        }
        targetIndex = cardCount;
        ph.remove();
      }

      const taskId = e.dataTransfer.getData('text/plain');
      const sourceCol = draggedSourceCol;
      const targetCol = colName;

      if (!taskId || !sourceCol) return;
      if (sourceCol === targetCol) {
          reorderTaskWithinColumn(taskId, colName, targetIndex);
      } else {
          moveTask(taskId, sourceCol, targetCol, false, targetIndex);
      }
    });
  });
}

// ─── Move Task Between Columns ──────────────────────────────────────
function moveTask(taskId, sourceCol, targetCol, isAutoPickup = false, targetIndex = -1) {
  const sourceList = tasksData[sourceCol];
  const taskIndex = sourceList.findIndex(t => t.id === taskId);
  if (taskIndex === -1) return;

  const task = sourceList[taskIndex];

  // ═══ VALIDATION ═══
  if (sourceCol === 'Backlog' && targetCol === 'Todo') {
    if (!task.assigned) {
      const cardEl = document.querySelector(`[data-id="${taskId}"]`);
      if (cardEl) {
        cardEl.classList.add('shake');
        setTimeout(() => cardEl.classList.remove('shake'), 600);
      }
      showToast('⚠️ Assign an agent before moving to To Do', 'error');
      return;
    }
  }

  // Remove from source
  sourceList.splice(taskIndex, 1);

  // Auto-update completed state
  if (targetCol === 'Done') task.completed = true;
  else if (sourceCol === 'Done') task.completed = false;

  // Add to target
  if (targetIndex >= 0 && targetIndex <= tasksData[targetCol].length) {
    tasksData[targetCol].splice(targetIndex, 0, task);
  } else {
    tasksData[targetCol].push(task);
  }

  // Resolve agent name
  const agent = openclawAgents.find(a => a.id === task.assigned || a.name === task.assigned);
  const agentName = agent ? agent.name : (task.assigned || 'Agent');

  // ═══ ACTIVITY LOG ═══
  if (isAutoPickup) {
    addActivity('🤖', `${agentName} picked up "${task.title}" and started working`);
  } else if (targetCol === 'Todo') {
    addActivity('🎯', `"${task.title}" assigned to ${agentName} — ready for pickup`);
  } else if (targetCol === 'In Progress' && sourceCol === 'In Review') {
    addActivity('🔄', `"${task.title}" sent back to ${agentName} for changes`);
  } else if (targetCol === 'In Review') {
    addActivity('👀', `${agentName} completed "${task.title}" — awaiting your review`);
  } else if (targetCol === 'Done') {
    addActivity('✅', `"${task.title}" approved and marked done`);
  } else if (targetCol === 'Backlog') {
    addActivity('📋', `"${task.title}" moved back to backlog`);
  }

  // ═══ RENDER ═══
  renderBoard();
  renderAgentSidebar();

  // ═══ ANIMATIONS ═══
  // Drop bounce on new position
  setTimeout(() => {
    const newCard = document.querySelector(`[data-id="${taskId}"]`);
    if (newCard) {
      newCard.classList.add('just-dropped');
      setTimeout(() => newCard.classList.remove('just-dropped'), 600);
    }
  }, 50);

  // Particle burst for Done
  if (targetCol === 'Done') {
    setTimeout(() => {
      const cardEl = document.querySelector(`[data-id="${taskId}"]`);
      if (cardEl) {
        const rect = cardEl.getBoundingClientRect();
        spawnParticles(rect.left + rect.width / 2, rect.top + rect.height / 2, 'hsl(155, 65%, 45%)');
      }
    }, 100);
  }

  // ═══ DISCORD NOTIFICATION ═══
  notifyDiscord(task, sourceCol, targetCol);

  // ═══ SAVE ═══
  saveTasksToServer();

  // ═══ AGENT AUTO-PICKUP ═══
  if (!isAutoPickup) {
    if (!canAutoInvokeAgents()) {
      if (targetCol === 'Todo') {
        showToast('Task queued. Agent auto-start is off for safety.', 'info');
      } else if (targetCol === 'In Progress') {
        showToast('Task marked In Progress. Agent auto-start is off.', 'info');
        addActivity('🛡️', `Auto-start skipped for "${task.title}"`);
      }
      return;
    }
    if (targetCol === 'Todo') {
      scheduleAutoPickupFromTodo(task);
    } else if (targetCol === 'In Progress') {
      scheduleAgentPickup(task);
    }
  }
}

// ─── Agent Invocation ────────────────────────────────────────────────
function isAgentBusy(agentId) {
  if (!agentId) return false;
  return (tasksData['In Progress'] || []).some(t => t.assigned === agentId);
}

function scheduleAutoPickupFromTodo(task) {
  if (!canAutoInvokeAgents()) return;
  if (!task.assigned) return;

  const agent = openclawAgents.find(a => a.id === task.assigned || a.name === task.assigned);
  const agentName = agent ? agent.name : task.assigned;

  if (isAgentBusy(task.assigned)) {
    showToast(`${agentName} is busy — task queued`, 'info');
    addActivity('⏳', `"${task.title}" queued for ${agentName}`);
    return;
  }

  showToast(`${agentName} will pick this up in a moment`, 'info');

  setTimeout(() => {
    const stillQueued = (tasksData['Todo'] || []).some(t => t.id === task.id);
    if (!stillQueued || isAgentBusy(task.assigned)) return;

    playClaw(task.id);
    setTimeout(() => {
      const pickupTask = (tasksData['Todo'] || []).find(t => t.id === task.id);
      if (!pickupTask) return;
      moveTask(task.id, 'Todo', 'In Progress', true);
      scheduleAgentPickup(pickupTask);
    }, 700);
  }, 2000);
}

async function scheduleAgentPickup(task) {
  if (!canAutoInvokeAgents()) return;
  if (!task.assigned) return;

  const agent = openclawAgents.find(a => a.id === task.assigned || a.name === task.assigned);
  const agentName = agent ? agent.name : task.assigned;

  showToast(`🎯 Waking up ${agentName} to process task...`, 'info');
  addActivity('🤖', `Triggered ${agentName} to pick up "${task.title}"`);

  try {
    const res = await fetch('/api/invoke-agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: task.id,
        agentId: task.assigned,
        title: task.title,
        details: task.details || '',
        channel: task.channel || ''
      })
    });

    if (!res.ok) throw new Error('Failed to invoke agent');
    showToast(`🚀 ${agentName} is booting up!`, 'success');
  } catch (err) {
    console.error('Agent invocation failed:', err);
    showToast(`❌ Failed to wake up ${agentName}`, 'error');
  }
}

// ─── Claw Animation ─────────────────────────────────────────────────
function playClaw(taskId) {
  const cardEl = document.querySelector(`[data-id="${taskId}"]`);
  if (!cardEl) return;

  const rect = cardEl.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const targetY = rect.top;

  // Apply pickup animation to card
  cardEl.classList.add('picked-up');
  setTimeout(() => cardEl.classList.remove('picked-up'), 1200);

  // Spawn particles
  spawnParticles(centerX, targetY, 'hsl(275, 80%, 60%)');
}

// ─── Particle Effect ─────────────────────────────────────────────────
function spawnParticles(x, y, color) {
  const count = 14;
  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.background = color;
    particle.style.setProperty('--px', `${(Math.random() - 0.5) * 140}px`);
    particle.style.setProperty('--py', `${(Math.random() - 0.5) * 140}px`);
    particle.style.animation = `particleBurst 0.7s ${Math.random() * 0.2}s var(--ease-out) forwards`;
    document.body.appendChild(particle);
    setTimeout(() => particle.remove(), 1000);
  }
}

// ─── Review Dialog ──────────────────────────────────────────────────
function openReviewDialog(task, colName) {
  reviewingTask = task;
  reviewingCol = colName;

  const agent = openclawAgents.find(a => a.id === task.assigned)?.name || task.assigned || 'Agent';
  const priority = task.priority || 'medium';
  reviewTaskInfo.innerHTML = `
    <div class="review-form-layout">
      <div class="review-form-sidebar">
        <div class="review-meta-block">
          <span class="review-meta-label">Title</span>
          <h4>${escapeHtml(task.title || 'Untitled task')}</h4>
        </div>
        <div class="review-meta-block">
          <span class="review-meta-label">Agent</span>
          <span class="task-agent-tag">${escapeHtml(agent)}</span>
        </div>
        <div class="review-meta-block">
          <span class="review-meta-label">Priority</span>
          <span class="task-channel-tag">${escapeHtml(priority)}</span>
        </div>
        <div class="review-meta-block">
          <span class="review-meta-label">Channel</span>
          <span class="task-channel-tag">${escapeHtml(task.channel || 'No channel')}</span>
        </div>
      </div>

      <div class="review-form-description">
        <label>Description</label>
        <textarea readonly>${escapeHtml(task.details || 'No description')}</textarea>
      </div>
    </div>
  `;
  reviewFeedback.value = '';
  reviewDialog.showModal();
}

function handleReview(approved) {
  if (!reviewingTask || !reviewingCol) return;

  if (approved) {
    moveTask(reviewingTask.id, reviewingCol, 'Done');
    showToast('✅ Task approved and marked as done!', 'success');
  } else {
    const feedback = reviewFeedback.value.trim();
    if (feedback) {
      reviewingTask.details = (reviewingTask.details || '') + ` | Review feedback: ${feedback}`;
    }
    moveTask(reviewingTask.id, reviewingCol, 'In Progress');
    showToast('🔄 Task sent back to agent with feedback', 'info');
  }

  reviewDialog.close();
  reviewingTask = null;
  reviewingCol = null;
}

// ─── Modal (Create/Edit) ────────────────────────────────────────────
function openModal(task = null, colName = '') {
  if (task) {
    modalTitleText.textContent = 'Edit Task';
    inputId.value = task.id;
    inputCol.value = colName;
    inputTitle.value = task.title || '';
    inputDetails.value = task.details || '';
    inputAssigned.value = task.assigned || '';
    inputPriority.value = task.priority || 'medium';
    deleteModalBtn.style.display = 'block';
  } else {
    modalTitleText.textContent = 'New Task';
    inputId.value = '';
    inputCol.value = 'Backlog';
    inputTitle.value = '';
    inputDetails.value = '';
    inputAssigned.value = '';
    inputPriority.value = 'medium';
    deleteModalBtn.style.display = 'none';
  }

  dialog.showModal();
}

function saveTask(e) {
  e.preventDefault();

  const id = inputId.value;
  const col = inputCol.value;
  const title = inputTitle.value.trim();
  const details = inputDetails.value.trim();
  const assigned = inputAssigned.value;
  const priority = inputPriority.value;

  // Auto-resolve channel from agent bindings
  let channel = '';
  if (assigned) {
    const binding = openclawChannels.find(b => b.agentId === assigned);
    if (binding) channel = binding.channelId;
  }

  if (!title) return;

  if (id) {
    // Update existing
    const taskList = tasksData[col];
    const task = taskList.find(t => t.id === id);
    if (task) {
      task.title = title;
      task.details = details;
      task.assigned = assigned;
      task.channel = channel;
      task.priority = priority;
    }
  } else {
    // Create new — always to Backlog
    const newTask = {
      id: 'task_' + Math.random().toString(36).substring(2, 9),
      title, details, assigned, channel, priority,
      completed: false,
      createdAt: new Date().toISOString()
    };
    tasksData['Backlog'].push(newTask);
    showToast(`📋 "${title}" added to Backlog`, 'success');
    addActivity('📋', `New task created: "${title}"`);
  }

  renderBoard();
  saveTasksToServer();
  renderAgentSidebar();
  dialog.close();
}

function deleteTask() {
  const id = inputId.value;
  const col = inputCol.value;
  if (!id || !col) return;

  if (confirm('Delete this task permanently?')) {
    const list = tasksData[col];
    const idx = list.findIndex(t => t.id === id);
    if (idx !== -1) {
      const task = list[idx];
      list.splice(idx, 1);
      renderBoard();
      saveTasksToServer();
      showToast('🗑️ Task deleted', 'info');
      addActivity('🗑️', `Deleted: "${task.title}"`);
    }
    dialog.close();
  }
}

// ─── Toast Notifications ─────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('exit');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ─── Utilities ──────────────────────────────────────────────────────
function cleanChannel(channel) {
  if (!channel) return '';
  let cleaned = channel.replace(/[\*\`\s]+/g, '').trim();
  if (cleaned && !cleaned.startsWith('#')) cleaned = '#' + cleaned;
  return cleaned;
}

function findTask(taskId) {
  for (const col of COLUMNS) {
    const task = tasksData[col].find(t => t.id === taskId);
    if (task) return task;
  }
  return null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/'/g, '&#39;');
}
