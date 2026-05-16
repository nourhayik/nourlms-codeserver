# NourLMS Authentication & Access Control Plan

## Overview

Implement a login-gated access flow for the VS Code server application:
- No user can access the app without logging in
- Authentication uses the NourLMS login API (`POST /api/auth/login`)
- Users are routed and restricted based on their role (`student` or `admin`)
- Students get a highly restricted VS Code environment
- Admins get full VS Code with a workspace management sidebar

---

## Login API Contract

| Aspect | Detail |
|--------|--------|
| Login endpoint | `POST http://nourlmsv3.local/api/auth/login` |
| Request body | `{ phone: string, password: string }` |
| Success (200) | `{ user: { id, name, phone, is_block, roles: string[] }, token: string }` |
| Roles | Single role per user: `admin` or `student` |
| Invalid credentials | 401: `{ message: "Invalid credentials" }` |
| Suspended account | 403: `{ message: "Account is suspended" }` |
| Validation error | 422: `{ message, errors }` |
| Rate limit | 429: 5 requests/minute per IP |
| Token expiry | 1 hour |
| Logout | `POST /api/auth/logout` with `Authorization: Bearer <token>` |

---

## Architecture Decisions

1. **Server-side auth gate**: All HTTP requests checked for a valid session cookie before serving the workbench. Most secure approach.
2. **Cookie-only validation**: Token validated with API only at login. Subsequent requests check encrypted session cookie. Cookie expires at 55 minutes (before 1-hour token expiry).
3. **Client-side context keys**: User role exposed via context keys (`nourlmsIsStudent`, `nourlmsIsAdmin`) for UI control via `when` clauses.
4. **Server-enforced isolation**: Students can only access files within their workspace directory via `/vscode-remote-resource`.
5. **CLI args**: `--nourlms-api-url` and `--nourlms-workspaces-dir` (default: `/workspaces/students`)
6. **Terminal for students**: "Run Active File" enabled. Terminal allows stdin for running process. Auto-closes when process exits. No arbitrary terminal creation.

---

## Phase 1: Server-Side Auth Infrastructure

### New Files

1. **`src/vs/server/node/nourlmsAuth.ts`** - Auth utility module
   - `sanitizeUsername(name)`: lowercase, remove spaces and special chars, keep only `a-z0-9`
   - `NourlmsSession` type: `{ userId, name, role, token }`
   - `parseSessionCookie(cookieHeader)`: decrypt and parse session cookie
   - `createSessionCookie(session)`: encrypt and serialize session cookie
   - Cookie name: `nourlms.session`, encrypted with AES-256-GCM using a derived key from server data dir

2. **`src/vs/server/nourlms-login.html`** - Login page
   - Clean login form with phone + password fields
   - Submits POST to `/nourlms-login` on the same server
   - Shows error messages for all API error states
   - On success: redirect to `/`

### Modified Files

3. **`src/vs/server/node/serverEnvironmentService.ts`**
   - Add `--nourlms-api-url` CLI option (string, required for auth)
   - Add `--nourlms-workspaces-dir` CLI option (string, default: `/workspaces/students`)

4. **`src/vs/server/node/remoteExtensionHostAgentServer.ts`**
   - Add `POST /nourlms-login` route: proxy credentials to NourLMS API, set session cookie, redirect to `/`
   - Add `POST /nourlms-logout` route: call API logout, clear cookie, redirect to login
   - Add `GET /nourlms-workspaces` route: list student workspace directories (admin only)
   - Add auth middleware in `handleRequest()`: check session cookie before serving anything
   - Add path-based access control in `/vscode-remote-resource` for students

5. **`src/vs/server/node/webClientServer.ts`**
   - Read nourlms session from cookie
   - For students: resolve/create workspace, set as `folderUri`
   - Inject `WORKBENCH_NOURLMS_USER` template variable: `{ name, role, workspacePath }`

6. **`src/vs/code/browser/workbench/workbench.html`**
   - Add `<meta id="vscode-nourlms-user" data-settings="{{WORKBENCH_NOURLMS_USER}}">`

---

## Phase 2: Client-Side Auth Service & Context Keys

### New Files

1. **`src/vs/workbench/services/nourlms/common/nourlms.ts`**
   - `INourlmsUserInfo` interface: `{ name, role, workspacePath }`
   - `INourlmsAuthService` interface: `{ userInfo, logout(), isAuthenticated }`
   - Context key constants: `NourlmsContextKeys.IsStudent`, `NourlmsContextKeys.IsAdmin`

2. **`src/vs/workbench/services/nourlms/browser/nourlmsAuthService.ts`**
   - `NourlmsAuthService` implementation
   - Reads user info from DOM meta tag
   - Sets context keys on initialization
   - `logout()`: navigates to `/nourlms-logout`

3. **`src/vs/workbench/services/nourlms/browser/nourlms.contribution.ts`**
   - Registers `NourlmsAuthService` as singleton
   - Binds context keys at `WorkbenchPhase.BlockStartup`

### Modified Files

4. **`src/vs/workbench/workbench.web.main.ts`**
   - Import and register nourlms contribution

---

## Phase 3: Student Restrictions

### New Files

1. **`src/vs/workbench/contrib/nourlms/browser/nourlmsStudentRestrictions.ts`**
   - `IWorkbenchContribution` registered at `WorkbenchPhase.AfterRestored`
   - Only activates when `nourlmsIsStudent` is true

   Restrictions implemented:
   - **Activity bar**: Hide all icons except Explorer via `IViewDescriptorService`
   - **Menu bar**: Hide via `IWorkbenchLayoutService`
   - **Commands blocked** (via precondition overrides):
     - Settings: `workbench.action.openSettings`, `workbench.action.openSettings2`
     - Extensions: `workbench.view.extensions`, extension install/uninstall
     - Git/SCM: `workbench.view.scm`, git commands
     - Terminal: `workbench.action.terminal.new`, `workbench.action.terminal.createNew`
     - Copilot: inline suggest commands
   - **Terminal**:
     - "New Terminal" disabled for students
     - "Run Active File" (`workbench.action.terminal.runActiveFile`) enabled
     - Terminals created by "Run" allow stdin input
     - Hook `ITerminalService.onDidCreateInstance` to apply read-only to non-run terminals
   - **Default settings overrides** for students:
     - `git.enabled: false`
     - `extensions.autoUpdate: false`

---

## Phase 4: Workspace Management

### Server-Side (in `_handleRoot` of webClientServer.ts)

For student users:
1. `sanitizedName = sanitizeUsername(session.name)` → e.g., "Ahmed Al-Rashid" → "ahmedalrashid"
2. `workspacePath = path.join(workspacesDir, sanitizedName)` → `/workspaces/students/ahmedalrashid`
3. If dir doesn't exist: `fs.mkdirSync(workspacePath, { recursive: true })`
4. Set `folderUri` in workbench config to `vscode-remote://<authority>/workspaces/students/ahmedalrashid`
5. URL `?folder=` params are ignored for students (forced to their workspace)

For admin users:
- Use URL `?folder=` param if present, otherwise no forced workspace

---

## Phase 5: Admin Workspace Sidebar

### New Files

1. **`src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspaces.ts`**
   - `NourlmsWorkspacesViewPaneContainer` extends `ViewPaneContainer`
   - Registered as view container at order: 5 (below Extensions at 4)
   - Icon: `Codicon.organization` or similar
   - `when` clause: `nourlmsIsAdmin == true`

2. **`src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspacesView.ts`**
   - `NourlmsWorkspacesView` extends `ViewPane`
   - Fetches workspace list via `GET /nourlms-workspaces`
   - Renders as tree/list with student workspace names
   - On click: opens `?folder=/workspaces/students/<name>` in current window

3. **`src/vs/workbench/contrib/nourlms/browser/nourlmsAdmin.contribution.ts`**
   - Registers view container and views
   - Only active when `nourlmsIsAdmin` is true

---

## Phase 6: Student Workspace Access Control

### Server-Side Enforcement

- `/vscode-remote-resource` handler: for students, validate `desiredPath` starts with their workspace path
- Direct URL `?folder=...` to another workspace: server rejects by forcing student's own workspace
- WebSocket connections: validated against session

---

## Files Summary

| Action | File | Purpose |
|--------|------|---------|
| CREATE | `src/vs/server/node/nourlmsAuth.ts` | Session/cookie/crypto helpers + sidecar R/W + userId in session |
| CREATE | `src/vs/server/nourlms-login.html` | Login page UI |
| CREATE | `src/vs/server/node/nourlmsApiProxy.ts` | `/nourlms-api/*` allow-list proxy with per-route role enforcement |
| CREATE | `src/vs/workbench/services/nourlms/common/nourlms.ts` | Interface & types (incl. `userId`) |
| CREATE | `src/vs/workbench/services/nourlms/browser/nourlmsAuthService.ts` | Client auth service (logout hooks Homework cleanup) |
| CREATE | `src/vs/workbench/services/nourlms/browser/nourlms.contribution.ts` | Service registration |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/nourlmsStudentRestrictions.ts` | Student feature lockdown |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspaces.ts` | Admin sidebar container |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspacesView.ts` | Workspace list view |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/nourlmsAdmin.contribution.ts` | Admin contribution registration |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomework.contribution.ts` | Homework container + view registration |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts` | Typed API wrapper over IRequestService → `/nourlms-api/*` |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPolling.ts` | Bounded backoff poll helper for AI grading |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPage.ts` | Webview "Open as Page" manager (dedup by kind:id) |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkTargetStudent.ts` | Resolves target student from open workspace |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/types.ts` | Mirror TypeScript interfaces from data model |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkStudentView.ts` | Student View (list, detail, submit, submissions, polling) |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminQuestionBankView.ts` | Admin Question Bank (search, filter, assign, create) |
| CREATE | `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminAssignedView.ts` | Admin Assigned View (per-student homework, submissions, AI grade, correct) |
| CREATE | `src/vs/workbench/contrib/nourlms/test/browser/homeworkPolling.test.ts` | Polling registry unit tests |
| CREATE | `src/vs/workbench/contrib/nourlms/test/browser/studentViewBundle.test.ts` | Student view bundle isolation test (SC-006a) |
| CREATE | `src/vs/workbench/contrib/nourlms/test/browser/adminAssignGating.test.ts` | Admin assign gating unit test (SC-006) |
| CREATE | `src/vs/workbench/contrib/nourlms/test/browser/l10n.test.ts` | L10n lint test (FR-040) |
| CREATE | `src/vs/workbench/contrib/nourlms/test/browser/apiOverhead.test.ts` | Panel-overhead assertion test (SC-003) |
| CREATE | `src/vs/server/test/node/nourlmsAuthSidecar.test.ts` | Sidecar R/W unit tests |
| CREATE | `src/vs/server/test/node/nourlmsApiProxy.test.ts` | Proxy allow-list, role, header, and SC-005/SC-010 tests |
| MODIFY | `src/vs/server/node/serverEnvironmentService.ts` | Add CLI options |
| MODIFY | `src/vs/server/node/remoteExtensionHostAgentServer.ts` | Auth middleware, login/logout routes, workspace isolation, `/nourlms-api/*` route, workspaces lookup |
| MODIFY | `src/vs/server/node/webClientServer.ts` | Session-aware workspace resolution, inject user info (incl. userId, sidecar, files.exclude) |
| MODIFY | `src/vs/code/browser/workbench/workbench.html` | Add nourlms user meta tag |
| MODIFY | `src/vs/workbench/workbench.web.main.ts` | Register nourlms contributions |
| MODIFY | `src/vs/workbench/contrib/nourlms/browser/nourlms.contribution.ts` | Import homework contribution side-effect |

---

## Assumptions

1. Terminal "Run Code": Students use `Run Active File`. Terminal allows stdin for running process. Terminal auto-closes when process exits.
2. Workspace base path: `/workspaces/students/` (created if not exists).
3. Admin gets full VS Code + workspace sidebar. Admin can open any student workspace.
4. Login API is accessible server-to-server (no CORS issues for the proxy).
5. Each user has exactly one role.
