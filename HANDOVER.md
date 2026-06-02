# ClawBoard — Handover Notes

## Current State

Updated on 2026-05-29.

### Agent Auto-Pickup
- When a task moves to "To Do", the system checks if the assigned agent is idle (no tasks in "In Progress")
- If idle: agent automatically picks up the task after ~2 seconds with claw animation + particle effects, then moves it to "In Progress"
- If busy: task stays in "To Do" with a toast "Agent is busy — task queued"
- Discord notification is sent for both the assignment AND the pickup (two separate notifications)
- Activity feed entry: "🤖 Agent Name picked up 'Task Title' and started working"
- The backend agent is invoked only after the card is visibly in "In Progress"

### Agent Routing

- Agent work replies are delivered to the assigned agent's Discord channel.
- Board lifecycle/status notifications are sent to `BOARD_CHANNEL_ID` when configured, with the task channel as fallback.
- The setup banner flags missing OpenClaw config, agent bindings, Discord token, and board channel settings.
- The setup dialog shows a first-run checklist and the resolved OpenClaw paths.
- Agent model selection is available from the sidebar and persists to `openclaw.json`.

### Open-Source Readiness

- No personal Discord channel IDs are hardcoded in tracked source.
- No local user paths are hardcoded in tracked source.
- Board status routing uses `BOARD_CHANNEL_ID` or the task channel fallback.
- Domain-specific workflows should live outside the core app as optional extensions.
- GitHub positioning should target OpenClaw users looking for a self-hosted Kanban board for planning, assigning, and reviewing agent work.

### Verification

- `node --check app.js` passed.
- `node --check server.js` passed.
- Isolated temp server verified `/api/task-status` and `/api/task-details` without touching the real board or posting Discord messages.

## Earlier UI Fixes

### Within-Column Reorder Fixed
- Reorder arrows (▲/▼) are now always visible (opacity 0.5, full opacity on hover)
- Buttons have proper styling: background, border, 28×24px hit area
- Added `type="button"` and `e.preventDefault()` to prevent any form submission interference
- Toast notification on reorder: "↕️ Task reordered"

### Larger Card Shape
- Card padding increased from 12px to 16×18px
- Card border-radius upgraded to `radius-md` (10px)
- Title font size: 0.85rem → 0.92rem
- Description line-clamp: 2 → 3 lines, font size 0.78rem
- Gap between card elements: 8px → 10px
- Min-height: 90px
- Added `card-top-row` wrapper with right padding for reorder arrows
- Priority dot emoji shown inline with title

### Removed "Mark as Completed"
- Removed the checkbox group from `index.html`
- Removed all `inputCompleted`/`completedGroup` references from `app.js`
- Tasks are only marked complete when moved to the Done column

### Activity Feed Updates
- New "⚡ Board Activity" section in sidebar with local activity log
- Events logged: task created, assigned, agent pickup, review requested, approved, rejected, deleted
- Each entry shows emoji + message + timestamp
- Persisted in localStorage (up to 50 entries)
- Separate "📝 Workspace Logs" section still shows file-based memory

### Bonus: Agent Status Badges
- Sidebar shows "Working" (amber) or "Idle" (gray) badge per agent
- Agent pulse dot only glows green when the agent has tasks in progress
- Agent name tag (purple) shown on each card alongside the channel tag
