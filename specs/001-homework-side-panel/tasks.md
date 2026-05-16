---
description: "Task list for NourLMS Homework Side Panel"
---

# Tasks: NourLMS Homework Side Panel

**Input**: Design documents from `/specs/001-homework-side-panel/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/server-proxy.md, contracts/server-workspaces.md, contracts/workbench-views.md, quickstart.md

**Tests**: Tests are included only where the spec explicitly demands them (SC-005, SC-006, SC-006a) or where the contracts call them out as MUST-haves (server proxy, sidecar, polling helper). No broad test scaffolding beyond that.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and demoed independently. The MVP slice is **US1 + US2** (both P1) — those two together unlock the headline workflow ("admin assigns, student submits"). US3, US4, US5 are layered on top.

## Format: `[ID] [P?] [Story?] Description with file path`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks).
- **[Story]**: Maps to spec.md user stories — `[US1]` … `[US5]`.

## Path Conventions

This is a slice in the existing VS Code source tree. **No new project, no new top-level directories.** All paths below are absolute under the repo root `/home/nour/nourlms-codeserver/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Carve out the directory structure for the new client-side code.

- [X] T001 Create directory tree `src/vs/workbench/contrib/nourlms/browser/homework/` and `src/vs/workbench/contrib/nourlms/browser/homework/views/` (and `src/vs/workbench/contrib/nourlms/test/browser/` for client-side tests).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Server proxy, session/userId plumbing, sidecar, mirror types, base API client, polling helper, page manager, target-student service, and the empty view container — everything needed before any story-specific view can be wired.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Server-side foundations

- [X] T002 [P] Add `writeWorkspaceSidecar(workspacePath, session)` and `readWorkspaceSidecar(workspacePath)` exports + `NourlmsWorkspaceSidecar` interface to `src/vs/server/node/nourlmsAuth.ts` per `contracts/server-workspaces.md` §1 (write with mode `0o600`; read returns `null` on missing/malformed/sanitizedName-mismatch).
- [X] T003 [P] Create new file `src/vs/server/node/nourlmsApiProxy.ts` exporting `NOURLMS_PROXY_ALLOWLIST` (the 26 routes from `contracts/server-proxy.md` §2.1–2.4) and `handleNourlmsApiProxy(req, res, pathname, nourlmsApiUrl, session, logService)`. Implementation must (a) match path against the allow-list, (b) enforce per-route role (returns 404 not 403 on mismatch, per §1), (c) build upstream Node `http`/`https` request with `Authorization: Bearer <session.token>`, stripping `Cookie`/`Authorization` from the inbound request, (d) stream the upstream body back, (e) strip upstream `Set-Cookie`, (f) translate upstream network failure to 502.
- [X] T004 Wire the `/nourlms-api/*` route into `_handleRequest` in `src/vs/server/node/remoteExtensionHostAgentServer.ts` after the session-cookie middleware (around line 244) — call `handleNourlmsApiProxy(...)` when `pathname.startsWith('/nourlms-api/')`. Depends on T003.
- [X] T005 Extend `_handleNourlmsWorkspaces` in `src/vs/server/node/remoteExtensionHostAgentServer.ts` to merge `userId` and `displayName` from the sidecar (best-effort; missing sidecar => entry without those fields). Add new admin-only handler `_handleNourlmsWorkspacesLookup(req, res, session)` and route `GET /nourlms-workspaces/lookup?path=<encoded>` per `contracts/server-workspaces.md` §3 (path-traversal hardened per §4). Depends on T002.
- [X] T006 In `src/vs/server/node/webClientServer.ts`: (a) call `nourlmsAuth.writeWorkspaceSidecar(workspacePath, nourlmsSession)` immediately after `ensureWorkspaceDir(...)` for student sessions (around line 348); (b) include `userId: nourlmsSession.userId` in the `nourlmsUserInfo` JSON injected via `WORKBENCH_NOURLMS_USER` (around lines 351–353); (c) inject `"files.exclude": { ".nourlms-user.json": true }` into the `configurationDefaults` for student sessions (around lines 393–397). Depends on T002.

### Client-side foundations

- [X] T007 [P] Extend `INourlmsUserInfo` with `readonly userId: number;` in `src/vs/workbench/services/nourlms/common/nourlms.ts`.
- [X] T008 [P] Update `_readUserInfoFromDom` in `src/vs/workbench/services/nourlms/browser/nourlmsAuthService.ts` to read `parsed.userId` (default to `0` for backward compatibility during deploy). Depends on T007.
- [X] T009 [P] Create new file `src/vs/workbench/contrib/nourlms/browser/homework/types.ts` with the mirror TypeScript interfaces from `data-model.md` §1 (`Question`, `Homework`, `HomeworkSubmission`, `AiGradingResult`, `Course`, `Subject`, `DifficultyRate`, `QuestionType`, `Paginated<T>`, `ApiError`).
- [X] T010 Create `NourlmsHomeworkApi` skeleton in new file `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts` — constructor injecting `IRequestService`, `INourlmsAuthService`, `ILogService`; private `request<T>(method, path, opts, token)` helper that (a) calls `IRequestService.request({ url: '/nourlms-api' + path, ... })`, (b) decodes JSON via `asJson`, (c) throws `ApiError` on non-2xx with `ApiError.toString()` returning the **normative shape** `<localized message> (<HTTP status>)` per FR-009 (extract `message` from upstream body, fall back to a localized default keyed by status), (d) triggers `INourlmsAuthService.logout()` on 401, and (e) wraps the call with `performance.mark()` start/end pairs and emits `performance.measure('nourlms.homework.api.<method>.<path>', start, end)` for the SC-003 overhead assertion (per `contracts/workbench-views.md` §2). **No per-story methods yet** — those are added in their respective US phases. Depends on T009.
- [X] T011 [P] Create `HomeworkPollingRegistry` in new file `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPolling.ts` with the concrete cadence from `research.md` §4 (initial 2 s, ×1.5 backoff, cap 15 s, ±20 % jitter, max 60 attempts, max 3 consecutive transient failures, max 5 concurrent active pollers). Depends on T010.
- [X] T012 [P] Create `NourlmsHomeworkPageManager` in new file `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPage.ts` — `open(request: OpenPageRequest)` builds an HTML body, calls `IWebviewWorkbenchService.openWebview(...)` with `group: SIDE_GROUP` and the locked-down options from `research.md` §2; maintains a `Map<string, WebviewInput>` keyed by `${kind}:${id}` and calls `revealWebview` on repeat opens (FR-007a); `closeAll()` disposes all. Depends on T010.
- [X] T013 [P] Create `INourlmsHomeworkTargetStudentService` + `NourlmsHomeworkTargetStudentService` in new file `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkTargetStudent.ts` — listens to `IWorkspaceContextService.onDidChangeWorkspaceFolders` + `onDidChangeWorkbenchState`, calls `GET /nourlms-workspaces/lookup?path=<encoded>` for the first folder, exposes `current: TargetStudent | undefined` and `onDidChange`; only active for admins (no-op when `nourlmsIsAdmin` is false). Register as a workbench singleton service.
- [X] T014 Create new file `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomework.contribution.ts` that registers (a) the icon `nourlmsHomeworkIcon` (`registerIcon('nourlms-homework-view-icon', Codicon.mortarBoard, ...)`) and (b) the view container `NOURLMS_HOMEWORK_VIEW_CONTAINER_ID` in `ViewContainerLocation.AuxiliaryBar` with `mergeViewWithContainerWhenSingleView: true` and `hideIfEmpty: true` per `contracts/workbench-views.md` §1. **Do NOT register any view yet** — those are added in story phases. Localized title `"Homework"`.
- [X] T015 Add side-effect import `import './homework/nourlmsHomework.contribution.js';` to `src/vs/workbench/contrib/nourlms/browser/nourlms.contribution.ts`. Depends on T014.

### Foundational tests (required by spec/contracts)

- [X] T016 [P] Unit tests for sidecar helpers in new file `src/vs/server/test/node/nourlmsAuthSidecar.test.ts` — round-trip write→read returns identical data; missing file returns `null`; malformed JSON returns `null`; `sanitizedName` mismatch returns `null`; file is mode `0o600` (per `contracts/server-workspaces.md` §7). Depends on T002.
- [X] T017 [P] Unit tests for the proxy in new file `src/vs/server/test/node/nourlmsApiProxy.test.ts` — every spec FR with an upstream endpoint maps to at least one allow-listed route; non-allow-listed path → 404; admin route called by student session → 404 (not 403); inbound `Authorization` and `Cookie` are stripped; upstream `Set-Cookie` is stripped; upstream 401 forwarded as `{"error":"Session expired"}`; upstream network error → 502 (per `contracts/server-proxy.md` §6). Depends on T003.
- [X] T017a [P] Add the **forged-ID test** for SC-005 to `src/vs/server/test/node/nourlmsApiProxy.test.ts`: with a student session, call `/nourlms-api/student/homeworks/<id-not-owned>` (mocked upstream returns 404 per API §3); assert the proxy forwards as 404 unmodified, doesn't re-shape the body, and doesn't log the upstream body content (only the status). Depends on T003.
- [X] T017b [P] Add the **timer-polling static-grep test** for FR-039 / SC-010 to `src/vs/server/test/node/nourlmsApiProxy.test.ts` (or its own file if cleaner): walk `src/vs/workbench/contrib/nourlms/browser/homework/**.ts` with a small AST/regex check and assert no `setInterval` or `setTimeout` call wraps an `IRequestService.request(...)` against any list endpoint (`/question-bank/questions`, `/admin/homeworks`, `/student/homeworks`, `/admin/homeworks/:id/submissions`, `/student/homeworks/:id/submissions`). Per `contracts/server-proxy.md` §6 last row. Depends on T003.
- [X] T018 [P] Unit tests for `HomeworkPollingRegistry` in new file `src/vs/workbench/contrib/nourlms/test/browser/homeworkPolling.test.ts` — honors cancellation immediately; reaches `gave-up` after 60 attempts; backoff capped at 15 s; transitions to `gave-up` after 3 consecutive transient errors; 6th simultaneous poll waits in queue (per `contracts/workbench-views.md` §3 test contract). Depends on T011.

**Checkpoint**: Foundation ready. The Homework container is registered (and hidden, because no view passes its `when` clause yet). All shared building blocks exist and are unit-tested. Story phases can now begin.

---

## Phase 3: User Story 1 - Student views and submits assigned homework (Priority: P1) 🎯 MVP

**Goal**: A signed-in student opens the Homework container, sees only their own assigned code homework, opens a question, and successfully submits a typed answer or a workspace-file's contents.

**Independent Test**: Sign in as a student whose account has at least one assigned `is_homework=true` code-type homework. Open the Secondary Side Bar → Homework. Confirm the homework list shows only that student's items. Open a homework, type "test answer", click Submit, confirm the submissions list updates and the backend records a new `QuestionAnswer` row. Re-open the question via "Open as Page" and confirm it appears as a regular editor tab beside the active group.

### Implementation for User Story 1

- [X] T019 [US1] Add student API methods to `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`: `listStudentHomeworks(filters, token)`, `getStudentHomework(id, token)`, `listStudentHomeworkCourses(token)`, `submitAnswer(homeworkId, payload, token)`, `listStudentSubmissions(homeworkId, filters, token)`, `getStudentSubmission(homeworkId, submissionId, token)` (signatures from `contracts/workbench-views.md` §2). Each calls the corresponding allow-listed `/nourlms-api/student/...` path.
- [X] T020 [US1] Create `NourlmsHomeworkStudentView extends ViewPane` in new file `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkStudentView.ts`: render a left-side homework list (paginated via "Load more" — FR-012), a right-side detail panel with sanitized question content (use `domSanitize.safeSetInnerHtml`), the **full set of FR-029 filter controls**: `course`, `subject`, `status` (`pending`/`corrected`), `is_ai_graded` (boolean dropdown), and date range (`date_from`/`date_to`); an answer textarea with **Submit** and **Submit from file…** buttons; a non-blocking loading indicator on every API call (FR-037); an inline error area that renders `apiError.toString()` directly (FR-009 normative shape); and the FR-013 tailored empty state localized via `nourlms.homework.student.empty` (different sub-messages for "no homework yet" vs "filters returned zero rows"). Implements FR-028, FR-029, FR-030, FR-031, FR-033. Depends on T019, T012.
- [X] T021 [US1] Implement the file-source helper for **Submit from file…** inside `nourlmsHomeworkStudentView.ts` (or a small co-located helper): browse the open workspace via `IFileService.resolve` + a quick-pick of relative paths, enforce 1 MB size cap before any read, run a UTF-8 + null-byte heuristic on the bytes, send `{ "content": <decoded text> }` to `submitAnswer`. Surfaces `nourlms.homework.student.submit.fileTooLarge` and `nourlms.homework.student.submit.binary` strings on rejection (per `research.md` §7 and `contracts/workbench-views.md` §7). Depends on T020.
- [X] T022 [US1] Implement the corrected-state submission block in `nourlmsHomeworkStudentView.ts`: when the loaded homework has `is_corrected = true` (or when any submission for it is corrected), disable both Submit controls and render the inline notice `nourlms.homework.student.submit.corrected`; on submit-click also re-fetch the homework state and abort the call on the race case (FR-033a + the race edge case in `spec.md`). Depends on T020.
- [X] T023 [US1] Wire **Open as Page** for the question in the student view: clicking the action calls `NourlmsHomeworkPageManager.open({ kind: 'question', id: question.id, title })` (FR-006, FR-007, FR-007a). Depends on T020, T012.
- [X] T024 [US1] Register the Student View in `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomework.contribution.ts` with id `NOURLMS_HOMEWORK_STUDENT_LIST_VIEW_ID`, `name: localize2('nourlms.homework.student.viewName', "My Homework")`, ctor `new SyncDescriptor(NourlmsHomeworkStudentView)`, `when: ContextKeyExpr.equals(NourlmsContextKeys.IsStudent, true)`, `singleViewPaneContainerTitle: "Homework"` (per `contracts/workbench-views.md` §1). Depends on T020.
- [X] T025 [P] [US1] Bundle isolation test in new file `src/vs/workbench/contrib/nourlms/test/browser/studentViewBundle.test.ts` — read the source of `nourlmsHomeworkStudentView.ts` (and its helper file from T021) and assert it contains **none** of the forbidden identifiers from `contracts/workbench-views.md` §6 (`assignHomework`, `triggerAiGrade`, `triggerRegrade`, `correctSubmission`, `createCodeQuestion`, `listAdminHomeworks`, `listAdminSubmissions`, `getAdminSubmission`, `listQuestions`, `getQuestion`) and **no** literal `'/admin/'` substring (satisfies SC-006a). Depends on T020, T021.

**Checkpoint**: User Story 1 is fully functional and testable independently. A student can sign in, see their homework, submit answers (typed or file), and open question details as side-by-side pages.

---

## Phase 4: User Story 2 - Admin assigns a code question to the currently opened student workspace (Priority: P1)

**Goal**: A signed-in admin who has opened a student's workspace via the existing Student Workspaces view can browse the question bank, pick code questions, and assign them to that student in one click without having to type the student's ID.

**Independent Test**: Sign in as admin. Open student "John"'s workspace via the existing Student Workspaces view. Open Secondary Side Bar → Homework → Question Bank. Confirm the header shows "John" as the target student (resolved via the new `/nourlms-workspaces/lookup` endpoint). Pick an existing code question, click **Assign to current student**, confirm the success toast (`Assigned 1 (0 already assigned)`) and verify in the backend that a new homework row was created for John + that question.

### Implementation for User Story 2

- [X] T026 [US2] Add admin API methods needed for assignment to `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`: `listQuestions(filters, token)`, `listCourses(filters, token)`, `listSubjects(filters, token)`, `listDifficultyRates(token)`, `listQuestionTypes(token)`, `assignHomework(payload, token)` (signatures from `contracts/workbench-views.md` §2). All hit `/nourlms-api/question-bank/*` and `/nourlms-api/admin/homeworks/assign`.
- [X] T027 [US2] Create `NourlmsHomeworkAdminQuestionBankView extends ViewPane` in new file `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminQuestionBankView.ts`: render a search input, filter dropdowns (course / subject / difficulty / type — populated from the lookup endpoints, cached for the workbench session per `data-model.md` §1.5), a paginated question list with type badges (FR-012), a target-student banner sourced from `INourlmsHomeworkTargetStudentService` (or "No student selected" when unresolved), per-row checkboxes for multi-select, a single **Assign to current student** action, a non-blocking loading indicator (FR-037), an inline error area rendering `apiError.toString()` (FR-009 normative shape), and the FR-013 tailored empty state localized via `nourlms.homework.admin.bank.empty` (different sub-messages for "the question bank is empty" vs "filters returned zero rows"). Implements FR-014, FR-015, FR-016, FR-018, FR-019. Depends on T026, T013.
- [X] T028 [US2] Implement assign-button enable/disable logic + tooltips in `nourlmsHomeworkAdminQuestionBankView.ts`: disabled with `nourlms.homework.admin.bank.assign.disabled.notCode` when any selected question is non-code; disabled with `nourlms.homework.admin.bank.assign.disabled.noStudent` when target student is unresolved (per `contracts/workbench-views.md` §7 + FR-015 / FR-018). Depends on T027.
- [X] T028a [P] [US2] **Assign-gating unit test** for SC-006 in new file `src/vs/workbench/contrib/nourlms/test/browser/adminAssignGating.test.ts`: construct `NourlmsHomeworkAdminQuestionBankView`'s assign-button predicate with (a) a code question + resolved target student → enabled, (b) a non-code question (e.g. `question_type: 'text'`) + resolved target student → disabled with `nourlms.homework.admin.bank.assign.disabled.notCode` tooltip, (c) any question + no target student → disabled with `nourlms.homework.admin.bank.assign.disabled.noStudent` tooltip, (d) mix of code + non-code in selection → disabled with the `notCode` tooltip. Depends on T027, T028.
- [X] T029 [US2] Implement the assign-result toast in `nourlmsHomeworkAdminQuestionBankView.ts` using `INotificationService`: render `Assigned N (M already assigned)` based on the API's `created_count` vs the requested count (FR-019); on `0 created` surface `Already assigned`. Depends on T027.
- [X] T030 [US2] Wire **Open as Page** for the question in this view: clicking the title calls `NourlmsHomeworkPageManager.open({ kind: 'question', id: question.id, title })` (same manager as US1; FR-007a dedup applies across views). Depends on T027.
- [X] T031 [US2] Register the Admin Question Bank view in `nourlmsHomework.contribution.ts` with id `NOURLMS_HOMEWORK_ADMIN_QUESTION_BANK_VIEW_ID`, `name: localize2('nourlms.homework.admin.bank.viewName', "Question Bank")`, ctor `new SyncDescriptor(NourlmsHomeworkAdminQuestionBankView)`, `order: 0`, `when: ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true)`. Depends on T027.

**Checkpoint**: User Stories 1 AND 2 both work independently. The MVP slice (assign + submit) is shippable.

---

## Phase 5: User Story 3 - Student reviews submissions and AI grading results (Priority: P2)

**Goal**: A student can list their previous submissions for a homework, open a submission to view the submitted answer + the AI grading result (when available), and the panel automatically polls for results on auto-correct homeworks. The student never sees any grading-trigger control.

**Independent Test**: As a student with at least one already-submitted auto-correct homework, open the panel, navigate to the submissions tab, confirm the panel polled and rendered the AI result fields (grade, hints, explanation). On a submission whose underlying question is **not** auto-correct, confirm the panel shows "Awaiting admin grading" and exposes no grading-trigger controls.

### Implementation for User Story 3

- [X] T032 [US3] Add shared AI-result API methods to `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`: `getAiGradingResult(resultId, token)`, `getLatestAiResult(homeworkId, submissionId, token)`, `pollAiResultStatus(homeworkId, submissionId, token)` (signatures from `contracts/workbench-views.md` §2).
- [X] T033 [US3] Add the **Submissions** sub-area to `nourlmsHomeworkStudentView.ts`: per-homework list of own submissions with submitted-at + AI status badge (`none` / `pending` / `ready`), paginated via "Load more" (FR-012), each row clickable to a detail surface that renders the submitted answer + the **latest** AI result fields (sanitized HTML for `explanation` and `best_answer_comparison` — historical results are permanently out of scope per FR-027 / `scope-decision-no-ai-grading-history.md`). Add the FR-013 tailored empty state localized via `nourlms.homework.student.submissions.empty` for "no submissions yet". Implements FR-034. Depends on T020 (US1), T032.
- [X] T034 [US3] Wire automatic polling in `nourlmsHomeworkStudentView.ts`: for each rendered submission whose underlying question has `is_auto_correct = true` and `latest_ai_result_id == null`, call `HomeworkPollingRegistry.poll(...)` and update the row state from the `onState` event. For submissions whose question is **not** auto-correct, render `Awaiting admin grading` with no polling and no buttons. Implements FR-035 + FR-035a. Depends on T011, T032, T033.
- [X] T035 [US3] Wire **Open as Page** for the submission and the AI result in the student view: `kind: 'submission'` and `kind: 'aiResult'` pages routed through `NourlmsHomeworkPageManager.open(...)` (FR-007a dedup applies). Depends on T012, T033.
- [X] T036 [P] [US3] **Re-run** the bundle isolation test from T025 against the post-US3 student view and confirm it still passes; only add new identifiers to the forbidden list if US3 introduces new admin-flavoured method names (none are expected — `getAiGradingResult` / `getLatestAiResult` / `pollAiResultStatus` are shared, not admin-only). Regression-protects SC-006a. Depends on T033, T034, T035.

**Checkpoint**: Student review loop is complete. US1 + US2 + US3 are all independently functional.

---

## Phase 6: User Story 4 - Admin reviews student submissions and runs AI grading (Priority: P2)

**Goal**: An admin in a student's workspace can list that student's assigned homework, drill into submissions, trigger AI grading (queued or sync), re-grade, and view historical results. Long content opens as side pages.

**Independent Test**: As admin in student "John"'s workspace, open the panel → Assigned to Current Student. Confirm the list shows only John's homework. Open a homework with at least one submission, click Run AI grade (queued), confirm the row flips to Pending then Ready. On a submission with an existing result, click Re-grade and confirm the same flow. Click Open as Page on the result and confirm it renders as a side editor tab.

### Implementation for User Story 4

- [X] T037 [US4] Add admin grading API methods to `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`: `listAdminHomeworks(filters, token)`, `listAdminSubmissions(homeworkId, filters, token)`, `getAdminSubmission(homeworkId, submissionId, token)`, `correctSubmission(homeworkId, submissionId, payload, token)`, `triggerAiGrade(homeworkId, payload, token)`, `triggerRegrade(homeworkId, payload, token)` (signatures from `contracts/workbench-views.md` §2).
- [X] T038 [US4] Create `NourlmsHomeworkAdminAssignedView extends ViewPane` in new file `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminAssignedView.ts`: header shows current target student (or "No student selected"); list of homeworks filtered server-side by `student_id = currentTargetStudent.userId` plus the optional FR-023 filters (`course_id`, `subject_id`, `status`, `is_ai_graded`); each row drills into a submissions list with the **full set of FR-024 filters**: `is_corrected`, `has_ai_result`, `date_from`, `date_to`; each submission opens a detail surface with **Run AI grade (queued)** / **Run AI grade (sync)** buttons (and **Re-grade** when the latest result exists — re-grade overwrites the same row in place per FR-027 / `scope-decision-no-ai-grading-history.md`). All lists are paginated via "Load more" (FR-012) with non-blocking loading indicators (FR-037), inline error areas rendering `apiError.toString()` (FR-009 normative shape), and FR-013 tailored empty states localized via `nourlms.homework.admin.assigned.empty` and `nourlms.homework.admin.assigned.submissions.empty` (each with distinct sub-messages for "nothing assigned yet" vs "filters returned zero rows"). Implements FR-023, FR-024, FR-025, FR-026, FR-027. Depends on T037, T013.
- [X] T039 [US4] Wire AI grading polling for queued/regrade flows in `nourlmsHomeworkAdminAssignedView.ts` using `HomeworkPollingRegistry`; sync mode shows a busy state and renders the inline result returned by the API. Depends on T011, T038.
- [X] T040 [US4] Wire **Open as Page** for both submission and AI result kinds from the admin assigned view (FR-007a dedup applies across views). Depends on T012, T038.
- [X] T041 [US4] Add the manual-correction modal (mark + correct_the_answer + is_corrected) wired to `correctSubmission(...)` in `nourlmsHomeworkAdminAssignedView.ts`. Depends on T038.
- [X] T042 [US4] Register the Admin Assigned view in `nourlmsHomework.contribution.ts` with id `NOURLMS_HOMEWORK_ADMIN_ASSIGNED_VIEW_ID`, `name: localize2('nourlms.homework.admin.assigned.viewName', "Assigned to Current Student")`, ctor `new SyncDescriptor(NourlmsHomeworkAdminAssignedView)`, `order: 1`, `when: ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true)`. Depends on T038.

**Checkpoint**: Admin grading loop is complete. US1 + US2 + US3 + US4 are all independently functional.

---

## Phase 7: User Story 5 - Admin creates a new "Write Code" question from the panel (Priority: P3)

**Goal**: An admin can create a new code-type question from inside the panel without leaving VS Code, then immediately assign it to the current target student via US2's flow.

**Independent Test**: As admin, open the Question Bank pane, click **New code question**, fill the form (content, course, subject, difficulty, weight, time, optional best/pre answers), submit. Confirm the new question appears at the top of the list and a follow-up assign-to-current-student call succeeds.

### Implementation for User Story 5

- [X] T043 [US5] Add `createCodeQuestion(payload, token)` and `getQuestion(id, token)` API methods to `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts` (signatures from `contracts/workbench-views.md` §2). Method MUST set `question_type_id` from the resolved code-type ID passed by the caller (no hard-coded numeric).
- [X] T044 [US5] Add the **New code question** form to `nourlmsHomeworkAdminQuestionBankView.ts`: a modal/inline form with the question `content` rendered as a **plain `<textarea>` accepting raw HTML** (admin pastes / writes HTML; the panel and "Open as Page" sanitise it on render — matches the existing upstream LMS web UI for the same field), course/subject/difficulty/weight/time inputs, optional `best_answer`/`pre_answer` plain textareas. The question type is **fixed to code** (no selector — FR-020). Validate required fields client-side. On 422, surface field-level errors inline against each offending field using the FR-009 normative shape (`<localized message> (422)`) without losing other input (FR-021). On 201, prepend the new question to the list (FR-022). Depends on T043, T027.

**Checkpoint**: All five user stories independently functional. Feature is feature-complete against `spec.md`.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T045 [P] Hook `NourlmsHomeworkPageManager.closeAll()` and `HomeworkPollingRegistry.dispose()` into `INourlmsAuthService.logout()` in `src/vs/workbench/services/nourlms/browser/nourlmsAuthService.ts` (so all open Homework pages close and all pollers stop on `/nourlms-logout`). Verifies the logout-cleanup case in `quickstart.md` §6.
- [X] T045a [P] **L10n lint** for FR-040 in new file `src/vs/workbench/contrib/nourlms/test/browser/l10n.test.ts`: walk every `.ts` file under `src/vs/workbench/contrib/nourlms/browser/homework/` and assert that no double-quoted English string longer than 3 characters appears outside a `localize(...)` / `localize2(...)` call (regex/AST scan; allow strings inside `console.*`, `logService.*`, `throw new Error(...)`, and JSDoc comments). Fails the build on any user-visible string that bypassed l10n.
- [X] T045b [P] **SC-003 panel-overhead assertion** in new file `src/vs/workbench/contrib/nourlms/test/browser/apiOverhead.test.ts`: instantiate `NourlmsHomeworkApi` with a stubbed `IRequestService` that resolves immediately with a 1 KB JSON body, drive 100 sequential calls per list method (`listStudentHomeworks`, `listAdminHomeworks`, `listAdminSubmissions`, `listStudentSubmissions`, `listQuestions`), read the `performance.measure(...)` entries emitted by T010's instrumentation, and assert the 95th-percentile **panel-side overhead** (mark-to-mark minus the stubbed `IRequestContext` resolve time) is < 50 ms per FR-009/SC-003.
- [X] T046 [P] Run `npm run compile` and fix any TypeScript errors introduced by this slice. **Do not modify code outside this feature** to fix pre-existing errors.
- [X] T047 [P] Run `npm run lint` (or the project equivalent of ESLint over `src/vs/workbench/contrib/nourlms/**` and `src/vs/server/node/nourlms*`) and fix any new lint errors introduced by this slice. **Do not touch pre-existing lint errors.**
- [X] T048 Run the unit-test suite for the new tests: `npm test -- --grep "nourlmsAuthSidecar|nourlmsApiProxy|HomeworkPollingRegistry|studentViewBundle|adminAssignGating|l10n|apiOverhead"`. All MUST pass.
- [X] T049 Run the manual smoke test in `quickstart.md` §0 through §6 end-to-end against a dev server. Confirm the Secondary Side Bar shows the Homework container, the role-gated views render correctly, every negative case in §6 behaves as documented, **plus** the new SC-005 (b) **manual penetration step**: while signed in as student A, manually edit the URL or use DevTools to issue a `GET /nourlms-api/student/homeworks/<id-belonging-to-student-B>` and confirm the panel surfaces the 404 cleanly without rendering any of B's data.
- [X] T050 [P] Update the existing `auth-plan.md` "Files Summary" table at the repo root to add the new files introduced by this slice (this is a docs-only edit that keeps the auth/structure overview current).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)** — no dependencies; can start immediately.
- **Phase 2 (Foundational)** — depends on Phase 1; **blocks all user-story phases**.
- **Phase 3 (US1, P1)** — depends on Phase 2 only.
- **Phase 4 (US2, P1)** — depends on Phase 2 only. Independent of US1; can run in parallel with Phase 3.
- **Phase 5 (US3, P2)** — depends on Phase 2 + US1 (extends `nourlmsHomeworkStudentView.ts`).
- **Phase 6 (US4, P2)** — depends on Phase 2 only. Independent of US1/US2/US3; can run in parallel with Phase 3/4/5 once Phase 2 is done.
- **Phase 7 (US5, P3)** — depends on Phase 2 + US2 (extends `nourlmsHomeworkAdminQuestionBankView.ts`).
- **Phase 8 (Polish)** — depends on every story phase that was actually shipped.

### Within-phase dependencies (the ones that matter)

- T004 ⟵ T003 ⟵ (none)
- T005 ⟵ T002
- T006 ⟵ T002
- T008 ⟵ T007
- T010 ⟵ T009
- T011 ⟵ T010
- T012 ⟵ T010
- T015 ⟵ T014
- T016 ⟵ T002; T017 ⟵ T003; T017a ⟵ T003; T017b ⟵ T003; T018 ⟵ T011
- T020 ⟵ T019, T012; T021/T022/T023 ⟵ T020; T024 ⟵ T020; T025 ⟵ T020+T021
- T027 ⟵ T026, T013; T028/T029/T030 ⟵ T027; T028a ⟵ T027+T028; T031 ⟵ T027
- T033 ⟵ T020 (US1), T032; T034 ⟵ T011+T032+T033; T035 ⟵ T012+T033; T036 ⟵ T033+T034+T035
- T038 ⟵ T037, T013; T039 ⟵ T011+T038; T040 ⟵ T012+T038; T041 ⟵ T038; T042 ⟵ T038
- T044 ⟵ T043, T027
- T045a ⟵ all view files (T020, T027, T033, T038, T044) — l10n lint runs after the views exist
- T045b ⟵ T010 (instrumentation) + T019/T026/T032/T037 (any one method) — perf assertion needs the API client + at least one list method

### Parallel opportunities

- **Within Phase 2**: T002, T003, T007, T009, T011, T012, T013 can all proceed in parallel (different files). T016, T017, T017a, T017b, T018 (foundational tests) can run in parallel with each other once their respective subjects exist.
- **Across stories once Phase 2 is done**: US1 (Phase 3), US2 (Phase 4), and US4 (Phase 6) are fully independent of each other and can be developed by three teammates in parallel.
- **US3 and US5** must wait for US1 and US2 respectively (because they extend the same view files); within US3 and US5 there are no internal parallel opportunities.
- **Foundational tests (T016, T017, T018)** can run in parallel with the start of any story phase whose foundations are complete — they don't gate code, they gate the constitution-style assertion that the foundations are correct.

---

## Parallel Example: Foundational Phase 2

```bash
# Three teammates, day 1 of Phase 2 — split server vs client vs tests:

# Teammate A — server foundations:
Task: "T002 Add writeWorkspaceSidecar/readWorkspaceSidecar to nourlmsAuth.ts"
Task: "T003 Create nourlmsApiProxy.ts (allow-list + handler)"

# Teammate B — client foundations:
Task: "T007 Extend INourlmsUserInfo with userId"
Task: "T009 Create homework/types.ts"
Task: "T011 Create HomeworkPollingRegistry"
Task: "T012 Create NourlmsHomeworkPageManager"
Task: "T013 Create NourlmsHomeworkTargetStudentService"

# Teammate C — wires + container:
# (waits briefly for T003 to compile, then T004; in parallel writes T014)
Task: "T014 Create nourlmsHomework.contribution.ts (container only)"

# Day 2 — wires + tests in parallel:
Task: "T004 Wire /nourlms-api/* into remoteExtensionHostAgentServer.ts"
Task: "T005 Extend _handleNourlmsWorkspaces + add lookup endpoint"
Task: "T006 Wire sidecar + userId in webClientServer.ts"
Task: "T008 Update nourlmsAuthService.ts to read userId"
Task: "T010 Create NourlmsHomeworkApi skeleton"
Task: "T015 Wire contribution import"

# Tests in parallel as their subjects land:
Task: "T016 Sidecar unit tests"
Task: "T017 Proxy unit tests"
Task: "T018 Polling registry unit tests"
```

---

## Parallel Example: Stories After Foundation

```bash
# Three teammates, all start once Phase 2 is green:

# Teammate A — US1 (P1, MVP half 1):
Task: "T019 Add student API methods"
Task: "T020 Create NourlmsHomeworkStudentView"
Task: "T021 Implement Submit-from-file helper"
Task: "T022 Implement corrected-state block"
Task: "T023 Wire Open-as-Page (question)"
Task: "T024 Register the Student View"
Task: "T025 Bundle isolation test"

# Teammate B — US2 (P1, MVP half 2) — fully independent of US1:
Task: "T026 Add admin assign API methods"
Task: "T027 Create NourlmsHomeworkAdminQuestionBankView"
Task: "T028 Assign-button gating + tooltips"
Task: "T029 Assign-result toast"
Task: "T030 Wire Open-as-Page (question)"
Task: "T031 Register the Admin Question Bank view"

# Teammate C — US4 (P2) — fully independent of US1/US2/US3:
Task: "T037 Add admin grading API methods"
Task: "T038 Create NourlmsHomeworkAdminAssignedView"
Task: "T039 Wire grading polling"
Task: "T040 Wire Open-as-Page (submission, result)"
Task: "T041 Manual-correction modal"
Task: "T042 Register the Admin Assigned view"

# Once US1 lands, the same person (or a fourth) picks up US3 (extends US1's view):
Task: "T032 Add shared AI-result API methods"
Task: "T033 Add Submissions sub-area to student view"
Task: "T034 Wire automatic polling for student"
Task: "T035 Wire Open-as-Page (submission, result) for student"
Task: "T036 Re-run bundle isolation test"

# Once US2 lands, the same person (or a fifth) picks up US5 (extends US2's view):
Task: "T043 Add createCodeQuestion + getQuestion API methods"
Task: "T044 Add New code question form to admin view"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

The headline workflow ("admin assigns, student submits") needs **both** P1 stories. Path to MVP:

1. Complete Phase 1 (Setup) — single task, < 1 hour.
2. Complete Phase 2 (Foundational) — about half the total work; the proxy + sidecar + container are the load-bearing pieces.
3. Complete Phase 3 (US1) and Phase 4 (US2) **in parallel** if you have two developers — each is roughly the same size as the other.
4. **STOP and VALIDATE**: run `quickstart.md` §0, §1, §2.
5. Deploy / demo.

### Incremental delivery after MVP

6. Layer Phase 5 (US3) on top of US1 — the student review loop. Validate.
7. Layer Phase 6 (US4) on top of foundation — the admin review loop (independent, can ship in parallel with US3). Validate.
8. Layer Phase 7 (US5) on top of US2 — the admin create-question shortcut. Validate.
9. Run Phase 8 (Polish) once everything else is in.

### Parallel team strategy

With three developers and Foundational complete:
- **Dev A** owns US1 (Phase 3) → US3 (Phase 5).
- **Dev B** owns US2 (Phase 4) → US5 (Phase 7).
- **Dev C** owns US4 (Phase 6) end-to-end + Polish (Phase 8).

This gives an MVP demo in ~1–2 weeks of focused work for a 3-person team and feature-complete in ~3 weeks.

---

## Notes

- `[P]` tasks = different files, no dependencies.
- `[US#]` label maps each story task back to its spec.md user story for traceability.
- Each story phase ends in a checkpoint that should be testable and shippable as-is.
- Tests are scoped to what `spec.md`'s success criteria and the contracts demand (sidecar, proxy, polling registry, student-view bundle isolation). No broader test scaffolding is generated by this `/speckit.tasks` run.
- Commit after each task or each logical group of tasks (e.g., one commit per story phase).
- Avoid cross-story changes in non-foundation files unless the change is small and orthogonal.
