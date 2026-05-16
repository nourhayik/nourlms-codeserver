# Contract: Workbench Views, API Client, and "Open as Page"

This contract defines the client-side surfaces of the Homework side panel: the view container + view registrations in the Auxiliary Bar, the typed API client over `/nourlms-api/*`, the AI grading polling helper, and the webview-based "Open as Page" manager. Everything described here is in-tree TypeScript that lives under `src/vs/workbench/contrib/nourlms/browser/homework/`.

---

## 1. View container & view IDs

All IDs are stable strings (used by view-state persistence and command predicates). They MUST NOT change after this slice ships.

| Constant | String | Purpose |
|---|---|---|
| `NOURLMS_HOMEWORK_VIEW_CONTAINER_ID` | `workbench.view.nourlms.homework` | Auxiliary Bar container (host of the views below). |
| `NOURLMS_HOMEWORK_STUDENT_LIST_VIEW_ID` | `workbench.view.nourlms.homework.studentList` | Student View — assigned homework list + open-as-page actions. |
| `NOURLMS_HOMEWORK_ADMIN_QUESTION_BANK_VIEW_ID` | `workbench.view.nourlms.homework.adminQuestionBank` | Admin View — question bank list with filters + assign + create. |
| `NOURLMS_HOMEWORK_ADMIN_ASSIGNED_VIEW_ID` | `workbench.view.nourlms.homework.adminAssigned` | Admin View — homework + submissions assigned to the **current target student**. |

Container registration (single call):

```ts
const container = viewContainerRegistry.registerViewContainer(
    {
        id: NOURLMS_HOMEWORK_VIEW_CONTAINER_ID,
        title: localize2('nourlmsHomework', "Homework"),
        ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NOURLMS_HOMEWORK_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
        icon: nourlmsHomeworkIcon, // registerIcon('nourlms-homework-view-icon', Codicon.mortarBoard, ...)
        order: 6,                  // after Student Workspaces (order 5) in the Sidebar; this order applies to the AuxBar composite strip
        hideIfEmpty: true,         // hidden when no view passes its `when` (i.e. unauthenticated or unknown role)
        storageId: NOURLMS_HOMEWORK_VIEW_CONTAINER_ID,
    },
    ViewContainerLocation.AuxiliaryBar,
    { doNotRegisterOpenCommand: false } // we want the auto-generated "Show Homework" command
);
```

View registrations:

```ts
viewsRegistry.registerViews(
    [
        {
            id: NOURLMS_HOMEWORK_STUDENT_LIST_VIEW_ID,
            name: localize2('nourlmsHomework.student', "My Homework"),
            ctorDescriptor: new SyncDescriptor(NourlmsHomeworkStudentView),
            canToggleVisibility: false,
            when: ContextKeyExpr.equals(NourlmsContextKeys.IsStudent, true),
            containerIcon: nourlmsHomeworkIcon,
            singleViewPaneContainerTitle: localize2('nourlmsHomework', "Homework").value,
        },
        {
            id: NOURLMS_HOMEWORK_ADMIN_QUESTION_BANK_VIEW_ID,
            name: localize2('nourlmsHomework.admin.bank', "Question Bank"),
            ctorDescriptor: new SyncDescriptor(NourlmsHomeworkAdminQuestionBankView),
            canToggleVisibility: true,
            order: 0,
            when: ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true),
            containerIcon: nourlmsHomeworkIcon,
        },
        {
            id: NOURLMS_HOMEWORK_ADMIN_ASSIGNED_VIEW_ID,
            name: localize2('nourlmsHomework.admin.assigned', "Assigned to Current Student"),
            ctorDescriptor: new SyncDescriptor(NourlmsHomeworkAdminAssignedView),
            canToggleVisibility: true,
            order: 1,
            when: ContextKeyExpr.equals(NourlmsContextKeys.IsAdmin, true),
            containerIcon: nourlmsHomeworkIcon,
        },
    ],
    container
);
```

### When-clause matrix

| Role at runtime | Visible views | UI result |
|---|---|---|
| `nourlmsIsStudent` true | Student View only (1 view) | Container chrome merged via `mergeViewWithContainerWhenSingleView`; user sees a clean single pane labeled "Homework". |
| `nourlmsIsAdmin` true | Question Bank + Assigned (2 views) | Two collapsible stacked panes inside one container labeled "Homework". |
| Neither (no session, broken meta tag) | none | `hideIfEmpty: true` hides the container entirely. |

---

## 2. `INourlmsHomeworkApi` (typed client)

**File**: `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`

```ts
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Question, Homework, HomeworkSubmission, AiGradingResult,
    Course, Subject, DifficultyRate, QuestionType, Paginated } from './types.js';

export interface QuestionListFilters {
    search?: string;
    course_id?: number;
    subject_id?: number;
    difficulty_id?: number;
    type_id?: number;
    per_page?: number;
    page?: number;
}

export interface AdminHomeworkListFilters {
    student_id?: number;
    course_id?: number;
    subject_id?: number;
    question_type_id?: number;
    status?: 'pending' | 'corrected';
    is_ai_graded?: boolean;
    date_from?: string;
    date_to?: string;
    search?: string;
    per_page?: number;
    page?: number;
}

export interface StudentHomeworkListFilters {
    course_id?: number;
    subject_id?: number;
    status?: 'pending' | 'corrected';
    is_ai_graded?: boolean;
    date_from?: string;
    date_to?: string;
    per_page?: number;
    page?: number;
}

export interface SubmissionListFilters {
    is_corrected?: boolean;
    has_ai_result?: boolean;
    date_from?: string;
    date_to?: string;
    per_page?: number;
    page?: number;
}

export interface CreateCodeQuestionPayload {
    content: string;
    course_id: number;
    question_subject_id: number;
    difficulty_rate_id: number;
    weight: number;
    is_homework: boolean;
    is_auto_correct: boolean;
    time_in_second: number;
    best_answer?: string;
    pre_answer?: string;
    /** Caller MUST pass the resolved code-type ID; the API client doesn't hard-code numbers. */
    question_type_id: number;
}

export interface AssignHomeworkPayload {
    user_ids: number[];
    question_ids: number[];
}

export interface CorrectionPayload {
    mark?: number;
    correct_the_answer?: string;
    is_corrected?: boolean;
}

export interface SubmitAnswerPayload {
    content: string;
}

export interface AiGradePayload {
    submission_id: number;
    mode?: 'sync' | 'queued';
}

export interface RegradePayload {
    submission_id: number;
}

export interface AiResultStatus {
    state: 'pending' | 'ready';
    result_id?: number;
    graded_at?: string;
}

export interface ApiError {
    status: number;             // HTTP status of the upstream response
    message?: string;           // upstream `message` if any
    fieldErrors?: Record<string, string[]>; // upstream 422 errors
    raw?: unknown;

    /**
     * Normative rendering shape per FR-009: `<localized message> (<HTTP status>)`.
     * Examples:
     *   "Session expired (401) — please sign in again"
     *   "Too many requests (429) — retrying…"
     *   "Validation failed (422) — content is required"
     * Views MUST render `error.toString()` directly without per-view formatting.
     */
    toString(): string;
}

/**
 * Typed wrapper over IRequestService that hits /nourlms-api/* on the same origin.
 * NEVER imported by Student-View files for any admin-only method (compile-time
 * test in tests/unit/nourlms-student-view-bundle.test.ts asserts this).
 */
export class NourlmsHomeworkApi {
    constructor(@IRequestService requestService: IRequestService);

    // ---- Student methods ----
    listStudentHomeworks(filters: StudentHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>>;
    getStudentHomework(id: number, token: CancellationToken): Promise<Homework>;
    listStudentHomeworkCourses(token: CancellationToken): Promise<Course[]>;
    submitAnswer(homeworkId: number, payload: SubmitAnswerPayload, token: CancellationToken): Promise<{ submission_id: number; message: string }>;
    listStudentSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>>;
    getStudentSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission>;

    // ---- Admin methods (must NOT be imported by Student-View files) ----
    listQuestions(filters: QuestionListFilters, token: CancellationToken): Promise<Paginated<Question>>;
    getQuestion(id: number, token: CancellationToken): Promise<Question>;
    createCodeQuestion(payload: CreateCodeQuestionPayload, token: CancellationToken): Promise<Question>;
    listCourses(filters: { search?: string; university_id?: number }, token: CancellationToken): Promise<Course[]>;
    listSubjects(filters: { search?: string; course_id?: number }, token: CancellationToken): Promise<Subject[]>;
    listDifficultyRates(token: CancellationToken): Promise<DifficultyRate[]>;
    listQuestionTypes(token: CancellationToken): Promise<QuestionType[]>;
    listAdminHomeworks(filters: AdminHomeworkListFilters, token: CancellationToken): Promise<Paginated<Homework>>;
    assignHomework(payload: AssignHomeworkPayload, token: CancellationToken): Promise<{ created_count: number; items: Homework[] }>;
    listAdminSubmissions(homeworkId: number, filters: SubmissionListFilters, token: CancellationToken): Promise<Paginated<HomeworkSubmission>>;
    getAdminSubmission(homeworkId: number, submissionId: number, token: CancellationToken): Promise<HomeworkSubmission>;
    correctSubmission(homeworkId: number, submissionId: number, payload: CorrectionPayload, token: CancellationToken): Promise<Homework>;
    triggerAiGrade(homeworkId: number, payload: AiGradePayload, token: CancellationToken): Promise<{ mode: 'queued'; message: string } | { mode: 'sync'; result: AiGradingResult }>;
    triggerRegrade(homeworkId: number, payload: RegradePayload, token: CancellationToken): Promise<{ message: string; grading_result_id: number }>;

    // ---- Shared methods (both roles) ----
    getAiGradingResult(resultId: number, token: CancellationToken): Promise<AiGradingResult>;
    /** Returns the LATEST AiGradingResult for the submission (per FR-027). On re-grade,
     *  the upstream updates this same row in place and stamps `regraded_at`. The panel
     *  PERMANENTLY surfaces only the latest result; listing historical grading attempts
     *  is intentionally out of scope. See scope-decision-no-ai-grading-history.md for
     *  the rationale and rejected alternatives. */
    getLatestAiResult(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiGradingResult>;
    pollAiResultStatus(homeworkId: number, submissionId: number, token: CancellationToken): Promise<AiResultStatus>;
}
```

**Error handling**: every method rejects with `ApiError` on non-2xx. The API client builds the error's localized `message` from the response body (`message` field, or the first `errors[*][0]` for 422), then `ApiError.toString()` MUST emit the normative `<localized message> (<HTTP status>)` shape from FR-009 so views can call `error.toString()` directly without per-view formatting. If `status === 401`, the API client also calls `INourlmsAuthService.logout()` to trigger redirect to `/nourlms-login` (FR-010).

**Cancellation**: every method threads `CancellationToken` to `IRequestService.request(...)`. Views that hide / are disposed cancel all in-flight calls (FR-037).

**Performance instrumentation (SC-003)**: the private `request<T>(...)` helper MUST wrap the `IRequestService.request(...)` call with `performance.mark()` start/end pairs and emit a single `performance.measure('nourlms.homework.api.<method>.<path>', start, end)` per call. The polish-phase `performance.mark` assertion task reads these measures and asserts the panel-side overhead (mark-to-mark minus the `IRequestContext` resolution time) is under 50 ms at p95 across the smoke run.

---

## 3. AI grading polling helper

**File**: `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPolling.ts`

```ts
export interface PollOptions {
    homeworkId: number;
    submissionId: number;
}

export type PollState =
    | { kind: 'pending'; attempts: number }
    | { kind: 'ready'; resultId: number; gradedAt: string }
    | { kind: 'transient-error'; attempts: number; lastStatus?: number }
    | { kind: 'gave-up'; attempts: number; reason: string };

export class HomeworkPollingRegistry {
    constructor(
        @INourlmsHomeworkApi api: NourlmsHomeworkApi,
        @ILogService logService: ILogService
    );

    /** Returns an Event<PollState> stream and a Disposable to cancel/free the poller. */
    poll(opts: PollOptions): { onState: Event<PollState>; cancel: IDisposable };

    /** Cancels and disposes everything (called on container hide / logout). */
    dispose(): void;
}
```

**Concrete cadence** (from research.md §4):

| Setting | Value |
|---|---|
| Initial delay | 2000 ms |
| Backoff multiplier | 1.5 |
| Cap | 15000 ms |
| Per-call jitter | ±20% (random) |
| Max attempts | 60 |
| Max consecutive transient errors before "gave-up" | 3 |
| Max concurrent active pollers | 5 (others queue) |

**Test contract**:

| Test | Expected |
|---|---|
| Honors cancellation immediately. | `cancel()` stops further timers. |
| Stops after 60 attempts with `gave-up` if upstream stays `pending`. | True. |
| Backoff cap holds at 15 s. | True. |
| 3rd consecutive transient failure transitions to `gave-up`. | True. |
| 6th simultaneous `poll(...)` waits in queue until a slot frees. | True. |

---

## 4. "Open as Page" manager

**File**: `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPage.ts`

```ts
export type PageKind = 'question' | 'submission' | 'aiResult';

export interface OpenPageRequest {
    kind: PageKind;
    id: number;            // question_id, submission_id, or ai_result_id
    homeworkId?: number;   // required for 'submission' and 'aiResult'
    title: string;         // localized tab title
}

export class NourlmsHomeworkPageManager extends Disposable {
    constructor(
        @IWebviewWorkbenchService webviewWorkbenchService: IWebviewWorkbenchService,
        @INourlmsHomeworkApi api: NourlmsHomeworkApi,
        @IEditorService editorService: IEditorService,
        @ILogService logService: ILogService
    );

    /**
     * Opens the page beside the active editor group (SIDE_GROUP).
     * If a webview for the same (kind,id) exists, reveals it instead of creating a new one.
     */
    open(request: OpenPageRequest): Promise<void>;

    /** Closes all webviews managed here (called on logout / container disposal). */
    closeAll(): void;
}
```

**Webview options** (from research.md §2):

```ts
{
    title,
    options: {
        enableFindWidget: true,
        disableServiceWorker: true,
        tryRestoreScrollPosition: true,
    },
    contentOptions: {
        allowScripts: false,
        allowForms: false,
        localResourceRoots: [],
        enableCommandUris: false,
    },
    extension: undefined,
    iconPath: undefined,
}
```

The page is opened with `group: SIDE_GROUP` from `src/vs/workbench/services/editor/common/editorService.js`.

**Body construction**: HTML template literal that:
1. Injects a strict CSP `<meta>` matching the existing webview pre-document.
2. Renders structured fields (id, dates, status badges) as plain DOM.
3. Renders rich content fields (question content, best_answer, explanation, comparison) as sanitized HTML using `domSanitize.safeSetInnerHtml` (called inside the webview HTML template's bootstrap script that runs AFTER receiving the data via `webview.postMessage`).

**Dedup**: the manager keeps a `Map<string, WebviewInput>` keyed by `${kind}:${id}`. On `open(...)`, if the input is present and not disposed, call `webviewWorkbenchService.revealWebview(input, group)` instead of creating a new one (mirrors `ReleaseNotesManager` in `src/vs/workbench/contrib/update/browser/releaseNotesEditor.ts:106–122`).

---

## 5. Target-student resolver (admin-only)

**File**: `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkTargetStudent.ts`

```ts
export interface TargetStudent {
    userId: number;
    name: string;
    workspacePath: string;
}

export interface INourlmsHomeworkTargetStudentService {
    readonly _serviceBrand: undefined;
    readonly current: TargetStudent | undefined;
    readonly onDidChange: Event<TargetStudent | undefined>;
}

export class NourlmsHomeworkTargetStudentService extends Disposable implements INourlmsHomeworkTargetStudentService {
    constructor(
        @IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
        @IRequestService requestService: IRequestService,
        @ILogService logService: ILogService
    );
    // Listens to onDidChangeWorkspaceFolders + onDidChangeWorkbenchState.
    // For each folder change:
    //  1. Take the first folder of the workspace.
    //  2. GET /nourlms-workspaces/lookup?path=<encoded>.
    //  3. On 200 → set `current` and fire onDidChange.
    //  4. On 404/403 → set `current = undefined` and fire onDidChange.
}
```

Registered as a workbench-singleton service so the Admin views read it lazily (no fetching when no admin view is mounted).

---

## 6. View → service wiring

| View | Imports | Services |
|---|---|---|
| `NourlmsHomeworkStudentView` | `NourlmsHomeworkApi` (student methods only), `HomeworkPollingRegistry`, `NourlmsHomeworkPageManager`, `IFileService` (for "Submit from file") | `IRequestService`, `IFileService`, `IWorkspaceContextService` |
| `NourlmsHomeworkAdminQuestionBankView` | `NourlmsHomeworkApi`, `NourlmsHomeworkPageManager`, `INourlmsHomeworkTargetStudentService` | `IRequestService`, `IInstantiationService`, `INotificationService` |
| `NourlmsHomeworkAdminAssignedView` | `NourlmsHomeworkApi`, `HomeworkPollingRegistry`, `NourlmsHomeworkPageManager`, `INourlmsHomeworkTargetStudentService` | `IRequestService`, `IInstantiationService`, `IDialogService` |

**Static-import discipline (test in `tests/unit/nourlms-student-view-bundle.test.ts`)**:

```ts
// student view file MUST NOT import any of these:
- NourlmsHomeworkApi.assignHomework
- NourlmsHomeworkApi.triggerAiGrade
- NourlmsHomeworkApi.triggerRegrade
- NourlmsHomeworkApi.correctSubmission
- NourlmsHomeworkApi.createCodeQuestion
- NourlmsHomeworkApi.listAdminHomeworks
- NourlmsHomeworkApi.listAdminSubmissions
- NourlmsHomeworkApi.getAdminSubmission
- NourlmsHomeworkApi.listQuestions / getQuestion (admin question bank)
```

A regex-based unit test scans the file source for these identifiers and fails if any are found, satisfying SC-006a's static-bundle check.

---

## 7. Localization namespace

All strings use the prefix `nourlms.homework.`. Reserved keys this slice introduces:

```
nourlms.homework.container.title           → "Homework"
nourlms.homework.container.icon            → "View icon of the NourLMS Homework view."
nourlms.homework.student.viewName          → "My Homework"
nourlms.homework.student.empty             → "You have no assigned homework yet."
nourlms.homework.student.submit.button     → "Submit"
nourlms.homework.student.submit.fromFile   → "Submit from file…"
nourlms.homework.student.submit.fileTooLarge → "File exceeds the 1 MB limit."
nourlms.homework.student.submit.binary     → "Selected file is not text-readable."
nourlms.homework.student.submit.corrected  → "This homework has been graded by your admin — no further submissions are accepted."
nourlms.homework.student.openAsPage        → "Open as Page"
nourlms.homework.admin.bank.viewName       → "Question Bank"
nourlms.homework.admin.bank.search         → "Search questions…"
nourlms.homework.admin.bank.assign         → "Assign to current student"
nourlms.homework.admin.bank.assign.disabled.notCode → "Only code questions can be assigned from this panel."
nourlms.homework.admin.bank.assign.disabled.noStudent → "Open a student workspace to assign homework."
nourlms.homework.admin.bank.create.button  → "New code question"
nourlms.homework.admin.assigned.viewName   → "Assigned to Current Student"
nourlms.homework.admin.assigned.empty      → "No homework assigned to this student yet."
nourlms.homework.admin.assigned.aiGrade.queued → "Run AI grade (queued)"
nourlms.homework.admin.assigned.aiGrade.sync   → "Run AI grade (sync)"
nourlms.homework.admin.assigned.aiGrade.regrade → "Re-grade"
nourlms.homework.errors.sessionExpired     → "Your session has expired. Sign in again."
nourlms.homework.errors.tooManyRequests    → "Too many requests, retrying…"
nourlms.homework.errors.unreachable        → "The LMS is unreachable. Please retry."
nourlms.homework.polling.checkAgain        → "Check again"
```

---

## 8. Files index

Every file referenced in this contract is brand-new under `src/vs/workbench/contrib/nourlms/browser/homework/` unless explicitly tagged MODIFY. The index here is informational; the authoritative file list lives in `plan.md` § Project Structure.

```text
homework/
├── nourlmsHomework.contribution.ts       — registers container + views (this file is the entry point imported from
│                                            ../nourlms.contribution.ts)
├── nourlmsHomeworkApi.ts                 — INourlmsHomeworkApi + class
├── nourlmsHomeworkPolling.ts             — HomeworkPollingRegistry
├── nourlmsHomeworkPage.ts                — NourlmsHomeworkPageManager (Open-as-Page)
├── nourlmsHomeworkTargetStudent.ts       — INourlmsHomeworkTargetStudentService + impl
├── types.ts                              — mirror types from data-model.md §1 (Question, Homework, Submission, …)
└── views/
    ├── nourlmsHomeworkStudentView.ts             — extends ViewPane
    ├── nourlmsHomeworkAdminQuestionBankView.ts   — extends ViewPane
    └── nourlmsHomeworkAdminAssignedView.ts       — extends ViewPane
```
