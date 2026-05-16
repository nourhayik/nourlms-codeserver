# Implementation Plan: NourLMS Homework Side Panel

**Branch**: `001-homework-side-panel` | **Date**: 2026-05-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-homework-side-panel/spec.md`

## Summary

Add a togglable view container to the **Secondary Side Bar (Auxiliary Bar)** of the existing `nourlms-codeserver` web workbench that surfaces NourLMS code-type homework. The container renders one of two role-gated views:

- **Student View** — the signed-in student's own assigned homework, with text/file submission, polling for AI grading on auto-correct questions, and "Open as Page" to view question/submission/result in a normal editor tab beside the active group. Re-submission is blocked once any submission for a homework is `is_corrected`. The student view exposes no AI-grading-trigger controls of any kind.
- **Admin View** — the question bank (search + filter), one-click "Assign to current student" (target resolved from the open student workspace), inline "New code question" form, and per-current-student assigned-homework list with submission detail, AI grade trigger (queued/sync), and re-grade.

Heavy content opens via `IWebviewWorkbenchService.openWebview(...)` (the same infrastructure that powers Release Notes) into a new editor group beside the active group via `SIDE_GROUP`, with a manager cache that reveals an existing tab on repeat opens.

All LMS calls go through a new server-side proxy under `/nourlms-api/*` in `remoteExtensionHostAgentServer.ts`. The browser never sees the upstream **Sanctum bearer token**; the proxy forwards `Authorization: Bearer <Sanctum token>` to upstream after enforcing per-route role checks against the existing encrypted session cookie.

The slice scopes AI grading result history to "**latest only**", **permanently**. The upstream backend has no grading-history concept (each `AiGradingResult` is overwritten in place on re-grade) and we have explicitly decided **not** to ask the backend to add one. The full rationale, rejected alternatives, and the audit-trail alternative (admin manual-correction notes) are recorded in `scope-decision-no-ai-grading-history.md`.

To resolve the assign-target student's `user_id` from an opened workspace folder, `webClientServer.ts` writes a small sidecar file `.nourlms-user.json` into each student's workspace directory at first login (when the server already knows both the `userId` and the sanitized name). A new server endpoint reads sidecars to enumerate workspaces with their LMS user IDs; the admin panel uses that to wire the "Assign to current student" action without needing a new upstream LMS endpoint.

## Technical Context

**Language/Version**: TypeScript (matches the rest of `src/vs/`, ES module output, target compatible with Node 22 server + modern browser workbench).
**Primary Dependencies**: VS Code workbench platform (in-tree only) — `IRequestService` (`src/vs/platform/request/`), `IWebviewWorkbenchService` (`src/vs/workbench/contrib/webviewPanel/`), view registry (`src/vs/workbench/common/views.ts`), context keys (`src/vs/platform/contextkey/`), `domSanitize.safeSetInnerHtml` (`src/vs/base/browser/domSanitize.ts`), `cookie` (already used by `nourlmsAuth.ts`), Node `http`/`https`. **No new third-party packages.**
**Storage**: One small JSON sidecar per student workspace at `<workspacePath>/.nourlms-user.json` (`{ "userId": <int>, "name": "<original name>", "sanitizedName": "<sanitized>" }`), written by the server at first login; read by the new `/nourlms-workspaces` enumerator and by a per-folder lookup endpoint. No database, no in-memory user cache.
**Testing**: Existing VS Code test harness — `out/vs/.../test/**` mocha-based unit tests for the API client, polling helper, and proxy allow-list; manual smoke tests for the view (the project does not currently exercise workbench `ViewPane`s under integration test).
**Target Platform**: Browser workbench served by `nourlms-codeserver` (Linux server). Native VS Code Desktop is **out of scope** per spec FR-005.
**Project Type**: In-tree feature on the existing single VS Code source layout — **not** a separate frontend/backend project.
**Performance Goals**: Per spec — first page of any list <2s on broadband (SC-003); AI result detection <5s after backend produces (SC-004, bounded by polling interval); bounded total request rate from the panel under the upstream **60 req/min** throttle even with multiple pending pollers (FR-038, SC-010).
**Constraints**: No timer-driven list refreshes (FR-039, verified by static grep test); HTML from upstream MUST be sanitized before render (FR-008); upstream **Sanctum bearer token** MUST NOT reach the browser (FR-011); 401 from any panel call MUST trigger re-login (FR-010); errors MUST render as `<localized message> (<HTTP status>)` (FR-009, normative); panel exists only when the user is authenticated and resolves to a known role (FR-002, FR-003); no admin-only action exists in the Student View bundle (FR-035a, FR-036, SC-006a); panel-side overhead per list call < 50 ms at p95 (SC-003).
**Scale/Scope**: Single classroom-scale tenant (dozens of students, hundreds of questions, low-thousands of submissions). The panel paginates with the upstream `per_page` so it scales as far as the API does.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The repository's constitution at `.specify/memory/constitution.md` is currently the **unfilled template** (placeholder principle names like `[PRINCIPLE_1_NAME]`, no concrete rules). There are therefore no project-defined gates to evaluate against this plan.

| Gate | Status | Notes |
|------|--------|-------|
| Constitution principles defined | ⚠ N/A | `constitution.md` is the template; no project-specific principles were written. Recommend running `/speckit.constitution` separately to lock in principles for future plans. |
| Spec aligns with constitution | ⚠ N/A | No principles to align against. |
| Justification needed for any deviations | ✓ none | None to justify. |

**Initial gate result: PASS** (vacuously, given the empty constitution). The post-design re-check at the end of this document confirms the same outcome.

## Project Structure

### Documentation (this feature)

```text
specs/001-homework-side-panel/
├── plan.md              # This file (/speckit.plan output)
├── spec.md              # /speckit.specify + /speckit.clarify output
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output (manual smoke test)
├── scope-decision-no-ai-grading-history.md   # ADR: AI grading history is intentionally
│                                              # out of scope; no backend ask. (Recorded
│                                              # during /speckit.analyze fix-up.)
├── contracts/
│   ├── server-proxy.md           # /nourlms-api/* allow-list + behavior
│   ├── server-workspaces.md      # extended /nourlms-workspaces shape + new lookup endpoint
│   └── workbench-views.md        # client-side view registration + open-as-page contract
├── checklists/
│   └── requirements.md  # /speckit.specify quality checklist
└── tasks.md             # /speckit.tasks output
```

### Source Code (repository root)

This feature is a slice through the existing VS Code source tree; no new top-level project. Touched and added paths:

```text
src/vs/server/node/
├── nourlmsAuth.ts                          # MODIFY: add a small sidecar reader/writer
├── nourlmsApiProxy.ts                      # NEW: /nourlms-api/* proxy + allow-list
├── remoteExtensionHostAgentServer.ts       # MODIFY: route /nourlms-api/*; extend
│                                           #         _handleNourlmsWorkspaces output
└── webClientServer.ts                      # MODIFY: write workspace sidecar at first login;
                                            #         include userId in WORKBENCH_NOURLMS_USER

src/vs/workbench/services/nourlms/common/
└── nourlms.ts                              # MODIFY: add `userId: number` to INourlmsUserInfo

src/vs/workbench/services/nourlms/browser/
└── nourlmsAuthService.ts                   # MODIFY: read userId from DOM meta tag

src/vs/workbench/contrib/nourlms/browser/
├── nourlms.contribution.ts                 # MODIFY: add `import './homework/nourlmsHomework.contribution.js';`
└── homework/                               # NEW directory
    ├── nourlmsHomework.contribution.ts     # NEW: registers AuxiliaryBar container + views
    ├── nourlmsHomeworkApi.ts               # NEW: typed wrapper over IRequestService → /nourlms-api/*
    ├── nourlmsHomeworkPolling.ts           # NEW: bounded backoff poll helper for AI grading
    ├── nourlmsHomeworkPage.ts              # NEW: webview-based "Open as Page" manager
    │                                       #      (release-notes-style, dedup by (kind,id))
    ├── nourlmsHomeworkTargetStudent.ts     # NEW: resolves "current target student" from
    │                                       #      open workspace folder via /nourlms-workspaces lookup
    └── views/
        ├── nourlmsHomeworkStudentView.ts            # NEW: ViewPane for the student view
        ├── nourlmsHomeworkAdminQuestionBankView.ts  # NEW: ViewPane (admin) — questions list
        └── nourlmsHomeworkAdminAssignedView.ts      # NEW: ViewPane (admin) — assigned-to-current-student

src/vs/code/browser/workbench/
└── workbench.html                          # ALREADY MODIFIED earlier in this project for
                                            # WORKBENCH_NOURLMS_USER; no further change needed
                                            # (the new userId field rides in the same JSON blob)
```

**Structure Decision**: Single-tree, in-place. Workbench feature code lives under `src/vs/workbench/contrib/nourlms/browser/homework/` (new sub-folder so the existing nourlms `Student Workspaces` files stay untouched), the shared client/service contract sits at `src/vs/workbench/services/nourlms/common/nourlms.ts` (extended with `userId`), and the server proxy lives next to the existing nourlms server code at `src/vs/server/node/nourlmsApiProxy.ts` (new file) plus minor edits in `remoteExtensionHostAgentServer.ts` and `webClientServer.ts`. There is no new project, no new package, no new build step.

## Phase 0 → Phase 1 outputs

- **Phase 0 — Research**: see [research.md](./research.md). Decisions made (with alternatives considered): Auxiliary Bar over Sidebar (per clarify Q1), webview editor (`IWebviewWorkbenchService`) over custom `EditorPane` for "Open as Page", `SIDE_GROUP` open with manager-cache dedup for repeat opens, `domSanitize.safeSetInnerHtml` for any non-webview HTML, sidecar-based target-student resolution, and concrete polling cadence numbers (start 2s, ×1.5 backoff, cap 15s, max 60 attempts ≈ 10 min, ±20% jitter). The 1 MB text-only file submission limit is also locked in.
- **Phase 1 — Design & Contracts**: see [data-model.md](./data-model.md), [contracts/server-proxy.md](./contracts/server-proxy.md), [contracts/server-workspaces.md](./contracts/server-workspaces.md), [contracts/workbench-views.md](./contracts/workbench-views.md), and [quickstart.md](./quickstart.md).

## Post-design Constitution Re-check

| Gate | Status | Notes |
|------|--------|-------|
| Constitution principles defined | ⚠ N/A | Still empty; no change. |
| Plan introduces no new third-party deps | ✓ | All work is in-tree against existing VS Code workbench platform + Node `http`. |
| Plan reuses existing security model | ✓ | New `/nourlms-api/*` proxy reuses encrypted session cookie + `nourlmsAuth.parseSessionCookie`; **Sanctum bearer token** never crosses to the browser; student endpoints continue to enforce ownership server-side. |
| Plan introduces no new project | ✓ | All edits + new files live under existing `src/vs/server/node/` and `src/vs/workbench/{services,contrib}/nourlms/`. |
| Bounded API impact under 60 req/min throttle | ✓ | No timer-driven list refreshes; bounded backoff polling; jitter to prevent lock-step pollers across tabs (research.md §4). |
| HTML from upstream sanitized before render | ✓ | Webview is sandboxed by default; non-webview render paths use `domSanitize.safeSetInnerHtml`. |
| No admin grading triggers in Student View bundle | ✓ | Student View files import only the student-relevant API methods and never reference `/admin/*` routes; build-time grep verifiable per SC-006a. |

**Final gate result: PASS.**

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_    | _none_     | _none_                              |

No constitution violations to justify (the constitution is empty; no architectural constraint conflicts emerged in design).
