# Phase 0 — Research: NourLMS Homework Side Panel

This document resolves the items the spec deliberately deferred to plan phase, plus the technology choices the implementation depends on. Each entry is in the form **Decision / Rationale / Alternatives considered**, with citations into the existing codebase.

---

## 1. View container placement & registration

**Decision**: Register one view container in **`ViewContainerLocation.AuxiliaryBar`** with `mergeViewWithContainerWhenSingleView: true`. Register up to three role-gated `ViewPane`s into that container:

- `nourlmsHomework.studentList` — gated on `nourlmsIsStudent`.
- `nourlmsHomework.adminQuestionBank` — gated on `nourlmsIsAdmin`.
- `nourlmsHomework.adminAssigned` — gated on `nourlmsIsAdmin`.

Because the visibility predicates are mutually exclusive (one user is either admin or student), at most two views are ever active at a time and `mergeViewWithContainerWhenSingleView` collapses the chrome cleanly when only one is present.

**Rationale**:
- The user picked Secondary Side Bar in `/speckit.clarify` Q1.
- The Auxiliary Bar uses the **same `ViewContainerModel`** as the primary sidebar — `when` clauses, `mergeViewWithContainerWhenSingleView`, multi-pane stacking, header collapse — all behave identically. Verified at `src/vs/workbench/browser/parts/views/viewPaneContainer.ts:1101–1113` (`isViewMergedWithContainer` is location-agnostic) and `src/vs/workbench/services/views/common/viewContainerModel.ts:593–606` (`when` clauses re-evaluated on context-key changes).
- Reference patterns:
  - Single-view AuxiliaryBar container with `mergeViewWithContainerWhenSingleView`: `src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts:38–48` (Chat).
  - Multi-pane stacked container: `src/vs/workbench/contrib/scm/browser/scm.contribution.ts:104–159` (SCM Repositories / Changes / Graph).
  - This repo's existing nourlms primary-sidebar container as the closest stylistic precedent: `src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspaces.ts:24–45`.

**Alternatives considered**:
- *Primary Sidebar (left)* — rejected per clarify Q1.
- *Bottom Panel* — rejected per clarify Q1; also bad fit because `ViewPane` switches to horizontal orientation only in `ViewContainerLocation.Panel` (`viewPane.ts:382`), which would break our vertically-stacked sub-pane design.
- *One container per role (admin vs student) instead of one container with role-gated views* — rejected: doubles the activity icon footprint, and `hideIfEmpty: true` already hides the unused side of the view set per role.

**Toggle / focus commands to integrate with**: `workbench.action.toggleAuxiliaryBar` (Ctrl/Cmd+Alt+B), `workbench.action.focusAuxiliaryBar`, `workbench.action.openView` — all already in-tree (`src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarActions.ts:30–138`, `src/vs/workbench/contrib/quickaccess/browser/viewQuickAccess.ts:151–169, 229–244`). No new commands required.

---

## 2. "Open as Page" implementation

**Decision**: Use `IWebviewWorkbenchService.openWebview(...)` (the same service that powers Release Notes) with `group: SIDE_GROUP` to open beside the active editor group. Maintain a per-workbench `nourlmsHomeworkPage` manager that caches `(kind, id) → WebviewInput` and calls `revealWebview` on repeat opens, mirroring `ReleaseNotesManager`. Render the page body as HTML built from the API response, with all upstream-supplied HTML fragments piped through `domSanitize.safeSetInnerHtml` before insertion.

**Rationale**:
- `IWebviewWorkbenchService` registration, sandbox, and CSP are already in-tree and battle-tested (`src/vs/workbench/contrib/webviewPanel/browser/webviewPanel.contribution.ts:24–28`, options model at `src/vs/workbench/contrib/webview/browser/webview.ts:93–143`, sandbox tokens at `src/vs/workbench/contrib/webview/browser/webviewElement.ts:402–405`, CSP meta at `src/vs/workbench/contrib/webview/browser/pre/index.html:7–8`).
- `SIDE_GROUP` constant is the canonical "beside active group" hook (`src/vs/workbench/services/editor/common/editorService.ts:19–43, 255–284`). Webview show options accept it explicitly (`src/vs/workbench/contrib/webviewPanel/browser/webviewWorkbenchService.ts:25–27`).
- Manager-cache + `revealWebview` is the lightweight dedup pattern proven by Release Notes (`src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts:106–122`). Implementing it for our 3 page kinds (question / submission / grading-result) costs ~120 LOC vs. the ~660 LOC needed to implement a custom `EditorInput` + `EditorPane` from scratch.
- Webview iframe sandboxing means upstream HTML cannot reach the workbench DOM. We still sanitize defensively (`localResourceRoots: []`, `allowScripts: false`, no `enableCommandUris`) so even malicious content cannot execute.

**Alternatives considered**:
- *Custom `EditorInput` + `EditorPane`* (Walkthrough / Settings2 pattern, `src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts:20–26`, `src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts:71–80`). Rejected: more boilerplate, more workbench surfaces touched, and we'd still need a sanitizer for the HTML fragments — webview gives sandboxing for free.
- *`TextResourceEditorInput` over a custom-scheme URI* (`src/vs/workbench/common/editor/textResourceEditorInput.ts:85–207`, used by Output channels at `src/vs/workbench/contrib/output/browser/outputView.ts:209–211`). Rejected: this opens the **text editor**, not a rendered HTML view; question/result content is HTML so the user would see source markup instead of rendered text.

**Allow-list inside the webview**:

| Option | Value | Why |
|---|---|---|
| `allowScripts` | `false` | We render our own HTML; nothing in the upstream payload should execute. |
| `allowForms` | `false` | All form-like inputs (correction, grading triggers) live in the side panel, not inside the webview. |
| `localResourceRoots` | `[]` | We never need to load file-system resources into the page. |
| `enableCommandUris` | `false` (default) | No `command:` deep-links from external HTML. |
| `enableFindWidget` | `true` | Useful for long question text. |
| `disableServiceWorker` | `true` | We have no offline use case. |

---

## 3. Server proxy URL prefix and forwarding model

**Decision**: Add a single new server route prefix **`/nourlms-api/`** in `remoteExtensionHostAgentServer.ts`. The handler (a new file `src/vs/server/node/nourlmsApiProxy.ts`) does:

1. Reuses the existing session middleware (the route is reached only after `__nourlmsSession` is set, so unauthenticated callers already got redirected to `/nourlms-login`).
2. Strips the `/nourlms-api` prefix and validates the remainder against an **explicit allow-list** (see [contracts/server-proxy.md](./contracts/server-proxy.md)).
3. Verifies role per route (admin-only routes vs student-only routes vs shared).
4. Builds a Node `http`/`https` request to `<nourlmsApiUrl>/<rest-of-path>` using the same `nodeHttp.RequestOptions` shape the existing login handler uses (`remoteExtensionHostAgentServer.ts:440–450`).
5. Forwards `Authorization: Bearer <session.token>`, `Accept: application/json`, request `Content-Type` for POST/PATCH bodies, and the request body verbatim. Streams the upstream response status code, `Content-Type`, and body back.
6. On 401 from upstream, returns 401 to the panel (which triggers the panel's re-login flow per FR-010).

**Rationale**:
- Mirrors the existing `_handleNourlmsLogin` / `_handleNourlmsLogout` style — same Node `http`/`https`, same session-cookie auth model — so there's no new pattern to learn.
- Allow-listing per HTTP method + path means we expose **only** the endpoints the panel needs (see contract). A code error in the panel can never accidentally reach an unintended upstream route.
- Server-side role gating is defense in depth: even if a student session somehow drove the panel to issue an admin URL, the proxy returns 403 before forwarding.
- The token never reaches the browser — exactly the model the existing `_handleNourlmsLogout` uses (cf. `remoteExtensionHostAgentServer.ts:546`).

**Alternatives considered**:
- *Generic open proxy that forwards anything under `/api/...`* — rejected: no allow-list = poor security posture; also conflicts with VS Code's own `/api/*` extension-host routes.
- *Issue the Sanctum bearer token to the browser and call upstream directly from the workbench* — rejected: violates FR-011, exposes the token in DevTools/network logs and to any extension running in the workbench.
- *Path-prefix `/api/nourlms/...`* — rejected: collides with VS Code's `/api/...` and is less explicit than `/nourlms-api/`.

---

## 4. AI grading polling cadence (resolved per spec FR-038)

**Decision**: A small reusable `pollAiGradingStatus()` helper in `nourlmsHomeworkPolling.ts` with these concrete values:

| Parameter | Value | Reason |
|---|---|---|
| Initial interval | **2 s** | Matches SC-004's <5 s target — most jobs resolve in the first attempt. |
| Backoff multiplier | **× 1.5** | Smooth ramp; avoids round-number lock-step. |
| Interval ceiling | **15 s** | Caps per-poller request rate at 4 req/min once at ceiling. |
| Max attempts | **60** | ≈ 9–10 min wall clock (compatible with the upstream's typical job duration ceiling). |
| Per-call jitter | **±20 %** | Prevents many tabs polling in lock-step against the 60 req/min throttle. |
| Cancellation | `CancellationToken` from `setVisible(false)` / panel-close / workspace-change. | Honors FR-037. |
| Failure handling | Up to 3 consecutive transient failures (network or 5xx) silently retried; after that, surface inline "Check again" control and stop. | Matches US3 scenario 5 / FR-038. |
| Concurrent pollers cap | At most **5 active pollers** at any time per panel; further submissions queue and start when a slot frees. | Hard ceiling under throttle; with 5 pollers at 15 s each that's 20 req/min of polling traffic, leaving 40 req/min headroom for the rest of the panel. |

**Rationale**: Acceptance scenarios in clarify Q4 implicitly accepted "Option B" (start 2s, exponential ×1.5, cap 15s, give up after 60 attempts). The two additions — jitter and concurrent-pollers cap — are not contentious; they exist purely to keep total panel traffic well under the 60 req/min throttle (SC-010) even with several open homework tabs.

**Alternatives considered**: Fixed 3 s, fixed 5 s, linear +2 s — all listed as Q4 options; the chosen pattern is more responsive in the first 10 s and gentler at minute-plus.

---

## 5. Target-student resolution from open workspace folder

**Decision**: Write a tiny sidecar file `<workspacePath>/.nourlms-user.json` containing `{ "userId": <int>, "name": "<original>", "sanitizedName": "<sanitized>" }` from `webClientServer.ts` at the moment the student's workspace is created/touched (right after `nourlmsAuth.ensureWorkspaceDir(...)` at `src/vs/server/node/webClientServer.ts:347–349`). The file is excluded from the explorer view via the standard `files.exclude` setting injected for student sessions.

Then:

- Extend `_handleNourlmsWorkspaces` (`src/vs/server/node/remoteExtensionHostAgentServer.ts:570–607`) so each entry is `{ name, path, userId?, displayName? }`, derived by reading the sidecar (best effort: missing sidecar = entry still listed without `userId`).
- Add a new server endpoint `GET /nourlms-workspaces/lookup?path=<encoded>` returning `{ userId, name }` for a single folder path (admin-only). The panel calls this once when the open folder changes.
- Extend `INourlmsUserInfo` with an optional `userId: number` (already present in the encrypted session, just not currently exposed to the browser). Read it from the existing `WORKBENCH_NOURLMS_USER` template variable — the server (`webClientServer.ts:351–353`) just adds the field.

**Rationale**:
- The encrypted session already contains `userId` (`nourlmsAuth.ts:11–16`) — no new auth surface is needed.
- The upstream LMS API (per the docs) does **not** expose a "list students" or "lookup student by name" endpoint, so we can't query upstream to map sanitized-name → user_id. The sidecar is the smallest local addition that closes the gap without touching the LMS.
- A sidecar is a one-time write at first login (and idempotent thereafter), reads as a trivial file open, and survives container restart.

**Alternatives considered**:
- *Server-side in-memory map* — rejected: lost on restart; first-after-restart admin action would fail.
- *Add an LMS endpoint to look up users by name* — rejected: out-of-tree change to the LMS backend; defeats the goal of "no new backend endpoints".
- *Have admin manually pick a student from a dropdown* — rejected: contradicts spec FR-016/FR-017 ("auto-resolved from the open workspace").

**Privacy / leakage check**: The sidecar contains the LMS user_id and the original (un-sanitized) display name. Both are already known to the admin who can see the workspace; the file is `0600`-mode and lives inside the student's own workspace dir, which is locked down for the student's own browser session and only readable by other admins (who already have full access). No new disclosure surface.

---

## 6. HTML rendering & sanitization

**Decision**:
- **Inside the webview** ("Open as Page"): the page body is fully sandboxed (iframe + CSP per the existing webview infra). Upstream HTML fragments are still passed through `domSanitize.safeSetInnerHtml` before insertion as defence in depth.
- **Inside the side panel itself** (small previews, single-line summaries): never inject upstream HTML directly. Render question summaries by stripping HTML to text (`textContent`), and use `domSanitize.safeSetInnerHtml` for any explicitly-allowed inline rich content (e.g. inline `<code>` snippets in a question stem preview).

`domSanitize` import: `import * as domSanitize from '../../../../base/browser/domSanitize.js';` — same path style as `src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThroughPart.ts` (which uses `domSanitize.safeSetInnerHtml` per the explore report).

**Alternatives considered**: `innerHTML` directly — rejected (FR-008). `marked`/`markdown-it` — rejected, not needed for HTML payloads.

---

## 7. File-based answer submission

**Decision**:
- Source: only files inside the current workspace, picked via VS Code's standard `IFileService` browse — students cannot reach files outside their workspace anyway because of the existing `/vscode-remote-resource` student isolation in `remoteExtensionHostAgentServer.ts:271–298`.
- File type acceptance: text-readable detected via UTF-8 decode + a heuristic null-byte scan; binary files rejected with a clear message.
- Size limit: **1 MB** (panel-level cap). Files above the limit are rejected client-side before any read; smaller files are loaded via `IFileService.readFile`, decoded as UTF-8, and sent as `{ "content": "<text>" }` to the existing `/student/homeworks/{id}/submit` endpoint.

**Rationale**: 1 MB is comfortably above any realistic code submission and well below any reasonable HTTP body limit. The existing `/student/homeworks/{id}/submit` API only accepts a `content` string; there's no file-upload endpoint to call.

**Alternatives considered**: Local-disk upload bypass — rejected, contradicts the existing student-workspace isolation. Larger / unbounded file size — rejected, no use case and increases payload-size attack surface.

---

## 8. Workbench API request pattern

**Decision**: Use `IRequestService.request(...)` from `src/vs/platform/request/common/request.ts` exactly as the existing `nourlmsAdminWorkspacesView.ts:69–84` does, but with relative URL `/nourlms-api/<path>`. Pass through:

- Method (`'GET'` / `'POST'` / `'PATCH'`).
- `data` as JSON-stringified body for POST/PATCH.
- `headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }` for write methods.
- The `CancellationToken` from the calling pane's `setVisible(false)` / disposable lifecycle.

Response decoding via `asJson<T>(context)` (already imported in the existing nourlms view).

**Rationale**: Reuses the proven in-tree pattern; no new HTTP client; works against the same encrypted session cookie because the browser will automatically include it on same-origin requests.

**Alternatives considered**: `fetch()` directly — rejected: workbench convention is `IRequestService` for testability and consistent header injection.

---

## 9. Localization

**Decision**: All user-facing strings go through `localize`/`localize2` from `nls.js`, exactly as the existing nourlms files (`src/vs/workbench/contrib/nourlms/browser/nourlmsAdminWorkspaces.ts:6` for `localize2`, `nourlmsAdminWorkspacesView.ts:6` for `localize`). Keys are namespaced `nourlms.homework.<area>.<id>` to avoid collision with the existing `nourlms.workspaces.*` keys.

No alternatives considered — VS Code l10n is the only option in-tree.

---

## 10. Build / bundle implications

**Decision**: None beyond TypeScript imports. The new files live under `src/vs/workbench/contrib/nourlms/browser/homework/` and are pulled in by adding a single side-effect import to `src/vs/workbench/contrib/nourlms/browser/nourlms.contribution.ts` (which `workbench.web.main.ts` already imports). The new server file `src/vs/server/node/nourlmsApiProxy.ts` is imported from `remoteExtensionHostAgentServer.ts`. No gulpfile, build, or product.json changes needed.

**Verification**: `gulpfile.mjs` and `build/` only enumerate by glob (`src/**/*.ts`), so new files are picked up automatically.

---

## Summary of resolved unknowns

| Spec deferral | Resolved here |
|---|---|
| Container placement (Q1 already) | §1 — `ViewContainerLocation.AuxiliaryBar`, three views with role-gated `when` |
| Open-as-Page placement (Q3 already) | §2 — `IWebviewWorkbenchService.openWebview(..., group: SIDE_GROUP)` + manager-cache reveal |
| AI polling cadence numbers (FR-038) | §4 — 2s start, ×1.5, cap 15s, 60 attempts, ±20% jitter, 5-poller cap, 3-failure transient retry |
| Server proxy URL prefix | §3 — `/nourlms-api/*` with explicit per-route allow-list |
| Target-student resolution mechanism | §5 — sidecar `.nourlms-user.json` + extended `/nourlms-workspaces` + new `/nourlms-workspaces/lookup` |
| File submission size limit & type detection | §7 — 1 MB cap, UTF-8 + null-byte heuristic, current-workspace only |
| HTML sanitization choice | §6 — webview sandbox + `domSanitize.safeSetInnerHtml` |

No `NEEDS CLARIFICATION` markers remain in the plan after this research pass.
