const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME_DIR = process.env.HOME || os.homedir();
const DEFAULT_CLAWBOARD_CONFIG = path.join(HOME_DIR, '.openclaw', 'clawboard.json');
const LOCAL_CLAWBOARD_CONFIG = path.join(__dirname, '.clawboard.json');
const CLAWBOARD_CONFIG = process.env.CLAWBOARD_CONFIG
  || (fs.existsSync(LOCAL_CLAWBOARD_CONFIG) ? LOCAL_CLAWBOARD_CONFIG : DEFAULT_CLAWBOARD_CONFIG);
let clawboardConfig = readJsonFile(CLAWBOARD_CONFIG) || {};
const PORT = Number(process.env.PORT || 52837);
const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || clawboardConfig.openclawConfig || path.join(HOME_DIR, '.openclaw', 'openclaw.json');
const KANBAN_PATH = process.env.KANBAN_PATH || clawboardConfig.kanbanPath || path.join(HOME_DIR, '.openclaw', 'workspace', 'KANBAN.md');
const MEMORY_DIR = process.env.MEMORY_DIR || clawboardConfig.memoryDir || path.join(path.dirname(KANBAN_PATH), 'memory');
const ENV_BOARD_CHANNEL_ID = process.env.BOARD_CHANNEL_ID || '';
const ENV_AUTO_INVOKE_AGENTS = process.env.CLAWBOARD_AUTO_INVOKE_AGENTS;
let runtimeBoardChannelId = ENV_BOARD_CHANNEL_ID || clawboardConfig.boardChannelId || clawboardConfig.discord?.boardChannelId || '';

function readBooleanFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

const AUTO_INVOKE_AGENTS = ENV_AUTO_INVOKE_AGENTS !== undefined
  ? readBooleanFlag(ENV_AUTO_INVOKE_AGENTS)
  : clawboardConfig.autoInvokeAgents !== false;

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read ${filePath}:`, err.message);
    }
    return null;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normalizeBoardChannelId(channelId) {
  return String(channelId || '').trim().replace(/^#/, '');
}

function setBoardChannelId(channelId) {
  const normalized = normalizeBoardChannelId(channelId);
  if (normalized && !/^\d{10,25}$/.test(normalized)) {
    throw new Error('Board channel ID must be numeric Discord channel ID');
  }

  clawboardConfig = readJsonFile(CLAWBOARD_CONFIG) || {};
  if (normalized) {
    clawboardConfig.boardChannelId = normalized;
  } else {
    delete clawboardConfig.boardChannelId;
    if (clawboardConfig.discord) {
      delete clawboardConfig.discord.boardChannelId;
      if (Object.keys(clawboardConfig.discord).length === 0) {
        delete clawboardConfig.discord;
      }
    }
  }
  writeJsonFile(CLAWBOARD_CONFIG, clawboardConfig);
  runtimeBoardChannelId = normalized;

  return normalized;
}

function defaultKanbanMarkdown() {
  return stringifyMarkdown({
    'Backlog': [],
    'Todo': [],
    'In Progress': [],
    'In Review': [],
    'Done': []
  });
}

function ensureKanbanFile() {
  if (fs.existsSync(KANBAN_PATH)) return;
  fs.mkdirSync(path.dirname(KANBAN_PATH), { recursive: true });
  fs.writeFileSync(KANBAN_PATH, defaultKanbanMarkdown(), 'utf8');
}

function findTaskLocation(columns, taskId) {
  for (const [column, tasks] of Object.entries(columns)) {
    const task = (tasks || []).find(t => t.id === taskId);
    if (task) return { column, task };
  }
  return null;
}

// ─── OpenClaw Config Reader ────────────────────────────────────────────
let openclawConfig = null;

function loadOpenClawConfig() {
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG, 'utf8');
    openclawConfig = JSON.parse(raw);
    return openclawConfig;
  } catch (err) {
    console.error('Failed to read openclaw.json:', err.message);
    return null;
  }
}

function saveOpenClawConfig(config) {
  writeJsonFile(OPENCLAW_CONFIG, config);
  openclawConfig = config;
}

function getAgentPrimaryModel(agent, config) {
  if (typeof agent.model === 'string') return agent.model;
  return agent.model?.primary || config.agents?.defaults?.model?.primary || 'unknown';
}

function getAvailableModels(config = loadOpenClawConfig()) {
  const models = new Set();
  if (!config?.agents) return [];

  const defaultPrimary = config.agents.defaults?.model?.primary;
  if (defaultPrimary) models.add(defaultPrimary);

  for (const modelId of Object.keys(config.agents.defaults?.models || {})) {
    if (modelId) models.add(modelId);
  }

  for (const agent of config.agents.list || []) {
    const primary = getAgentPrimaryModel(agent, config);
    if (primary && primary !== 'unknown') models.add(primary);
    const fallbacks = typeof agent.model === 'object' ? agent.model?.fallbacks || [] : [];
    for (const fallback of fallbacks) {
      if (fallback) models.add(fallback);
    }
  }

  return Array.from(models).sort((a, b) => a.localeCompare(b));
}

function getAgents() {
  const config = loadOpenClawConfig();
  if (!config || !config.agents || !config.agents.list) return [];
  return config.agents.list.map(agent => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace || '',
    model: getAgentPrimaryModel(agent, config)
  }));
}

function setAgentModel(agentId, model) {
  const nextModel = String(model || '').trim();
  if (!agentId || !nextModel) {
    throw new Error('agentId and model are required');
  }

  const config = loadOpenClawConfig();
  if (!config?.agents?.list) {
    throw new Error('OpenClaw agents are not configured');
  }

  const agent = config.agents.list.find(item => item.id === agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (typeof agent.model === 'string') {
    agent.model = nextModel;
  } else {
    agent.model = {
      ...(agent.model || {}),
      primary: nextModel
    };
  }

  saveOpenClawConfig(config);
  return {
    id: agent.id,
    name: agent.name,
    model: getAgentPrimaryModel(agent, config)
  };
}

function getDiscordChannelBindings() {
  const config = loadOpenClawConfig();
  if (!config) return [];

  const bindings = config.bindings || [];
  const guilds = config.channels?.discord?.guilds || {};
  const agents = config.agents?.list || [];

  // Build agent name lookup
  const agentLookup = {};
  agents.forEach(a => { agentLookup[a.id] = a.name; });

  const result = [];
  for (const binding of bindings) {
    if (binding.match?.channel !== 'discord') continue;
    const agentId = binding.agentId;
    const channelId = binding.match?.peer?.id;
    const guildId = binding.match?.guildId;
    if (!channelId) continue;

    result.push({
      agentId,
      agentName: agentLookup[agentId] || agentId,
      channelId,
      guildId
    });
  }
  return result;
}

function getAgentDiscordBinding(agentId) {
  return getDiscordChannelBindings().find(binding => binding.agentId === agentId) || null;
}

function getDiscordToken() {
  const config = loadOpenClawConfig();
  return config?.channels?.discord?.token || '';
}

// ─── Discord Message Sender ──────────────────────────────────────────────
function discordApiRequest(method, apiPath, payload = null) {
  const token = getDiscordToken();
  if (!token) {
    return Promise.reject(new Error('Discord token is not configured'));
  }

  const body = payload ? JSON.stringify(payload) : null;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'discord.com',
      path: `/api/v10${apiPath}`,
      method,
      headers: {
        'Authorization': `Bot ${token}`,
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        } : {})
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : {});
        } else {
          console.error(`Discord API error ${res.statusCode}:`, body);
          reject(new Error(`Discord API ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Discord Message Sender ──────────────────────────────────────────────
function sendDiscordPayload(channelId, payload) {
  if (!channelId) {
    console.log('Skipping Discord message: no channelId');
    return Promise.resolve();
  }
  return discordApiRequest('POST', `/channels/${channelId}/messages`, payload)
    .then(result => {
      console.log(`Discord message sent to channel ${channelId}`);
      return result;
    });
}

function sendDiscordMessage(channelId, embed) {
  return sendDiscordPayload(channelId, { embeds: [embed] });
}

function sendDiscordText(channelId, content) {
  const chunks = [];
  const maxLen = 1900;
  let remaining = String(content || '').trim();
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < 500) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks.reduce(
    (promise, chunk) => promise.then(() => sendDiscordPayload(channelId, { content: chunk })),
    Promise.resolve()
  );
}

function normalizeChannelId(channel) {
  return String(channel || '').trim().replace(/^#|^channel:/, '');
}

function resolveBoardChannelId(task = null, explicitChannelId = '') {
  const requested = normalizeChannelId(explicitChannelId);
  if (requested) return requested;
  if (runtimeBoardChannelId) return runtimeBoardChannelId;
  return normalizeChannelId(task?.channel);
}

function getSetupStatus() {
  const config = loadOpenClawConfig();
  const agents = config?.agents?.list || [];
  const bindings = getDiscordChannelBindings();
  const savedBoardChannelId = clawboardConfig.boardChannelId || clawboardConfig.discord?.boardChannelId || '';
  return {
    clawboardConfigPath: CLAWBOARD_CONFIG,
    openclawConfigPath: OPENCLAW_CONFIG,
    openclawConfigExists: fs.existsSync(OPENCLAW_CONFIG),
    kanbanPath: KANBAN_PATH,
    kanbanExists: fs.existsSync(KANBAN_PATH),
    memoryDir: MEMORY_DIR,
    agentsCount: agents.length,
    bindingsCount: bindings.length,
    discordTokenConfigured: Boolean(config?.channels?.discord?.token),
    boardChannelConfigured: Boolean(runtimeBoardChannelId),
    boardChannelId: runtimeBoardChannelId,
    savedBoardChannelId,
    envBoardChannelIdConfigured: Boolean(ENV_BOARD_CHANNEL_ID),
    autoInvokeAgents: AUTO_INVOKE_AGENTS,
    envAutoInvokeAgentsConfigured: ENV_AUTO_INVOKE_AGENTS !== undefined,
    availableModels: getAvailableModels(config)
  };
}

// ─── KANBAN.md Parser (5 columns) ──────────────────────────────────────
function parseMarkdown(md) {
  const lines = md.split('\n');
  const columns = {
    'Backlog': [],
    'Todo': [],
    'In Progress': [],
    'In Review': [],
    'Done': []
  };
  let currentColumn = null;
  let currentTask = null;
  let captureDetailsBlock = false;
  let detailsBlockLines = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (captureDetailsBlock && currentTask) {
      const isNextMetaBullet = /^(\s*)\*\s+\*[^*]+:\*/.test(line);
      const isNewTaskLine = /^(\s*)\*\s+\[[ xX]\]\s+/.test(line);
      const isNewSection = line.startsWith('## ') || line.trim() === '---';
      const isBlockContentLine = /^ {4,}|\t/.test(line) || line.trim() === '';

      if (!isNextMetaBullet && !isNewTaskLine && !isNewSection && isBlockContentLine) {
        const detailLine = line.replace(/^ {4}/, '').replace(/^\t/, '');
        detailsBlockLines.push(detailLine);
        continue;
      }

      currentTask.details = detailsBlockLines.join('\n').replace(/\s+$/g, '');
      captureDetailsBlock = false;
      detailsBlockLines = [];
    }
    if (line.startsWith('## ')) {
      const heading = trimmed.substring(3).trim().toLowerCase();
      if (heading.includes('progress')) {
        currentColumn = 'In Progress';
      } else if (heading.includes('review')) {
        currentColumn = 'In Review';
      } else if (heading.includes('to do') || heading.includes('todo')) {
        currentColumn = 'Todo';
      } else if (heading.includes('backlog')) {
        currentColumn = 'Backlog';
      } else if (heading.includes('done')) {
        currentColumn = 'Done';
      } else {
        currentColumn = null;
      }
      currentTask = null;
      continue;
    }

    if (!currentColumn) continue;

    const taskMatch = line.match(/^(\s*)\*\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      const completed = taskMatch[2].toLowerCase() === 'x';
      let title = taskMatch[3].trim();
      if (title.startsWith('**') && title.endsWith('**')) {
        title = title.slice(2, -2);
      } else {
        title = title.replace(/\*\*(.*?)\*\*/g, '$1');
      }

      let taskId = '';
      const idMatch = title.match(/^\[(CB-\d+)\]\s+(.*)/);
      if (idMatch) {
        taskId = idMatch[1];
      } else {
        taskId = 'CB-' + Math.floor(Math.random() * 9000 + 1000);
        title = `[${taskId}] ${title}`;
      }

      currentTask = {
        id: taskId,
        title,
        completed,
        details: '',
        assigned: '',
        channel: '',
        priority: 'medium',
        createdAt: new Date().toISOString()
      };
      columns[currentColumn].push(currentTask);
      continue;
    }

    if (currentTask && (line.startsWith(' ') || line.startsWith('\t'))) {
      const subTrimmed = trimmed;
      if (subTrimmed.startsWith('*')) {
        const content = subTrimmed.substring(1).trim();
        const lower = content.toLowerCase();
        if (lower.startsWith('*status:*') || lower.startsWith('*details:*')) {
          const detailsValue = extractValue(content);
          if (lower.startsWith('*details:*') && detailsValue === '|') {
            captureDetailsBlock = true;
            detailsBlockLines = [];
            currentTask.details = '';
          } else {
            currentTask.details = detailsValue.replace(/\\n/g, '\n');
          }
        } else if (lower.startsWith('*assigned:*')) {
          currentTask.assigned = extractValue(content);
        } else if (lower.startsWith('*channel:*')) {
          currentTask.channel = cleanChannel(extractValue(content));
        } else if (lower.startsWith('*priority:*')) {
          currentTask.priority = extractValue(content);
        } else {
          let detailLine = content;
          if (detailLine.startsWith('*') && detailLine.endsWith('*')) {
            detailLine = detailLine.slice(1, -1);
          }
          currentTask.details = currentTask.details
            ? (currentTask.details + ' | ' + detailLine)
            : detailLine;
        }
      }
    }
  }

  if (captureDetailsBlock && currentTask) {
    currentTask.details = detailsBlockLines.join('\n').replace(/\s+$/g, '');
  }

  return columns;
}

function extractValue(content) {
  let val = content.substring(content.indexOf(':') + 1).trim();
  if (val.startsWith('*')) val = val.substring(1).trim();
  if (val.endsWith('*')) val = val.substring(0, val.length - 1).trim();
  return val;
}

function cleanChannel(channel) {
  if (!channel) return '';
  let cleaned = channel.replace(/[\*\`\s]+/g, '').trim();
  if (cleaned && !cleaned.startsWith('#')) cleaned = '#' + cleaned;
  return cleaned;
}

// ─── KANBAN.md Serializer (5 columns) ──────────────────────────────────
function stringifyMarkdown(columns) {
  let md = `# 🌌 ClawBoard — OpenClaw Agent Kanban\n\n`;
  md += `> Managed by ClawBoard. Tasks sync between this file and the board UI.\n\n`;
  md += `---\n\n`;

  const colHeadings = {
    'In Progress': '## 🚀 In Progress\n*Agent is actively working on these.*\n\n',
    'Todo': '## ⏳ To Do\n*Tasks assigned to agents, ready for pickup.*\n\n',
    'Backlog': '## 📋 Backlog & Ideas\n*Parking lot — future tasks and brainstorms.*\n\n',
    'In Review': '## 👀 In Review\n*Agent has completed work and is requesting your review.*\n\n',
    'Done': '## ✅ Done\n*Completed and approved tasks.*\n\n'
  };

  for (let col of ['In Progress', 'In Review', 'Todo', 'Backlog', 'Done']) {
    md += colHeadings[col];
    const tasks = columns[col] || [];
    if (tasks.length === 0) {
      md += `* No tasks in this column.\n`;
    } else {
      for (let task of tasks) {
        const check = task.completed ? 'x' : ' ';
        md += `* [${check}] **${task.title}**\n`;
        if (task.details) {
          if (task.details.includes('\n')) {
            md += `  * *Details:* |\n`;
            for (const line of task.details.split('\n')) {
              md += `    ${line}\n`;
            }
          } else {
            md += `  * *Details:* ${task.details}\n`;
          }
        }
        if (task.assigned) {
          md += `  * *Assigned:* ${task.assigned}\n`;
        }
        if (task.channel) {
          md += `  * *Channel:* ${task.channel}\n`;
        }
        if (task.priority && task.priority !== 'medium') {
          md += `  * *Priority:* ${task.priority}\n`;
        }
      }
    }
    md += `\n---\n\n`;
  }

  return md;
}

function loadColumnsFromDisk() {
  const data = fs.readFileSync(KANBAN_PATH, 'utf8');
  return parseMarkdown(data);
}

function saveColumnsToDisk(columns) {
  fs.writeFileSync(KANBAN_PATH, stringifyMarkdown(columns), 'utf8');
}

function cleanTaskTitle(title) {
  return String(title || '').replace(/^\[(CB-\d+)\]\s*/, '').trim();
}

function flattenTasks(columns) {
  const rows = [];
  for (const col of Object.keys(columns)) {
    for (const task of columns[col] || []) {
      rows.push({ ...task, column: col, cleanTitle: cleanTaskTitle(task.title) });
    }
  }
  return rows;
}

function moveTaskToStatus(id, status, updates = {}) {
  const columns = loadColumnsFromDisk();
  let targetTask = null;
  let fromCol = null;

  for (const [colName, tasks] of Object.entries(columns)) {
    const idx = tasks.findIndex(t => t.id === id);
    if (idx !== -1) {
      targetTask = tasks[idx];
      fromCol = colName;
      tasks.splice(idx, 1);
      break;
    }
  }

  if (!targetTask) {
    throw new Error(`Task ${id} not found`);
  }

  Object.assign(targetTask, updates);
  if (!columns[status]) columns[status] = [];
  columns[status].push(targetTask);
  saveColumnsToDisk(columns);
  return { task: targetTask, fromCol, toCol: status };
}

function getAgentChannelId(agentId, fallback = '') {
  const binding = getAgentDiscordBinding(agentId);
  return binding?.channelId || String(fallback || '').replace(/^#|^channel:/, '');
}

function buildAgentFailureEmbed(task, agentId, reason) {
  return {
    title: 'ClawBoard agent failed to start',
    description: `I tried to start **${cleanTaskTitle(task.title)}** (${task.id}) for \`${agentId}\`, but OpenClaw returned an error before the agent could post deliverables.`,
    color: 0xDA3633,
    fields: [
      { name: 'Task', value: `${task.id} | ${cleanTaskTitle(task.title)}`, inline: false },
      { name: 'Reason', value: String(reason || 'Unknown error').slice(0, 950), inline: false },
      { name: 'Next step', value: 'Check OpenClaw model/auth status, then say `work on ' + task.id + '` again.', inline: false }
    ],
    footer: { text: `ClawBoard • ${new Date().toLocaleString()}` },
    timestamp: new Date().toISOString()
  };
}

// ─── Status Change Embeds ────────────────────────────────────────────────
function buildStatusEmbed(task, fromCol, toCol) {
  const colorMap = {
    'Todo': 0x9B59FF,       // electric purple
    'In Progress': 0xF5A623, // amber
    'In Review': 0x00BCD4,  // cyan
    'Done': 0x2ECC71,       // green
    'Backlog': 0x546E7A     // slate
  };

  const emojiMap = {
    'Todo': '🎯',
    'In Progress': '⚡',
    'In Review': '👀',
    'Done': '✅',
    'Backlog': '📋'
  };

  const titleMap = {
    'Todo': `${emojiMap.Todo} Task Ready for Pickup`,
    'In Progress': `${emojiMap['In Progress']} Agent Started Working`,
    'In Review': `${emojiMap['In Review']} Review Requested`,
    'Done': `${emojiMap.Done} Task Approved & Done`,
    'Backlog': `${emojiMap.Backlog} Task Returned to Backlog`
  };

  let description = '';
  const port = process.env.PORT || PORT;
  const curlCmd = (status) => `curl -X POST -H 'Content-Type: application/json' http://localhost:${port}/api/task-status -d '{"id": "${task.id}", "status": "${status}"}'`;

  if (toCol === 'Todo') {
    description = `Task **${task.title}** (ID: ${task.id}) is ready. (Agent: Do not edit KANBAN.md directly. To move this to In Progress, run: \`${curlCmd('In Progress')}\`)`;
  } else if (toCol === 'In Progress') {
    if (fromCol === 'In Review') {
      description = `Task **${task.title}** (ID: ${task.id}) was sent back. (Agent: When done, run: \`${curlCmd('In Review')}\`)`;
    } else {
      description = `Agent started working on **${task.title}**. (Agent: When done, run: \`${curlCmd('In Review')}\`)`;
    }
  } else if (toCol === 'In Review') {
    description = `Agent has completed **${task.title}** and requested review.`;
  } else if (toCol === 'Done') {
    description = `Task **${task.title}** is approved and Done! 🎉`;
  } else if (toCol === 'Backlog') {
    description = `Task **${task.title}** moved to backlog.`;
  }

  return {
    title: titleMap[toCol] || `📌 Task Status Update`,
    description,
    color: colorMap[toCol] || 0x546E7A,
    fields: [
      { name: 'Task', value: task.title, inline: true },
      { name: 'Status', value: `${fromCol} → ${toCol}`, inline: true },
      { name: 'Agent', value: task.assigned || 'Unassigned', inline: true }
    ],
    footer: { text: `ClawBoard • ${new Date().toLocaleString()}` },
    timestamp: new Date().toISOString()
  };
}

function invokeAgentForTask({ taskId, agentId, title, details = '', channel = '' }) {
  if (!AUTO_INVOKE_AGENTS) {
    throw new Error('Agent auto-start is disabled. Set CLAWBOARD_AUTO_INVOKE_AGENTS=true or autoInvokeAgents: true in clawboard.json to enable it.');
  }
  const port = process.env.PORT || PORT;
  const replyChannelId = getAgentChannelId(agentId, channel || runtimeBoardChannelId);
  const replyTo = `channel:${replyChannelId}`;
  const sessionKey = `${agentId}:task-${taskId}`;
  const task = { id: taskId, title, details, assigned: agentId, channel: `#${replyChannelId}` };
  const detailBlock = details ? `\n\nCurrent task details:\n${details}` : '';
  const message = `You have a new ClawBoard task: "${title}" (ID: ${taskId}).${detailBlock}

Workflow rules:
- You are the assigned agent: ${agentId}.
- Work ticket-scoped: do not mix this ticket's files, notes, or review request with any other ClawBoard ticket.
- Communicate final deliverables and review requests in your assigned Discord channel.
- Do not modify KANBAN.md manually.
- Keep all ticket status updates on ClawBoard by using the API commands below.

Task details rule:
- If you clarify or expand the work, write the updated task details back to ClawBoard so the board remains the source of truth.
- Keep markdown structure readable in details.
- Use this command:

curl -X POST -H 'Content-Type: application/json' http://localhost:${port}/api/task-details -d '{"id": "${taskId}", "details": "UPDATED_TASK_DETAILS"}'

Discord review rule:
- When you request review in Discord, clearly identify the ticket ID and title.
- If you hit a blocker, report the ticket ID, title, what is blocked, and the exact next step needed. Keep the task In Progress.

When the final requested work has been generated and posted to Discord for review, move this task to In Review:

curl -X POST -H 'Content-Type: application/json' http://localhost:${port}/api/task-status -d '{"id": "${taskId}", "status": "In Review"}'

Finally, report progress in the assigned Discord channel.`;

  console.log(`🚀 Spawning openclaw agent: ${agentId} - ${title} -> Discord ${replyTo}`);

  const child = spawn('openclaw', [
    'agent',
    '--agent', agentId,
    '--session-key', sessionKey,
    '--channel', 'discord',
    '--message', message,
    '--timeout', '1800',
    '--deliver',
    '--reply-channel', 'discord',
    '--reply-to', replyTo
  ], {
    detached: false,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on('error', err => {
    console.error('OpenClaw spawn error:', err.message);
    sendDiscordMessage(replyChannelId, buildAgentFailureEmbed(task, agentId, err.message)).catch(notifyErr => {
      console.error('Agent failure Discord notify error:', notifyErr.message);
    });
  });
  child.on('close', code => {
    if (code && code !== 0) {
      const reason = stderr.trim() || `openclaw exited with code ${code}`;
      console.error(`OpenClaw agent failed (${agentId}/${taskId}):`, reason);
      sendDiscordMessage(replyChannelId, buildAgentFailureEmbed(task, agentId, reason)).catch(notifyErr => {
        console.error('Agent failure Discord notify error:', notifyErr.message);
      });
    }
  });

  return { child, replyChannelId };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // ── API: Setup Status ──
  if (pathname === '/api/setup' && method === 'GET') {
    const setup = getSetupStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(setup));
  }
  // ── API: Save Board Channel Setting ──
  else if (pathname === '/api/settings/board-channel' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { boardChannelId = '' } = JSON.parse(body || '{}');
        const normalized = setBoardChannelId(boardChannelId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          boardChannelId: normalized,
          envBoardChannelIdConfigured: Boolean(ENV_BOARD_CHANNEL_ID)
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  // ── API: Get Tasks ──
  else if (pathname === '/api/tasks' && method === 'GET') {
    ensureKanbanFile();
    fs.readFile(KANBAN_PATH, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read KANBAN.md' }));
        return;
      }
      try {
        const columns = parseMarkdown(data);
        const newMd = stringifyMarkdown(columns);
        // If stringified version differs (e.g. new IDs injected), save it back
        if (newMd.length !== data.length && newMd !== data) {
           fs.writeFile(KANBAN_PATH, newMd, 'utf8', () => {});
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(columns));
      } catch (parseErr) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse', details: parseErr.message }));
      }
    });
  }
  // ── API: Save Tasks ──
  else if (pathname === '/api/tasks' && method === 'POST') {
    ensureKanbanFile();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const columns = JSON.parse(body);
        const md = stringifyMarkdown(columns);
        fs.writeFile(KANBAN_PATH, md, 'utf8', err => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to write KANBAN.md' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', details: err.message }));
      }
    });
  }
  // ── API: Update Single Task Details ──
  else if (pathname === '/api/task-details' && method === 'POST') {
    ensureKanbanFile();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, details } = JSON.parse(body);
        if (!id || details === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id and details required' }));
          return;
        }

        fs.readFile(KANBAN_PATH, 'utf8', (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read KANBAN.md' }));
            return;
          }

          let columns = parseMarkdown(data);
          let targetTask = null;

          for (const [colName, tasks] of Object.entries(columns)) {
            const idx = tasks.findIndex(t => t.id === id);
            if (idx !== -1) {
              targetTask = tasks[idx];
              break;
            }
          }

          if (!targetTask) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Task not found' }));
            return;
          }

          targetTask.details = details;

          const md = stringifyMarkdown(columns);
          fs.writeFile(KANBAN_PATH, md, 'utf8', err => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to write KANBAN.md' }));
              return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          });
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', details: err.message }));
      }
    });
  }
  // ── API: Update Single Task Status ──
  else if (pathname === '/api/task-status' && method === 'POST') {
    ensureKanbanFile();
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, status } = JSON.parse(body);
        if (!id || !status) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id and status required' }));
          return;
        }

        fs.readFile(KANBAN_PATH, 'utf8', (err, data) => {
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to read KANBAN.md' }));
            return;
          }

          let columns = parseMarkdown(data);
          let targetTask = null;
          let currentTargetCol = null;

          for (const [colName, tasks] of Object.entries(columns)) {
            const idx = tasks.findIndex(t => t.id === id);
            if (idx !== -1) {
              targetTask = tasks[idx];
              currentTargetCol = colName;
              tasks.splice(idx, 1);
              break;
            }
          }

          if (!targetTask) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Task not found' }));
            return;
          }

          if (!columns[status]) columns[status] = [];
          columns[status].push(targetTask);

          const md = stringifyMarkdown(columns);
          fs.writeFile(KANBAN_PATH, md, 'utf8', err => {
            if (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to write KANBAN.md' }));
              return;
            }

            const embed = buildStatusEmbed(targetTask, currentTargetCol, status);
            sendDiscordMessage(resolveBoardChannelId(targetTask), embed).catch(notifyErr => {
              console.error('Board status notification error:', notifyErr.message);
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          });
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', details: err.message }));
      }
    });
  }
  // ── API: Get OpenClaw Agents ──
  else if (pathname === '/api/agents' && method === 'GET') {
    const agents = getAgents();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(agents));
  }
  // ── API: Get OpenClaw Models ──
  else if (pathname === '/api/models' && method === 'GET') {
    const models = getAvailableModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(models));
  }
  // ── API: Update Agent Model ──
  else if (pathname === '/api/agent-model' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { agentId, model } = JSON.parse(body);
        const agent = setAgentModel(agentId, model);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, agent }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  // ── API: Get Discord Channel Bindings ──
  else if (pathname === '/api/channels' && method === 'GET') {
    const channels = getDiscordChannelBindings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(channels));
  }
  // ── API: Send Discord Notification ──
  else if (pathname === '/api/notify' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { task, fromCol, toCol, channelId } = JSON.parse(body);
        const targetChannelId = resolveBoardChannelId(task, channelId);
        if (!targetChannelId) {
          console.log('No board channel configured; using task channel fallback if present.');
        }
        const embed = buildStatusEmbed(task, fromCol, toCol);
        await sendDiscordMessage(targetChannelId, embed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Notify error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  // ── API: Invoke Agent via CLI ──
  else if (pathname === '/api/invoke-agent' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { taskId, agentId, title, details = '', channel = '' } = JSON.parse(body);
        if (!agentId || !title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agentId and title required' }));
          return;
        }

        const { replyChannelId } = invokeAgentForTask({ taskId, agentId, title, details, channel });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, replyChannelId }));
      } catch (err) {
        console.error('Invoke agent error:', err.message);
        const statusCode = AUTO_INVOKE_AGENTS ? 500 : 403;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
  // ── API: Activity Log ──
  else if (pathname === '/api/activity' && method === 'GET') {
    fs.readdir(MEMORY_DIR, (err, files) => {
      if (err || !files || files.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dates: [], content: '', activity: 'No recent activity found.' }));
        return;
      }
      const mdFiles = files.filter(f => f.endsWith('.md')).sort();
      if (mdFiles.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ dates: [], content: '', activity: 'No recent activity found.' }));
        return;
      }
      const dates = mdFiles.map(file => file.replace(/\.md$/, '')).sort();
      const dateFrom = url.searchParams.get('dateFrom') || '';
      const dateTo = url.searchParams.get('dateTo') || '';
      const requestedDate = url.searchParams.get('date') || '';
      const inRange = (date) => {
        const day = date.slice(0, 10);
        if (requestedDate) return date === requestedDate;
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
        return true;
      };
      const selectedDates = dates.filter(inRange);
      const selectedFiles = selectedDates.map(date => `${date}.md`);
      const logReads = selectedFiles.map(file => new Promise((resolve, reject) => {
        fs.readFile(path.join(MEMORY_DIR, file), 'utf8', (readErr, data) => {
          if (readErr) reject(readErr);
          else resolve({ date: file.replace(/\.md$/, ''), content: data });
        });
      }));

      Promise.all(logReads)
        .then(logs => {
          const content = logs.map(log => log.content).join('\n\n');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ date: requestedDate || '', dateFrom, dateTo, dates, selectedDates, logs, content }));
        })
        .catch(() => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to read memory file' }));
        });
    });
  }
  // ── Static Files ──
  else {
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<h1>404 Not Found</h1>');
        } else {
          res.writeHead(500);
          res.end(`Server Error: ${err.code}`);
        }
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  ensureKanbanFile();
  console.log(`\n  🌌 ClawBoard running at http://127.0.0.1:${PORT}\n`);
  console.log(`  📋 KANBAN: ${KANBAN_PATH}`);
  console.log(`  ⚙️  Config: ${OPENCLAW_CONFIG}\n`);
  if (runtimeBoardChannelId) {
    const source = ENV_BOARD_CHANNEL_ID ? 'env' : 'config';
    console.log(`  📣 Board status channel: ${runtimeBoardChannelId} (${source})\n`);
  } else {
    console.log('  📣 Board status channel: not configured; task channels are used as fallback.\n');
  }
});
