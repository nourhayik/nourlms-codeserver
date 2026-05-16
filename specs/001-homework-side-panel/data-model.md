# Phase 1 — Data Model: NourLMS Homework Side Panel

This panel **stores no domain data of its own**. All persistent state lives in the upstream NourLMS database (accessed through the API documented in `documentation/Homework_AI_Grading_API.md`). The model below captures (a) the upstream entities the panel reads/writes, (b) the **client-side TypeScript types** that mirror those upstream JSON shapes, and (c) the **two pieces of local state** the implementation introduces (the workspace sidecar and the in-memory polling registry).

---

## 1. Upstream entities (read-only mirror types in TypeScript)

These types live in `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts` and mirror the API resources exactly; they MUST NOT add fields the API doesn't return. Each shape is a faithful TypeScript projection of the API's JSON `data` payload.

### 1.1 `Question`

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | Primary key in upstream Question Bank. |
| `content` | `string` (HTML) | Sanitized via `domSanitize` before any DOM insertion. |
| `course_id` | `number` | Foreign key. |
| `question_subject_id` | `number` | Foreign key. |
| `question_type_id` | `number` | Panel only handles the `code` type (mapped from the lookup endpoint). |
| `question_type` | `'code' \| 'text' \| 'textarea' \| 'rb' \| 'cb'` | Resolved from the type lookup; the panel filters its assign action to `code` only (FR-015). |
| `difficulty_rate_id` | `number` | Foreign key. |
| `weight` | `number` | Marks. |
| `is_homework` | `boolean` | Indicates the question is a candidate for homework assignment. |
| `is_auto_correct` | `boolean` | Drives whether AI grading is dispatched on submission (per API §7.4). The Student View uses this to decide whether to poll. |
| `time_in_second` | `number` | Time limit; informational in the panel. |
| `best_answer` | `string \| null` | HTML (sanitized at render); only revealed in the Student View when the homework is corrected (per API §7.3). |
| `pre_answer` | `string \| null` | Boilerplate / starter code; shown in the question detail page. |

**Validation rules in the panel**:
- For "Assign to current student" (admin), `question_type` MUST be `'code'`. The button is disabled otherwise.
- For "New code question" (admin), the create payload MUST set `question_type_id` to the code type ID resolved from the type lookup; the panel doesn't expose any other type.

### 1.2 `Homework`

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | Assignment row. |
| `user_id` | `number` | Target student. The Admin View only fetches/displays homework where `user_id` equals the current target student (resolved server-side via `student_id` filter). |
| `question_id` | `number` | FK to `Question`. |
| `question` | `Question` | Embedded by the API. |
| `student` | `{ id: number; name: string; phone: string }` | Embedded; used for display in admin lists. |
| `is_corrected` | `boolean` | When `true`, the Student View blocks new submissions for this homework (FR-033a). |
| `mark` | `number \| null` | Manual correction mark, set by admin via `/admin/homeworks/{id}/submissions/{sid}/correct`. |
| `correct_the_answer` | `string \| null` | Manual feedback text from admin. |
| `created_at` | `string` (ISO 8601) | Assignment date. |

**State transitions (server-side, surfaced in panel)**:
```
[assigned] --(student submits)--> [has submissions]
                                         |
                                         v
                          [admin manually corrects → is_corrected=true]
```
The panel never mutates `is_corrected` directly; that's a server-side effect of the admin's PATCH `/admin/homeworks/{id}/submissions/{sid}/correct` call.

### 1.3 `HomeworkSubmission` (= `QuestionAnswer` row)

| Field | Type | Notes |
|---|---|---|
| `id` | `number` | Submission ID returned by `/student/homeworks/{id}/submit`. |
| `homework_id` | `number` | FK. |
| `content` | `string` | The submitted answer text. |
| `submitted_at` | `string` (ISO 8601) | |
| `is_corrected` | `boolean` | Reflects the parent Homework's `is_corrected`. |
| `latest_ai_result_id` | `number \| null` | Pointer to most recent `AiGradingResult`. |

### 1.4 `AiGradingResult`

> **Scope note**: The panel surfaces only the **latest** `AiGradingResult` per submission (per FR-027 and the upstream API), **permanently**. On re-grade, the upstream updates the same row in place and stamps `regraded_at`; previous-version data is overwritten and we do not preserve it client-side. Listing historical results is intentionally not in scope and is **not** deferred to a future slice — see `scope-decision-no-ai-grading-history.md` for the rationale.


| Field | Type | Notes |
|---|---|---|
| `id` | `number` | |
| `grade` | `number` | |
| `question_type` | `'code' \| ...` | Echo of the question type for grading-result rendering. |
| `syntax_error` | `string \| null` | |
| `hint_syntax_fix` | `string \| null` | |
| `logical_error` | `string \| null` | |
| `hint_logical_fix` | `string \| null` | |
| `explanation` | `string` | HTML-allowable; sanitized on render. |
| `best_answer_comparison` | `string \| null` | HTML-allowable; sanitized on render. |
| `grading_provider` | `string` | e.g. `"gemini"`. |
| `graded_at` | `string` (ISO 8601) | |
| `regraded_at` | `string \| null` (ISO 8601) | Set when admin triggers re-grade. |
| `test_cases` | `unknown[]` | Pass-through; rendered as a collapsible JSON section. |
| `option_notes` | `unknown[]` | Pass-through. |
| `gradable_type` | `string` | e.g. `"App\\Models\\Homework"`. |
| `gradable_id` | `number` | The homework or quiz row this result belongs to. |

### 1.5 Lookup entities

| Entity | Source endpoint | Shape |
|---|---|---|
| `Course` | `GET /question-bank/courses` | `{ id, name, university_id? }` |
| `Subject` | `GET /question-bank/subjects` (and `…/courses/{id}/subjects`) | `{ id, name, course_id }` |
| `DifficultyRate` | `GET /question-bank/difficulty-rates` | `{ id, name }` |
| `QuestionType` | `GET /question-bank/question-types` | `{ id, key }` where `key` matches `Question.question_type` |

The panel caches lookup responses **for the lifetime of the workbench session** (no TTL refresh) since these values change very rarely and refreshing them on every list call would burn the throttle.

---

## 2. AI grading polling state (in-memory, per-session)

Held by `nourlmsHomeworkPolling.ts`. Not persisted.

```ts
type PollerState = 'idle' | 'pending' | 'ready' | 'error' | 'gave-up';

interface PollerEntry {
    homeworkId: number;
    submissionId: number;
    state: PollerState;
    attempts: number;          // bounded: max 60 per research.md §4
    consecutiveErrors: number; // bounded: max 3 then surface "Check again"
    nextDelayMs: number;       // 2000, then × 1.5 ± 20% jitter, capped 15000
    cancellation: CancellationTokenSource;
    onChange: Emitter<PollerEntry>;
}

class HomeworkPollingRegistry {
    private readonly entries = new Map<string, PollerEntry>(); // key: `${homeworkId}:${submissionId}`
    private readonly maxConcurrent = 5;
    private readonly waitQueue: PollerEntry[] = [];
    // ...lifecycle: dispose() cancels all entries; setVisible(false) on a view cancels its entries
}
```

**Lifecycle rules**:
- A poller is created when the Student View renders a submission whose underlying question has `is_auto_correct = true` and `latest_ai_result_id == null`.
- A poller is created when the Admin View triggers `POST /admin/homeworks/{id}/ai-grade` in `mode: 'queued'` or `POST .../regrade`.
- A poller is **never** created from the Student View as a result of student interaction — only as a side effect of opening a submission that is already pending.
- A poller is destroyed on success (state `ready`), on giving up (state `gave-up`), or when the owning view is hidden / the container is closed.
- At most 5 pollers are active simultaneously per panel session; further entries wait in `waitQueue` until a slot frees.

---

## 3. Workspace sidecar (server-side local file)

A single JSON file written to disk at `<studentWorkspacePath>/.nourlms-user.json`. Schema:

```json
{
    "userId": 42,
    "name": "Ahmed Al-Rashid",
    "sanitizedName": "ahmedalrashid",
    "writtenAt": "2026-05-04T08:00:00.000Z",
    "writtenBy": "nourlms-codeserver"
}
```

| Field | Type | Notes |
|---|---|---|
| `userId` | `integer` | LMS user ID for this student. |
| `name` | `string` | Original (un-sanitized) display name as returned by `/api/auth/login`. |
| `sanitizedName` | `string` | Same value as the parent directory name; redundant but useful for self-validation when reading. |
| `writtenAt` | `string` (ISO 8601) | Last write timestamp. |
| `writtenBy` | `string` | Constant `"nourlms-codeserver"` for traceability. |

**Write path**: `webClientServer.ts` calls a new helper `nourlmsAuth.writeWorkspaceSidecar(workspacePath, session)` immediately after `ensureWorkspaceDir(...)` (`webClientServer.ts:347–349`). The write is idempotent — overwrites with the latest values on every login.

**Read path**:
- `_handleNourlmsWorkspaces` in `remoteExtensionHostAgentServer.ts` calls a new helper `nourlmsAuth.readWorkspaceSidecar(workspacePath)` for each enumerated workspace and merges the result into the response.
- A new endpoint `GET /nourlms-workspaces/lookup?path=<encoded-path>` (admin-only) calls the same helper for a single path.

**File mode / visibility**:
- Created with mode `0o600` (owner-only).
- Excluded from the explorer for student sessions via the existing default-settings injection in `webClientServer.ts` — add `".nourlms-user.json": true` to `files.exclude` in the `configurationDefaults` (workbench config — see `webClientServer.ts:393–397`).
- For admin sessions the file is harmless (admins already have full visibility into student workspaces).

**Failure modes**:
- Sidecar missing → workspace listing still includes the entry, but with `userId: undefined`. The admin's "Assign to current student" action shows "No student selected" (per FR-016/FR-018).
- Sidecar present but malformed → treated as missing (logged via `_logService`).

---

## 4. Client-visible session shape

Extension to the existing `INourlmsUserInfo` (`src/vs/workbench/services/nourlms/common/nourlms.ts:10–14`):

```ts
export interface INourlmsUserInfo {
    readonly name: string;
    readonly role: 'admin' | 'student';
    readonly workspacePath: string;
    /** NEW: LMS user ID of the signed-in user. Already lives in the encrypted session
     *  cookie; this exposes it to the workbench so the Student View can build URLs
     *  like /nourlms-api/student/homeworks without an extra round-trip. */
    readonly userId: number;
}
```

The server's existing template-variable injection (`webClientServer.ts:351–353`) is updated to include `userId: nourlmsSession.userId`, so the meta-tag JSON read by `nourlmsAuthService.ts:55–71` will already contain the field. `_readUserInfoFromDom` is updated to read `userId` (with a fallback to `0` if absent for backward-compat during deploy).

---

## 5. "Open as Page" page registry (in-memory)

Held by `nourlmsHomeworkPage.ts`. Not persisted.

```ts
type PageKind = 'question' | 'submission' | 'aiResult';

interface PageKey {
    kind: PageKind;
    id: number;
}

class NourlmsHomeworkPageManager {
    private readonly inputs = new Map<string, WebviewInput>(); // key: `${kind}:${id}`
    open(kind: PageKind, id: number): Promise<void>;
    revealOrOpen(kind: PageKind, id: number): Promise<void>;
    dispose(): void; // closes all open pages on logout / panel-disposal
}
```

This is the dedup mechanism for FR-007a ("repeated opens reveal the existing tab"). Disposal on logout addresses the `nourlms-logout` flow.

---

## 6. Cross-entity invariants surfaced by the panel

| Invariant | Where enforced | Reference |
|---|---|---|
| Only `code`-type questions can be assigned | Admin View disables the assign control for non-code; server proxy allow-list still permits the call but the spec test (SC-006) verifies UI gating. | FR-015, SC-006 |
| Students never trigger AI grading | Student View bundle imports no admin-grading-API methods; runtime + static checks per SC-006a. | FR-035, FR-035a, FR-036 |
| Submission to a corrected homework is blocked | Student View checks `homework.is_corrected` (re-fetch on submit-click for the race case) before calling `/student/homeworks/{id}/submit`. | FR-033a, edge-cases |
| Same item never opens as a duplicate page | `NourlmsHomeworkPageManager` consults its `inputs` map and calls `revealWebview` on hit. | FR-007a, SC-009 |
| Sanctum bearer token never reaches the browser | All upstream calls go through `/nourlms-api/*`; server-side proxy attaches `Authorization: Bearer <Sanctum token>` from the encrypted session. | FR-011 |
| 401 from any panel call → re-login | API client wraps `IRequestService.request`; on `res.statusCode === 401` it triggers `INourlmsAuthService.logout()` (which navigates to `/nourlms-login`). | FR-010, SC-007 |

---

## 7. What is *not* modeled here

- No new **persistent local storage** outside the workspace sidecar. The lookup cache for courses/subjects/difficulty/types lives in memory only, scoped to the workbench session.
- No **client-side caching** of homeworks / submissions / results across page loads (refresh on first view + on user-triggered refresh per FR-039).
- No **telemetry** added (the existing `ITelemetryService` is left untouched; the panel emits no telemetry events).
- No new database, no new schema, no migration.

---

## 8. Schema-evolution risk

The mirror types in §1 follow the upstream JSON shape exactly. If the upstream adds new fields, the panel's `IRequestService` + `asJson` path tolerates them (extra fields are ignored). If the upstream **removes** a field, the panel will surface `undefined`s wherever that field is read; the API client wraps each per-field read with optional-chaining so a missing field degrades to "—" in the UI rather than throwing.
