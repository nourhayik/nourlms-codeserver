# Feature Specification: NourLMS Homework Side Panel

**Feature Branch**: `001-homework-side-panel`
**Created**: 2026-05-04
**Status**: Draft
**Input**: User description: "Side panel in VS Code for students and admins to manage code-type homework with AI grading, integrated with the existing NourLMS auth and per-student workspace flow"

## Clarifications

### Session 2026-05-04

- Q: Where should the Homework side panel live in VS Code? → A: Secondary Side Bar (right / auxiliary), beside the editor.
- Q: What should happen when a student tries to submit again after a previous submission was already corrected by an admin? → A: Block re-submission once any submission for that homework has `is_corrected = true`; the submit control is disabled and the panel explains why.
- Q: Where should "Open as Page" place a question / submission / AI grading result by default? → A: Beside the active editor group (split side-by-side), so the Homework panel on the right and the opened page in the editor area are visible together; the user can move or close it afterwards using the standard VS Code editor commands.
- Q: Can a student manually trigger or re-trigger AI grading on one of their submissions? → A: No. Students cannot manually grade or re-grade. AI grading happens **only** automatically on submit when the underlying question has `is_auto_correct = true` (per the existing API). Students can only **read** results and poll the read-only status endpoint; the panel MUST NOT expose any "Request AI grade" or "Re-grade" action in the Student View. Re-grading remains an admin-only action against the admin endpoints.

### Session 2026-05-04 — analyze fix-up

- Q: How should the panel surface AI grading results history when the upstream backend stores no history (each `AiGradingResult` is updated in place by `AiReGradeJob`)? → A: Display only the **latest** AI grading result for each submission, **permanently**. The backend has no grading-history concept and we are intentionally **not** asking it to add one — this is a locked design decision, not a deferred feature. Audit trail across re-grades, when needed, lives in the admin's manual-correction notes (`PATCH /admin/homeworks/{id}/submissions/{sid}/correct` with `correct_the_answer`). See `scope-decision-no-ai-grading-history.md` for the full rationale and rejected alternatives.
- Q: Should SC-005's "automated test for forged-ID returns 404" be satisfied by upstream contract alone or by a panel-side test too? → A: Both. A proxy-level unit test issues a forged student-homework id with a student session and asserts the upstream's 404 is forwarded as 404 (deterministic), AND the manual smoke test includes an explicit penetration step (defence in depth).
- Q: How should SC-003 be measured given the upstream API latency is outside this slice's control? → A: Re-scope SC-003 to "**panel-side overhead per list call < 50 ms**" (verified by `performance.mark`-based assertion in the new tests + smoke run). End-to-end latency remains an observation, not a target this feature owns.
- Q: What input control does the new-code-question form use for the question content? → A: Plain `<textarea>` accepting raw HTML, matching how the upstream LMS web UI accepts the same `content` field today; sanitised on render in the panel and "Open as Page" webview.
- Q: Is the example error format in FR-009 normative? → A: Yes. The pattern `<localized message> (<HTTP status>)` is the normative rendering shape for every API error surfaced anywhere in the panel. The API client formats `ApiError.toString()` accordingly so views render it directly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Student views and submits assigned homework (Priority: P1)

A signed-in student opens the NourLMS Homework side panel inside their personal workspace and sees the list of code-writing homework assignments that have been given to them. They pick one, read the question, write or paste their solution (or point to a file in their workspace), and submit. The panel confirms the submission and shows it in their submissions list.

**Why this priority**: This is the core daily loop for students. Without it, students have no way to consume or respond to the homework that admins assign. It delivers the primary value of the feature on its own — even with no other story implemented, students can complete and turn in work.

**Independent Test**: Sign in as a student whose account already has homework rows in the backend, open the panel, confirm the homework list renders only items belonging to that student, open a homework, type an answer, submit, and confirm the new submission appears in the submissions list and the backend records it.

**Acceptance Scenarios**:

1. **Given** a student is signed in and has at least one assigned code homework, **When** they open the Homework side panel, **Then** they see only their own assigned homework (never another student's), each item showing question summary, course/subject, status (pending/corrected), and assignment date.
2. **Given** a student opens an assigned homework, **When** they choose "Open as Page", **Then** the question detail opens as a regular editor tab that can be moved to a side group or to the bottom panel like any other VS Code editor.
3. **Given** a student is viewing a code homework, **When** they type or paste an answer in the panel's answer area and click Submit, **Then** the panel calls the submit endpoint, shows a success confirmation with the new submission ID, and updates the submissions list.
4. **Given** a student is viewing a code homework, **When** they choose "Submit from file" and pick a file from their workspace, **Then** the file's text contents are used as the submission answer and the panel shows the same success confirmation.
5. **Given** a homework has `is_auto_correct = true`, **When** the student submits, **Then** the panel begins polling AI grading status for that submission and surfaces "Pending" / "Ready" state in the submissions list without the student doing anything else.
6. **Given** a student attempts to submit an empty answer, **When** they click Submit, **Then** submission is blocked client-side with an inline message and no API call is made.
7. **Given** a student opens a homework whose previous submission has already been corrected by an admin (`is_corrected = true`), **When** they view the answer area, **Then** the Submit and "Submit from file" controls are disabled and an inline notice explains "This homework has been graded by your admin — no further submissions are accepted."

---

### User Story 2 - Admin assigns a code question to the currently opened student workspace (Priority: P1)

A signed-in admin has used the existing Student Workspaces sidebar to open student "John"'s workspace. The admin opens the Homework side panel, browses or searches the question bank, picks one or more **code** questions, and clicks "Assign to current student". The panel resolves the target student from the open workspace, calls the assign endpoint with that student's user ID, and confirms how many homework rows were created.

**Why this priority**: This is the admin's headline workflow for the panel and the reason the feature ties into the per-student workspace model. It is the single action that connects the question bank, the student, and the homework table. It can be tested end-to-end on its own without student-side code.

**Independent Test**: Sign in as an admin, use the existing Student Workspaces view to open a known student's workspace, open the Homework side panel, pick an existing code question from the bank, click "Assign to current student", and verify in the backend that a new homework row was created for that exact student and question.

**Acceptance Scenarios**:

1. **Given** an admin has opened a student's workspace via the Student Workspaces sidebar, **When** they open the Homework side panel, **Then** the panel header clearly displays which student is the current assignment target (name and user ID resolved from the workspace path).
2. **Given** the admin browses the question bank inside the panel, **When** they apply filters (search text, course, subject, difficulty, question type), **Then** the visible list updates to match and only **code-type** questions are eligible for the "Assign" action (other types are visible but the assign button is disabled with a tooltip explaining why).
3. **Given** the admin selects one or more code questions and the current target student is known, **When** they click "Assign to current student", **Then** the panel sends a single assignment request and shows a success message with the count of created homework rows; previously-assigned (id, user) pairs are skipped silently as per API behavior.
4. **Given** the admin is not currently inside a recognised student workspace, **When** they view the panel, **Then** the "Assign to current student" action is disabled and an inline notice tells them to open a student workspace first.
5. **Given** a question has more content than fits in the panel, **When** the admin clicks "Open as Page", **Then** the full question opens as a regular editor tab outside the panel.

---

### User Story 3 - Student reviews submissions and AI grading results (Priority: P2)

A student opens a previously submitted homework and looks at the list of all attempts they have made. For each submission they can see the submitted answer, whether it has been AI-graded, and the grade / feedback when available. **Students never trigger AI grading themselves** — grading runs automatically when the original question is configured as auto-correct, and the panel just polls the read-only status endpoint until the result appears. Long submission / result content opens as a regular editor tab so the student can read it side-by-side with their own work.

**Why this priority**: Important for the learning loop, but not blocking for first delivery — students can still submit (US1) without it. Once US1 ships, this is the natural next slice.

**Independent Test**: As a student with at least one already-submitted auto-correct homework, open the panel, navigate to that homework's submissions, confirm the panel polled the status endpoint and rendered the AI result fields (grade, syntax/logical errors, hints, explanation). On a submission whose underlying question is not auto-correct, confirm the panel shows "Awaiting admin grading" and does **not** expose any control to trigger AI grading.

**Acceptance Scenarios**:

1. **Given** a student opens a homework they have already submitted, **When** they switch to the "Submissions" tab inside the panel, **Then** they see the list of their own submissions for that homework, each showing submission date and AI grading state (none / pending / ready).
2. **Given** a submission has an AI grading result, **When** the student opens it, **Then** they see grade, syntax/logical error fields, hints, and explanation; selecting "Open as Page" opens the full result as a regular editor tab beside the active editor group.
3. **Given** a submission was made against an auto-correct question and has no AI grading result yet, **When** the student opens that submission, **Then** the panel automatically polls the read-only status endpoint until the result becomes ready (or gives up per the bounded polling policy) and renders it; the panel MUST NOT expose any "Request AI grade" or "Re-grade" control to the student.
4. **Given** a submission was made against a question that is not auto-correct, **When** the student opens it, **Then** the panel shows an "Awaiting admin grading" state with no polling and no grading-trigger controls — only an admin can move that submission forward.
5. **Given** the most recent grading status check failed temporarily, **When** the polling continues, **Then** transient errors do not break the panel and the next poll either recovers or surfaces an inline "Check again" control after the bounded number of failures.

---

### User Story 4 - Admin reviews student submissions and runs AI grading (Priority: P2)

An admin opens the panel inside a student workspace, picks one of that student's assigned homework items, lists all submissions, opens a submission, and either triggers AI grading (queued or sync) or reviews an existing AI grading result. Long content (the full submitted answer, the full grading result) opens as a regular editor tab for comfortable reading.

**Why this priority**: Required for the admin's grading loop, but not strictly required to demonstrate the feature's main value (assignment, US2). Builds directly on US2 + the same submission detail surface used by US3.

**Independent Test**: As an admin in a student's workspace, open the panel's "Assigned to this student" tab, open a homework with at least one submission, open the submission, click "Run AI grade (queued)", confirm the panel reports the job was dispatched, then on the same or a separate run open an already-graded submission and confirm the historical AI result is rendered.

**Acceptance Scenarios**:

1. **Given** an admin has opened a student workspace, **When** they switch to the "Assigned to this student" tab in the panel, **Then** they see the list of code homework already assigned to that student with status (pending/corrected) and AI grading indicator, filtered server-side by that student.
2. **Given** an admin opens a homework's submissions, **When** the list loads, **Then** they see every submission for that homework with submitter date and AI grading state, and can open each in a temp page.
3. **Given** an admin opens a single submission, **When** they click "Run AI grade", **Then** they can choose mode (queued or sync); queued mode returns immediately and the panel begins polling, sync mode shows a loading state and renders the result inline when the call returns.
4. **Given** an admin opens a submission that has already been AI-graded, **When** they click "Re-grade", **Then** the panel calls the regrade endpoint, shows the dispatched confirmation, and begins polling for the updated result.

---

### User Story 5 - Admin creates a new "Write Code" question from the panel (Priority: P3)

An admin opens the panel and chooses "New code question". A form lets them enter the question content, pick course/subject/difficulty/weight/time-limit, and optionally provide a best answer and pre-answer. On submit, the new question is created in the question bank and appears in the panel's question list, ready to be assigned via US2.

**Why this priority**: Useful but not core. Admins can already create questions through other channels in the LMS; this is a convenience shortcut from inside VS Code. Ships after US2 + US4 are working.

**Independent Test**: Sign in as admin, open the panel, click "New code question", fill the form (with at least the API-required fields for a code question), submit, and confirm the new question is returned, listed in the panel, and visible via the question bank API.

**Acceptance Scenarios**:

1. **Given** an admin opens the "New code question" form, **When** the form first renders, **Then** the question type is fixed to "code" and cannot be changed; the form only accepts fields that are valid for a code question (content, course, subject, difficulty, weight, time-in-seconds, best answer, pre-answer).
2. **Given** an admin submits the form with all required fields, **When** the create call succeeds, **Then** the new question is added to the top of the panel's question list, the form closes, and a success notification is shown.
3. **Given** an admin submits the form with missing or invalid fields, **When** the API returns a 422 validation error, **Then** the panel shows the field-level error messages inline against the offending fields without losing the user's other input.

---

### Edge Cases

- **Admin opens panel outside a student workspace**: assignment actions are disabled with a clear inline notice; question browsing, search, and creation still work.
- **Admin's currently opened folder cannot be resolved to a known student**: the panel header shows "No student selected" and treats it the same as "outside a student workspace" for the purpose of disabling assignment.
- **Token expires mid-session**: any panel API call that returns 401 triggers a re-login flow (redirect to login page) consistent with the existing NourLMS session behaviour; in-flight panel state is discarded.
- **Rate limiting (429)**: the panel surfaces a non-fatal "Too many requests, retrying shortly" message and backs off; user actions are not silently dropped.
- **Empty states**: student with zero assigned homework, admin with zero questions in the bank for the chosen filters, homework with zero submissions — each surface shows a tailored empty state with the next-step hint, not a blank pane.
- **Student tries to submit to a non-code homework via the panel**: the submit control is hidden / disabled because the panel only exposes code-type homework; if a server response disagrees, the API's 422 error message is surfaced inline.
- **Student picks a binary or very large file as the submission source**: the panel rejects the file with a friendly message; only text-readable files within a sane size limit are accepted.
- **Question or result HTML content is malformed or hostile**: HTML rendered inside the panel is sanitised; raw `<script>` and event handlers are stripped before display.
- **Network failure or backend 5xx on any panel action**: the panel keeps the user's input intact, shows a retryable error inline, and does not crash the workbench.
- **Polling for AI grading never resolves**: polling backs off, then stops after a bounded number of attempts and offers a manual "Check again" control.
- **Admin assigns the same question to the same student twice**: the panel reports the deduplicated count returned by the API ("0 new, 1 already assigned") rather than treating it as an error.
- **Multiple panels / tabs open at once**: the panel reflects up-to-date state on focus / on user-triggered refresh; concurrent submissions from two tabs of the same student create two independent submission rows (per API behaviour) **only while no submission is yet corrected**; once any submission is corrected, both tabs MUST disable the submit controls.
- **Race between manual correction and a pending student submission**: if an admin marks a submission corrected while the student is mid-typing in another tab, the next attempt to submit from the student's tab MUST fail closed (panel re-checks state on submit-click and blocks with the corrected-homework notice rather than calling the API).

## Requirements *(mandatory)*

### Functional Requirements

#### Panel container & visibility

- **FR-001**: The panel MUST be hosted in the **Secondary Side Bar (auxiliary bar, right side of the workbench)** as a togglable view container that the user can open and close using the standard VS Code Secondary Side Bar toggle.
- **FR-002**: The panel MUST be visible only to users authenticated via the existing NourLMS login flow; unauthenticated browsers MUST never see it.
- **FR-003**: The panel MUST render exactly one of two views — Admin View or Student View — based on the role exposed by the existing NourLMS auth context (`nourlmsIsAdmin` / `nourlmsIsStudent`); a user with no role MUST see no view.
- **FR-004**: The panel MUST be discoverable from the Secondary Side Bar's container picker with a single, clearly labeled entry distinct from the existing "Student Workspaces" container in the primary sidebar; both containers MAY be visible at the same time (one on each side bar).
- **FR-005**: The panel MUST work in the VS Code web client served by `nourlms-codeserver`; native desktop builds are out of scope for this feature.

#### Shared behaviour (admin & student)

- **FR-006**: The panel MUST allow any item with content larger than fits comfortably (question detail, submission detail, AI grading result, full submitted answer) to be opened as a regular VS Code editor tab via an "Open as Page" affordance.
- **FR-007**: Pages opened via "Open as Page" MUST open by default in a **new editor group beside the active group (split side-by-side)** so that the Homework panel on the right and the opened page in the editor area are visible at the same time; once open, the tab MUST behave like any other editor tab — the user can move it between editor groups, split it further, or send it to the bottom panel using the standard VS Code split / move commands.
- **FR-007a**: If a page for the same item (same question / submission / result) is already open, "Open as Page" MUST reveal and focus that existing tab rather than open a duplicate.
- **FR-008**: All HTML returned by the API (question content, best answer, hints, explanations) MUST be sanitised before rendering; script execution and inline event handlers from API content MUST NOT be possible.
- **FR-009**: The panel MUST surface API errors in human-readable form using the **normative** rendering shape `<localized message> (<HTTP status>)` for every error originating from an `/nourlms-api/*` call. Examples: `Session expired (401) — please sign in again`, `Too many requests (429) — retrying…`, `Validation failed (422) — <field-level details>`. The API client's `ApiError.toString()` MUST emit this exact shape so views can render the string directly without per-view formatting logic.
- **FR-010**: The panel MUST handle 401 from any API call by triggering the existing re-authentication flow (navigate to the login page) rather than failing silently.
- **FR-011**: The panel MUST avoid duplicating the upstream **Sanctum bearer token** in the browser; all backend API calls MUST be issued through the existing server proxy so the Sanctum bearer token stays server-side, consistent with the current cookie-only validation model.
- **FR-012**: All API list views (questions, homework, submissions) inside the panel MUST be paginated lazily with a "Load more" or equivalent mechanism, mirroring the underlying API's pagination.
- **FR-013**: Empty results in any list **inside the panel or any of its "Open as Page" surfaces** MUST render a tailored empty state with a next-step hint, not a blank container. This applies — non-exhaustively — to: the student homework list, the per-homework submissions list (student and admin), the admin question bank list, the admin "Assigned to current student" list, and the search-result list when filters return zero rows. Each empty state MUST be localized via the `nourlms.homework.*.empty` key family.

#### Admin view

- **FR-014**: The Admin View MUST list questions from the question bank with server-side filtering by free-text search, course, subject, difficulty, and question type, mirroring the available API filters.
- **FR-015**: The Admin View MUST clearly label each question's type and MUST treat only `code`-type questions as eligible for assignment from the panel; for non-code types the assignment control MUST be disabled with a tooltip stating "Only code questions can be assigned from this panel".
- **FR-016**: The Admin View MUST resolve the "current target student" from the workspace folder currently opened in the workbench (using the same student-workspace mapping that the existing `/nourlms-workspaces` flow uses); when the open folder cannot be mapped to a known student, the panel MUST display "No student selected" in its header.
- **FR-017**: When a target student is resolved, the Admin View MUST allow assigning one or more selected code questions to that student via a single "Assign to current student" action that calls the assign endpoint with the resolved user ID and the selected question IDs.
- **FR-018**: When no target student is resolved, the "Assign to current student" action MUST be disabled and the panel MUST tell the admin to open a student workspace from the existing Student Workspaces sidebar.
- **FR-019**: The Admin View MUST surface the assign result (count of newly created vs already-assigned rows) and MUST gracefully handle idempotent "no-op" assignments (no rows created) by reporting "Already assigned".
- **FR-020**: The Admin View MUST provide a "New code question" creation form that exposes only fields valid for a code question; the question type MUST be hard-coded to code and MUST NOT be selectable.
- **FR-021**: The "New code question" form MUST validate required fields client-side before sending, MUST send the create request, and MUST surface 422 field-level errors inline against the offending fields without discarding the rest of the user's input.
- **FR-022**: When a new code question is created successfully, it MUST appear in the panel's question list (e.g. prepended) without requiring a manual page reload.
- **FR-023**: The Admin View MUST list, per current target student, all of that student's assigned homework filtered server-side by `student_id` (and optionally by course / subject / status / `is_ai_graded`), and MUST never display homework belonging to other students in this surface.
- **FR-024**: For each assigned homework, the Admin View MUST allow drilling into the list of its submissions with the available filters (`is_corrected`, `has_ai_result`, date range).
- **FR-025**: For each submission, the Admin View MUST allow triggering AI grading in either queued or sync mode; queued mode MUST return immediately and start polling, sync mode MUST show a loading state and render the result inline when the call returns.
- **FR-026**: For each submission that already has an AI grading result, the Admin View MUST allow viewing the latest result and MUST allow triggering an AI re-grade (which dispatches the regrade endpoint).
- **FR-027**: The **latest** AI grading result for each submission MUST be reachable from the submission detail surface, both for queued/sync grading and after a re-grade (which updates the same row in-place per upstream behaviour). Listing **historical** AI grading results for a submission is **permanently out of scope** for this feature: the upstream backend stores no grading history (each `AiGradingResult` is overwritten in place on re-grade) and we are intentionally not asking it to add one. The audit trail across re-grades, when needed, is the admin's manual-correction notes (`PATCH /admin/homeworks/{id}/submissions/{sid}/correct` with `correct_the_answer`). See `scope-decision-no-ai-grading-history.md` for the rationale and rejected alternatives.

#### Student view

- **FR-028**: The Student View MUST list only homework belonging to the authenticated student; the panel MUST NOT make any request whose response could include another student's data.
- **FR-029**: The Student View MUST default to listing assigned homework with server-side filters for course, subject, status, `is_ai_graded`, and date range, mirroring the student API.
- **FR-030**: For an opened homework, the Student View MUST render the question content (sanitised HTML) and MUST offer "Open as Page" to view it as an editor tab.
- **FR-031**: The Student View MUST allow submitting an answer in two ways: (a) typing or pasting text into an answer area, or (b) selecting a text file from the currently opened workspace, whose contents become the answer body sent to the submit endpoint.
- **FR-032**: When submitting from a workspace file, the panel MUST reject the action if the file is not text or exceeds the size limit, with a clear inline message.
- **FR-033**: After submission, the Student View MUST display the new submission's ID and add it to the per-homework submissions list without a manual reload.
- **FR-033a**: The Student View MUST disable both the typed-answer Submit and the "Submit from file" controls for any homework that already has at least one submission with `is_corrected = true`, and MUST surface an inline notice telling the student why; the panel MUST NOT call the submit endpoint in that state.
- **FR-034**: For each of their own submissions, the Student View MUST allow opening the submission detail (showing the submitted answer and, if available, the AI grading result) and MUST allow opening it as an editor tab via "Open as Page".
- **FR-035**: For a submission whose underlying question is `is_auto_correct = true` and which has no AI grading result yet, the Student View MUST automatically poll the dedicated read-only status endpoint and update the UI when the result becomes ready; for a submission whose question is not auto-correct, the Student View MUST instead show an "Awaiting admin grading" state and MUST NOT poll.
- **FR-035a**: The Student View MUST NOT expose any control that triggers or re-triggers AI grading on an existing submission (no "Request AI grade", no "Re-grade", no sync-mode toggle). The only paths from "no result" to "result" available to a student are (a) the automatic on-submit grade dispatched by the API for auto-correct questions, or (b) an admin-side action invisible to the student.
- **FR-036**: The Student View MUST never expose admin-only actions (manual correction, queued/sync AI grade trigger, regrade) regardless of any HTML / DOM manipulation, because the role context key gates the entire view; in addition, FR-035a is enforced at the panel level so that even if the role check is bypassed in the DOM, no grading-trigger UI exists in the Student View bundle.

#### Reliability & UX

- **FR-037**: All long-running operations (AI grading polling, sync grading, file read, question/submission load) MUST show a non-blocking loading indicator and MUST be cancellable when the panel is closed or the workspace changes.
- **FR-038**: Polling for AI grading status MUST use a bounded retry/backoff strategy with a maximum number of attempts and a wall-clock ceiling, after which the panel MUST surface a manual "Check again" control rather than poll forever. The concrete cadence (initial interval, backoff curve, max attempts, ceiling) is a tuning detail to be locked down in the plan phase under the constraint that the panel as a whole stays well under the 60 req/min API throttle even with several pending pollers.
- **FR-039**: The panel MUST refresh its lists on user-triggered refresh and on first opening; it MUST NOT poll list endpoints on a wall-clock timer (to respect the 60 req/min API throttle).
- **FR-040**: All localized strings shown in the panel MUST go through the existing `localize`/`localize2` machinery so the panel works with VS Code's l10n model.

### Key Entities *(include if feature involves data)*

- **Question**: A code-writing question that lives in the LMS Question Bank. Attributes used by the panel: ID, content (HTML), course, subject, difficulty, type (panel only operates on `code`), weight, time limit, best answer, pre-answer. Source of truth: backend Question Bank API.
- **Homework**: An assignment of one Question to one Student. Attributes used by the panel: ID, question reference, student reference, assignment date, status (pending / corrected), AI-graded indicator. Source of truth: backend Homework API. The panel only ever shows homework whose question is of type `code`.
- **Submission**: One attempt by a Student at a Homework, captured as a `QuestionAnswer` row. Attributes used by the panel: ID, content (the submitted answer text), submission date, correction state, latest AI grading result reference. Source of truth: backend Submissions API.
- **AI Grading Result**: The output of grading one Submission. Attributes used by the panel: ID, grade, syntax/logical error fields, hints, explanation, best-answer comparison, graded/regraded timestamps, provider. Source of truth: backend AI Grading Result API.
- **Student Workspace Mapping**: The link between an opened workspace folder name and a real Student user ID. Used by the Admin View to resolve the assign target. Source of truth: the existing `/nourlms-workspaces` server route + `sanitizeUsername` mapping that already powers the Student Workspaces sidebar.
- **NourLMS Session**: The signed-in user's identity (name, role, token) carried by the existing session cookie. Source of truth: existing `nourlmsAuth` server module; the panel never reads the token directly.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-in student can go from opening the panel to a successfully recorded submission in fewer than 6 user actions (open panel → open homework → enter answer → submit), with no manual page reload required.
- **SC-002**: A signed-in admin can go from opening a student's workspace to a successfully created homework assignment for that student in fewer than 6 user actions (open Student Workspaces → open student → open Homework panel → pick code question → click Assign), with no need to type the student's ID anywhere.
- **SC-003**: The **panel-side overhead** added to any API list call (request build → response render, excluding network and upstream time) is under **50 ms** at the 95th percentile, verified by `performance.mark`-based assertions around `IRequestService.request(...)` invocations and the subsequent DOM render path. End-to-end latency is dominated by the upstream API and is not a target this feature owns.
- **SC-004**: After a student submits an `is_auto_correct` homework, the panel reflects the AI grading result without the student manually refreshing in 100% of cases where the backend produces a result, with average detection latency within 5 seconds of the result becoming available (bounded by polling interval).
- **SC-005**: The panel never surfaces another student's data to a student account, verified by **two complementary checks**: (a) an **automated** proxy unit test that issues a forged student-homework id with a student session and asserts the upstream's 404 is forwarded as 404, and (b) a **manual** penetration step in the smoke test where the auditor types another student's homework id into the URL and confirms the panel surfaces the 404 cleanly without leaking content.
- **SC-006**: A non-code question can never be assigned via the panel (verified by automated test: even if the backend were tolerant, the panel's "Assign" action is disabled for any question whose type is not code).
- **SC-006a**: A student can never trigger or re-trigger AI grading from the panel — verified by automated test that scans the Student View bundle for any control bound to admin grading endpoints (`/admin/homeworks/{id}/ai-grade`, `…/regrade`) and asserts none exist, plus a runtime test that confirms no Student View interaction issues a request to those endpoints.
- **SC-007**: When the NourLMS session cookie expires while the panel is open, the next panel API action redirects the user to the login page rather than failing silently or breaking the workbench, in 100% of cases.
- **SC-008**: Admins can create a new code question from the panel and immediately assign it to the currently opened student in under 90 seconds for a typical question (one form, one click).
- **SC-009**: Opening a question, submission, or AI grading result as a page produces a regular editor tab placed beside the active editor group on first open, and the user can split / move it using the standard VS Code commands without any panel-specific workaround; reopening the same item from the panel reveals the existing tab instead of duplicating it.
- **SC-010**: The panel adds no more than the equivalent of one "load more" page worth of API requests per user action; specifically it MUST NOT poll list endpoints on a timer (verified by network log review).

## Assumptions

- The NourLMS authentication and per-student workspace flow described in `auth-plan.md` and already implemented in `src/vs/workbench/services/nourlms/**` and `src/vs/server/node/**` is the trusted source of identity for this feature; the panel reuses the same session cookie, role context keys, and `/nourlms-workspaces` mapping.
- The backend exposes the endpoints documented in `documentation/Homework_AI_Grading_API.md` (auth, question bank, admin homeworks, student homeworks, AI grading results, status polling). No new backend endpoints are required, with one exception noted below.
- Resolving the "current target student" from the opened workspace folder is feasible by exposing the student's user ID in the workspace listing returned by the existing server-side workspace endpoint (or by an equivalent server-side lookup at panel API time). This is a small server-side addition rather than a new API surface.
- All panel-to-LMS HTTP traffic is proxied through the same `nourlms-codeserver` HTTP server that already proxies `/nourlms-login` and `/nourlms-logout`, so the **Sanctum bearer token** is never sent to the browser. The panel calls relative paths under a new server-side prefix (e.g. `/nourlms-api/...`) which the server forwards to the upstream LMS API with the correct `Authorization: Bearer <Sanctum token>` header.
- The panel only operates on `code`-type questions for assignment, creation, and submission, even though the LMS supports other types. This is a deliberate scope reduction.
- "Submit from file" reads from the currently opened workspace using the standard VS Code file-system service. Files outside the open workspace are out of scope.
- A reasonable text-file size limit for student submissions is sufficient (e.g. 1 MB); binary files are rejected. The exact limit is a tuning detail for the plan phase.
- VS Code's standard l10n (`localize`/`localize2`) is used for all human-readable strings in the panel; no new translation pipeline is introduced.
- Existing security model for students (server-enforced workspace isolation in `/vscode-remote-resource`, restricted activity bar, etc.) continues to apply unchanged; the new panel adds the homework activity-bar entry to the small set that students can see.
- The panel is delivered for the web workbench only; native VS Code Desktop is out of scope for this feature.
- AI grading "queued" mode is the default for **admin-triggered** grading; "sync" mode is admin-only and is offered as an opt-in for fast iteration. Students never trigger grading themselves — for students, AI grading runs only as the automatic on-submit job dispatched by the API for `is_auto_correct` questions, and the panel surfaces the result via the read-only status endpoint.
- Polling cadence for AI grading status (initial interval, backoff curve, max attempts) is intentionally left to the plan phase; the spec only commits to "bounded" + "well under 60 req/min throttle even with multiple pending pollers" + "manual Check-again fallback after the ceiling".
