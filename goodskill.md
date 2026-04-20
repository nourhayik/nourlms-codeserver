# Good Skills & Lessons Learned — NourLMS Code Server

## VS Code Architecture

### Client-Server Model
- VS Code web runs as a Node.js server (`remoteExtensionHostAgentServer.ts`) that serves an HTML shell (`workbench.html` / `workbench-dev.html`) with configuration injected via `<meta>` tags and `{{TEMPLATE_VARS}}`.
- **Always modify BOTH `workbench.html` AND `workbench-dev.html`** — dev mode uses `-dev.html`, production uses the regular one. Missing the dev template means changes won't appear during development.

### Workbench Contributions
- VS Code uses a contribution system (`registerWorkbenchContribution2`) with lifecycle phases (`WorkbenchPhase.AfterRestored`, etc.).
- Contributions are registered in a `.contribution.ts` file and imported from `workbench.web.main.ts`.
- Always add new contributions to the correct contribution file AND the main entry point.

### Service Injection
- VS Code uses dependency injection via decorators like `@IConfigurationService`, `@ICommandService`, etc.
- Services must be declared in the constructor with the correct decorator — the DI container resolves them automatically.

## Activity Bar & UI Hiding for Students

### Activity Bar
- The entire Activity Bar is hidden for students via `layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART)`.
- The `workbench.activityBar.location` setting is also set to `'hidden'` as a belt-and-suspenders approach.
- The Sidebar (Explorer) remains visible — `_openExplorerSidebar()` opens it on startup.
- CSS rules for individual activity bar icons are no longer needed since the whole bar is hidden.

### Blocking Layout Customization
- The "Customize Layout" dialog (`workbench.action.customizeLayout`) is blocked via the student command blacklist — students cannot toggle the activity bar, sidebar, status bar, etc. back on.
- The layout control icon (`codicon-layout`) in the title bar is hidden via CSS: `.monaco-workbench .action-item:has(.codicon-layout) { display: none !important }`.
- Additional blocked commands: `workbench.action.toggleActivityBarVisibility`, `workbench.action.toggleStatusbarVisibility`, `workbench.action.toggleAuxiliaryBar`, `workbench.action.togglePanel`, `workbench.action.toggleMenuBar`, `workbench.action.toggleSidebarVisibility`.
- Zen mode (`workbench.action.toggleZenMode`, Ctrl+K Z) is blocked — it can restore hidden parts on exit.
- Sessions-specific toggles (`agentToggleSidebarVisibility` with Ctrl+B, etc.) are also blocked.

### Blocked Commands Categories
- **Settings:** All entry points (13+ commands) — GUI, JSON, workspace, folder, accessibility, remote, keybindings.
- **Extensions:** View, install, uninstall, recommend, themes (10+ commands).
- **Terminal creation:** `new`, `createNew`, `newWithProfile`, `split`, `newWithCwd`, `newLocal`, `focusAtIndex*` — but `toggleTerminal`, `runActiveFile`, `runSelectedText` stay unblocked for students to run code.
- **Debug:** `start` (F5), `run` (Ctrl+F5), `configure`, `selectandstart` — all blocked.
- **Tasks:** `runTask`, `build`, `test`, `rerunForActiveTerminal` — all blocked.
- **AI/Copilot:** Chat open/toggle/new/manage, inline chat start/accept/discard, quickchat — all blocked.
- **Layout:** All toggle commands for activity bar, sidebar, panel, status bar, menu bar, zen mode, fullscreen, centered layout.

### Configure Editors Menu
- "Configure Editors" (`workbench.action.configureEditor`) and "Configure Tabs" (`workbench.action.configureEditorTabs`) are blocked — they open Settings which students shouldn't access.
- These appear in the 3-dot menu on the editor title bar and in the command palette.

### Sidebar Header Icons
- The settings icon in the Explorer sidebar header is hidden via CSS: `.monaco-workbench .sidebar .composite-title .actions-container .action-item:has(.codicon-settings-view-bar-icon) { display: none !important }`.

## Terminal Control

### xterm.js `disableStdin`
- `xterm.raw.options.disableStdin = true` prevents ALL keyboard input to the terminal — the shell receives nothing.
- `xterm.raw.options.disableStdin = false` restores input.
- Access xterm via `instance.xtermReadyPromise` (async) or `instance.xterm` (may be undefined if not ready yet).

### Allowing Input Only During Code Execution
- Intercept both `instance.sendText()` and `instance.sendPath()` — when an extension (Java runner, Python, Code Runner, etc.) sends a command to the terminal, temporarily re-enable stdin.
- **CRITICAL: `instance.onExit` only fires when the PTY shell process (bash) exits, NOT when an individual command like `python script.py` finishes.** Never rely on `onExit` to detect command completion — use it only for cleanup when the terminal is destroyed.
- Use `CommandDetectionCapability.onCommandFinished` (from shell integration) to detect when each individual command completes → re-disable stdin.
- As a fallback, use `PartialCommandDetectionCapability.onCommandFinished` which fires on Enter key presses.
- Subscribe via `instance.capabilities.onDidAddCommandDetectionCapability()` for late-added capabilities, AND check `instance.capabilities.get(TerminalCapability.CommandDetection)` for already-available ones.
- Each terminal instance gets its own closure with its own `commandRunning` flag — instances are fully isolated.
- `terminal.integrated.shellIntegration.enabled: true` must be set in student settings to ensure `CommandDetectionCapability` is available for reliable command-completion detection.

### sendText Signature
- The full signature is `sendText(text: string, shouldExecute: boolean, bracketedPasteMode?: boolean)`.
- When monkey-patching, pass through ALL parameters: `originalSendText(text, shouldExecute ?? true, bracketedPasteMode)`.
- Dropping `bracketedPasteMode` causes multiline text to be misinterpreted as keybindings.

## Configuration Settings

### Not All Settings Are Registered
- `configurationService.updateValue(key, value)` throws an error notification if the setting key is not registered in any schema.
- `github.copilot.enable` is only registered when the Copilot extension is installed and loaded. Using it before that causes an error toast.
- **`chat.disableAIFeatures: true`** is a built-in VS Code setting that acts as a master kill switch for all AI features (Copilot Chat, inline suggestions, etc.). Always prefer this over extension-specific settings.

### Try/Catch Pattern
```typescript
const tryUpdate = (key: string, value: any) => {
    try { this.configurationService.updateValue(key, value); } catch { /* ignore */ }
};
```
This prevents error notifications for settings that may not be registered yet.

## HTTP Server & Auth

### Resource Isolation for Students
- The `vscode-remote-resource` endpoint serves files from the filesystem (themes, extensions, workspace files).
- Student workspace isolation must only restrict paths **inside the workspaces directory** — not the VS Code installation directory. Otherwise, themes, icons, and extensions fail to load (403 errors).
- Pattern: `if (path.startsWith(workspacesDir)) { check student access } else { allow }`

### Cookie-Based Session
- Session cookies are encrypted with AES-256-GCM, stored as `nourlms.session`.
- The server middleware decrypts the cookie on every request and attaches `req.__nourlmsSession`.
- The `_handleRoot` method reads this session and injects user info into the workbench HTML.

## Build System

### Compilation
- `npm run compile` runs `gulp compile` which compiles TypeScript to `out/`.
- Always recompile after changes — the server runs from `out/`, not `src/`.
- The dev HTML template (`workbench-dev.html`) is served as-is (not compiled).

### Pre-commit Hooks
- The project has a hygiene pre-commit hook that checks formatting, ESLint rules, and import patterns.
- Key rules: no `document.xxx` — use `mainWindow.document.xxx` instead (multi-window support).
- No `any` type casts without justification.
- Import patterns restrict which modules can be imported from browser code vs node code.
- Use `--no-verify` only for pre-existing warnings, never for new violations.

### Formatting
- Use `node -e "import('./build/lib/formatter.ts').then(m => ...)"` to format files with the project's own formatter.
- `npx gulp hygiene --skip unknown` checks formatting without committing.

## CSS Selectors Reference

| Element | Selector |
|---------|----------|
| Menu bar | `.monaco-workbench .part.titlebar > .titlebar-container > .titlebar-left > .menubar` |
| Settings view bar icon (sidebar) | `.monaco-workbench .sidebar .composite-title .actions-container .action-item:has(.codicon-settings-view-bar-icon)` |
| Configure Layout icon (anywhere) | `.monaco-workbench .action-item:has(.codicon-layout)` |
| Account icon | `.monaco-workbench .activitybar .action-item:has(.codicon-account)` |
| Copilot icon | `.monaco-workbench .activitybar .action-item:has(.codicon-chat-sparkle)` |
| Activity bar (entire) | Hide via `layoutService.setPartHidden(true, Parts.ACTIVITYBAR_PART)` + setting `workbench.activityBar.location` to `'hidden'` |
| Secondary sidebar (Copilot Chat) | `.monaco-workbench .auxiliarybar` |
| Status bar | Hide via `layoutService.setPartHidden(true, Parts.STATUSBAR_PART)` |
| Title bar / menu | Hide via CSS `.menubar` rule + `window.menuBarVisibility: 'hidden'` setting |

## Key Context Keys
| Key | Purpose |
|-----|---------|
| `nourlmsStudentRestricted` | Set to `true` for students — used in `when` clauses to hide commands from palette |
| `nourlmsIsStudent` | Set to `true` when logged-in user role is `student` |
| `nourlmsIsAdmin` | Set to `true` when logged-in user role is `admin` |
| `nourlmsRole` | The user's role string |
| `nourlmsIsAuthenticated` | Set to `true` when user is logged in |

## Storage Keys
| Key | Scope | Purpose |
|-----|-------|---------|
| `workbench.activity.pinnedViewlets2` | PROFILE | Controls which icons are pinned/visible in activity bar |
| `workbench.activity.viewletsWorkspaceState` | WORKSPACE | Per-workspace visibility of activity bar icons |
| `workbench.activity.showAccounts` | PROFILE | Controls account icon visibility |

## Common Pitfalls

1. **Forgetting workbench-dev.html** — Dev mode uses a different template. Always update both.
2. **Using `document` instead of `mainWindow`** — ESLint hygiene check requires `mainWindow.document` for multi-window support.
3. **Setting unregistered configs** — Always wrap `updateValue` in try/catch.
4. **Blocking vscode-remote-resource for students** — Only restrict paths inside the workspaces directory, not the VS Code install dir.
5. **CSS `:has()` selector** — Well-supported in modern browsers and the cleanest way to hide UI elements by their icon class.
6. **Terminal `disableStdin`** — Must access xterm via `instance.xtermReadyPromise` since `instance.xterm` may not be ready yet when `onDidCreateInstance` fires.
7. **`sendText` shouldExecute parameter** — It's `boolean | undefined`, not `boolean`. Use `shouldExecute ?? true` to satisfy TypeScript.
8. **`onExit` ≠ command finished** — `instance.onExit` fires when the bash shell process exits, NOT when `python script.py` finishes. Use `CommandDetectionCapability.onCommandFinished` instead.
9. **Missing blocked commands** — Many bypass vectors exist via unblocked commands with keybindings (e.g., `toggleTerminal` via Ctrl+Backtick, `toggleZenMode` via Ctrl+K Z, `debug.start` via F5). Audit regularly.
10. **Terminal split/focus commands** — Commands like `terminal.focusAtIndex*`, `terminal.split`, `terminal.newWithCwd` can create new terminal instances even when `terminal.new` is blocked. Block all creation paths except run commands.
11. **Sessions layout actions** — The Sessions codebase adds its own layout toggle commands (`agentToggleSidebarVisibility` with Ctrl+B, etc.) that bypass the standard VS Code toggle blocks. Block these too.
12. **Capability availability timing** — `CommandDetectionCapability` may be added after `onDidCreateInstance` fires. Always subscribe to both `onDidAddCommandDetectionCapability` (for future additions) and check `capabilities.get()` for already-present capabilities.