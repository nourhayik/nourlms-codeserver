# Homework Feature — Working Memory

> **Purpose:** Single source of truth for the Homework feature redesign. Always read this first when continuing work in a new chat. Update it as files are added/removed/changed.

---

## High-level architecture (post-redesign)

The Homework feature is **no longer** a Secondary Side Bar / AuxiliaryBar view. It is:

1. **Top-bar entry point**: a "Homework" action button is registered in the title bar's `MenuId.CommandCenter`, visible to both students and admins (gated by `nourlmsIsStudent` and `nourlmsIsAdmin` context keys).
2. **Single editor pane**: clicking the button opens a custom editor pane (`NourlmsHomeworkEditorPane`) bound to a singleton editor input (`NourlmsHomeworkEditorInput`). Re-clicking the button reveals the existing pane — it is NEVER opened twice.
3. **In-pane router with back button**: the pane hosts a stack-based router (`HomeworkRouter`). All navigation (list → detail → submission → AI result → new-question form) pushes onto a single stack. Closing the editor discards history. The pane renders a back button + breadcrumb whenever the stack is > 1 entry.
4. **Page reuse**: every "open as page" action mutates the SAME stack on the SAME editor input. There is exactly one homework page in the workspace at any time.
5. **No AuxiliaryBar registration** — the old `NourlmsHomeworkStudentView`, `NourlmsHomeworkAdminQuestionBankView`, `NourlmsHomeworkAdminAssignedView` ViewPanes are deleted along with the view container.

---

## File layout

### Server side (Node)

| File | Role |
|------|------|
| `src/vs/server/node/nourlmsApiProxy.ts` | `/nourlms-api/*` allow-list and forwarder. Allow-list includes student/admin homework + question-bank routes, plus the new `GET /admin/students/:id/courses` and `POST /question-bank/subjects`. |
| `src/vs/server/node/nourlmsAiProxy.ts` | NEW. Admin-only proxy for `/nourlms-ai/chat-completions` → `https://ai.nourlms.com/v1/chat/completions` using `process.env.AI_API_KEY`. Strips inbound `Authorization`/`Cookie`. Streams response. 502 on upstream failure. |
| `src/vs/server/node/nourlmsAuth.ts` | Session cookie + sidecar (`writeWorkspaceSidecar` / `readWorkspaceSidecar`). Unchanged in this round. |
| `src/vs/server/node/remoteExtensionHostAgentServer.ts` | Wires `/nourlms-api/*`, `/nourlms-ai/*`, and `/nourlms-workspaces*` after the cookie-session middleware. |
| `src/vs/server/node/webClientServer.ts` | Bootstraps the web client + injects `WORKBENCH_NOURLMS_USER` (incl. `userId`) and the workspace sidecar. Unchanged this round. |

### Client side (workbench, browser)

| File | Role |
|------|------|
| `src/vs/workbench/services/nourlms/common/nourlms.ts` | `INourlmsAuthService`, `INourlmsUserInfo` (incl. `userId`), `NourlmsContextKeys`. Unchanged this round. |
| `src/vs/workbench/services/nourlms/browser/nourlmsAuthService.ts` | Reads user info from DOM, exposes `onDidLogout`. Unchanged this round. |
| `src/vs/workbench/contrib/nourlms/browser/nourlms.contribution.ts` | Side-effect imports the homework contribution. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomework.contribution.ts` | Registers the editor pane, editor input serializer, all singleton services, the `nourlms.homework.open` action, and the `MenuId.CommandCenter` button. **No view container, no views.** |
| `src/vs/workbench/contrib/nourlms/browser/homework/types.ts` | Shared type mirrors of REST API responses. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts` | `INourlmsHomeworkApi` + concrete client. Calls `/nourlms-api/...` paths through `IRequestService`. Includes the new `listAdminStudentCourses(studentId)` and `createSubject(name, courseId)`. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkAi.ts` | `INourlmsHomeworkAiService` — calls `/nourlms-ai/chat-completions` (admin-only). Includes `generateQuestionDraft(prompt)` that returns a structured `Partial<CreateCodeQuestionPayload>` JSON. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPolling.ts` | `HomeworkPollingRegistry` — exponential-backoff poller registry. Unchanged this round. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkTargetStudent.ts` | `INourlmsHomeworkTargetStudentService` — resolves the active workspace folder to a student id (admin only). Unchanged this round. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkEditorInput.ts` | NEW. Singleton `EditorInput` keyed by a fixed `URI` so re-opening always reuses the same input. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkEditorPane.ts` | NEW. `EditorPane` that owns the router + back button + screen mounting. |
| `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkRouter.ts` | NEW. `HomeworkRouter` — stack of `Route` records, push/replace/pop, fires `onDidChange`. Defines the `Screen` interface. |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/homeScreen.ts` | NEW. Landing screen: student → list of homeworks; admin → tabs for "Question Bank" / "Assigned to Current Student". |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/studentHomeworkDetailScreen.ts` | NEW. One homework + answer textarea + submit + submissions list (each row pushes `submission` route). |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/submissionDetailScreen.ts` | NEW. Renders submitted answer + auto-loads + renders the latest AI result inline. **Same screen for student and admin** (admin gets extra grading buttons). |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/aiResultScreen.ts` | NEW. AI result detail (independent route). |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/adminQuestionBankScreen.ts` | NEW. Admin question bank — search + filter dropdowns + checkbox multi-select + "Assign to current student" + "New question" (pushes `newQuestion` route). Filter dropdown limited to current target student's courses (via `listAdminStudentCourses`). |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/adminAssignedScreen.ts` | NEW. Admin "Assigned to current student" — homework list → submission list → submission route. |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/newQuestionScreen.ts` | NEW. New code question form (admin only) with AI prompt textarea. "Generate" button calls the AI service to fill all form fields. Subject creation inline if subject doesn't exist. |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/screenUtils.ts` | NEW. Shared helpers: `escapeHtml(value)` (defensive against null/undefined), `safeText`, `formatDate(value)`, `getQuestionTypeKey(q)` (handles string + object shapes), `isCodeQuestion`, `shortQuestionPreview`, `appendLoadingRow`, `appendErrorRow`, `appendEmptyRow`, `initials`. |
| `src/vs/workbench/contrib/nourlms/browser/homework/screens/adminQuestionDetailScreen.ts` | NEW. Standalone admin question detail screen (rendered when admin clicks a question card). |
| `src/vs/workbench/contrib/nourlms/browser/homework/media/nourlmsHomework.css` | Updated layout: page-level scroll containers, header/back-button styles, sticky toolbar inside the page. |

### Files removed in this redesign

- `src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkPage.ts` (replaced by the editor pane + screens)
- `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkStudentView.ts`
- `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminQuestionBankView.ts`
- `src/vs/workbench/contrib/nourlms/browser/homework/views/nourlmsHomeworkAdminAssignedView.ts`

### Tests (kept where the subject still exists)

- `src/vs/server/test/node/nourlmsApiProxy.test.ts` — proxy allow-list, role gating, header stripping. Still valid; the new routes (`/admin/students/:id/courses`, `POST /question-bank/subjects`) are exercised implicitly by the "every route in the allow-list parses cleanly" test.
- `src/vs/server/test/node/nourlmsAuthSidecar.test.ts` — sidecar round-trip. Unchanged.
- `src/vs/workbench/contrib/nourlms/test/browser/homeworkPolling.test.ts` — polling registry. Unchanged.
- `studentViewBundle.test.ts`, `adminAssignGating.test.ts`, `l10n.test.ts`, `apiOverhead.test.ts` — **DELETED** (target removed view files). Replacement tests for the new screens are out of scope for this round.

### Build verification (run before shipping)

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx tsgo --project ./src/tsconfig.json --noEmit --skipLibCheck
NODE_OPTIONS=--max-old-space-size=8192 node build/checker/layersChecker.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsgo --project build/checker/tsconfig.browser.json
NODE_OPTIONS=--max-old-space-size=8192 npx tsgo --project build/checker/tsconfig.node.json
```

All four MUST exit 0 before the change ships. The full `npm run valid-layers-check` chain may OOM on small machines because it runs six `tsgo` projects back-to-back; running them individually with `--max-old-space-size=8192` works.

---

## REST API endpoints used (from the upstream NourLMS LMS)

All hit through the `/nourlms-api/...` proxy.

| Method | Path | Role | Used by |
|--------|------|------|---------|
| GET | `/student/homeworks` | student | Student list screen |
| GET | `/student/homeworks/courses` | student | Student filter dropdown |
| GET | `/student/homeworks/:id` | student | Student detail screen |
| POST | `/student/homeworks/:id/submit` | student | Submit answer |
| GET | `/student/homeworks/:id/submissions` | student | Submissions list |
| GET | `/student/homeworks/:id/submissions/:sid` | student | Submission detail |
| GET | `/admin/homeworks` | admin | Admin assigned screen |
| POST | `/admin/homeworks/assign` | admin | Assign action |
| GET | `/admin/homeworks/:id` | admin | Admin homework detail |
| GET | `/admin/homeworks/:id/submissions` | admin | Admin submissions list |
| GET | `/admin/homeworks/:id/submissions/:sid` | admin | Admin submission detail |
| PATCH | `/admin/homeworks/:id/submissions/:sid/correct` | admin | Manual correction |
| POST | `/admin/homeworks/:id/ai-grade` | admin | Trigger AI grade (queued/sync) |
| POST | `/admin/homeworks/:id/ai-grade/regrade` | admin | Re-grade |
| GET | `/question-bank/questions` | admin | Question bank list |
| POST | `/question-bank/questions` | admin | New question |
| GET | `/question-bank/questions/:id` | admin | Question detail |
| GET | `/question-bank/courses` | admin | Course filter source |
| GET | `/question-bank/subjects` | admin | Subject filter source |
| POST | `/question-bank/subjects` | admin | **NEW** — create subject from new-question form |
| GET | `/question-bank/courses/:id/subjects` | admin | Subjects scoped to course |
| GET | `/question-bank/difficulty-rates` | admin | Difficulty filter source |
| GET | `/question-bank/question-types` | admin | Type lookup (used to find code-type id) |
| GET | `/admin/students/:id/courses` | admin | **NEW** — limit question filter to this student's courses |
| GET | `/ai-grading/results/:id` | any | AI result detail |
| GET | `/homeworks/:id/submissions/:sid/ai-result` | any | Latest AI result for a submission |
| GET | `/homeworks/:id/submissions/:sid/ai-result/status` | any | Polling endpoint |

---

## AI integration

- Endpoint: `https://ai.nourlms.com/v1/chat/completions` (OpenAI-compatible).
- Model: `gpt-4o-mini`.
- Auth: bearer token from `process.env.AI_API_KEY` on the server (NEVER shipped to the browser).
- Browser path: `POST /nourlms-ai/chat-completions` (admin-only). Body is a forwarded `{ model, messages, response_format, temperature }`. The server proxy:
  1. Verifies session role is `admin` (404 otherwise — same convention as `nourlmsApiProxy`).
  2. Strips inbound `Authorization`/`Cookie`.
  3. Adds `Authorization: Bearer ${process.env.AI_API_KEY}`.
  4. Streams the response back.
- Admin-only client service `INourlmsHomeworkAiService.generateQuestionDraft(prompt)` sends a structured-JSON request with a system prompt that constrains the model to fill `{content, course_id, question_subject_id, difficulty_rate_id, weight, time_in_second, is_auto_correct, best_answer, pre_answer, suggested_subject_name?}` based on the admin's free-text prompt + the available courses/subjects/difficulty lookups.
- If the AI returns a `suggested_subject_name` whose name doesn't exist under the chosen course, the new-question screen surfaces a "Create subject '<name>'" inline action that calls `createSubject(name, courseId)` before submitting the question.

---

## Bugs fixed in this redesign

| Bug | Root cause | Fix |
|-----|-----------|-----|
| Submission "Open as page" → `Cannot read properties of undefined (reading 'replace')` | Old `nourlmsHomeworkPage.ts#escapeHtml` is called with `undefined` when an API response has a missing `submitted_at` / `content` field | New `screenUtils.escapeHtml(value)` coerces `null`/`undefined` to `''` defensively, and submission detail explicitly defaults missing fields. |
| Question detail title shows "QUESTION #UNDEFINED" | `hw.question_id` is occasionally absent from the API response, while `hw.question.id` is always present (Laravel relation include). The `.nourlms-hw-detail__title` CSS rule is `text-transform: uppercase`, which made the missing `undefined` very visible. | All title rendering now reads `hw.question.id ?? hw.question_id ?? '?'` and the helper coerces it to a string. |
| Admin "Assign to current student" always disabled | The `canAssignSelected` predicate required `q.question_type === 'code'` AND a target student. `q.question_type` is sometimes returned as a JSON object `{key: 'code', ...}` from the upstream, not a string, so the equality check always failed. | The predicate now accepts both shapes via a small `getQuestionTypeKey(q)` helper. |
| New-question form did nothing | The old form was rendered inline inside a ViewPane that doesn't have a place to layout a large form; the toggle button was wired but the form was visually clipped on narrow widths and had `display: none` after the action bar refreshed. | The new-question form is its own Screen route (full-width inside the editor pane) and never collapses. |
| No scrolling on long submissions / answers | Most `.nourlms-hw-*` containers had `display: flex; height: 100%` but no `overflow-y: auto` on the scroll-y child. | Each Screen sets `overflow: auto` on its root container; the pane's outer wrapper is `display: flex; flex-direction: column; height: 100%; overflow: hidden`. |
| Question bank empty / "questions flash for 0.5s and disappear", `TypeError: this.courses.map is not a function` in new-question form | The Laravel API resources wrap list responses as `{data: [...]}`. The TS code previously did `this.request<Course[]>(...)` and used the result directly with `.map`/`.filter`. As soon as `fetchLookupData` resolved, the next `refresh()` crashed inside `renderToolbar` and wiped the screen. | New private helpers in `NourlmsHomeworkApi` — `listJson<T>`, `objectJson<T>`, `paginatedJson<T>` — defensively unwrap raw arrays, `{data: [...]}` envelopes, and even `{data: {data: [...]}}` double-envelopes. ALL list/get/paginated calls now route through them. |
| Breadcrumb / popped routes leave the pane on the old screen | `HomeworkRouter.popTo(predicate)` returned early when the predicate matched without firing `onDidChange`, so the pane never got the re-render signal. | `popTo` now tracks a `changed` flag and fires `onDidChange` whenever any frame was popped (whether or not the predicate eventually matched). |
| Student / admin submission detail: answer empty + AI grade missing | The submission row passed to the screen as a "preload" came from the list endpoint, which usually returns a lighter row WITHOUT `content` and WITHOUT `latest_ai_result_id`. The old `mount()` only re-fetched when `preloaded` was undefined. | `mount()` now ALWAYS calls `fetchSubmission()` (and `fetchHomework()` in parallel), merges fresh data on top of the preload, and unconditionally calls the latest-AI-result endpoint — silently treating 404 as "no AI result yet" instead of an error. The admin path now uses the new `getAdminHomework(id)` API method (route `/admin/homeworks/:id` was already in the proxy allow-list). |
| AI question generator returned `AI Request Failed (404)` | The client posted to `/nourlms-ai/chat-completions` (single segment with hyphen), but the server-side `nourlmsAiProxy.ts` allow-list only accepts `/chat/completions` (two segments with slash, matching the upstream OpenAI-compatible path). The path strip never matched. | Updated the client URL in `nourlmsHomeworkAi.ts` to `/nourlms-ai/chat/completions`; the server proxy and the upstream AI base URL agree on the OpenAI-compatible path. Set `AI_API_KEY` in `.env` (already done). |
| AI question generator returned `AI Request Failed (400)` after the 404 fix | The OpenClaw gateway at `https://ai.nourlms.com/v1` rejects `model: "gpt-4o-mini"` with `{"error":{"message":"Invalid \`model\`. Use \`openclaw\` or \`openclaw/<agentId>\`."}}`. The updated `AI_API.md` (the version of the doc the user pasted in chat) specifies model `openclaw/default` AND adds a NEW required header `x-openclaw-scopes: operator.admin,operator.read,operator.write` — without it the gateway returns 403. The client's error path also swallowed the upstream message. | (1) Changed the default `MODEL` constant in `nourlmsHomeworkAi.ts` to `openclaw/default`. (2) `nourlmsAiProxy.ts` now sends the `x-openclaw-scopes` header upstream, defaulting to the admin/read/write triplet but overridable via the new `AI_API_SCOPES` env var. (3) Added the optional `AI_API_MODEL` env var: when set, the proxy parses the JSON body, rewrites `body.model`, and forwards the patched buffer — so future gateway model renames won't need a workbench rebuild. (4) Improved the client's 4xx handling to walk OpenAI-compatible / Laravel-style / plain-string error envelopes and log + surface the actual upstream message instead of the generic `AI request failed` fallback. (5) `.env` updated with all four AI_API_* values pre-set. |
| New-question form showed every course in the system, not just the current student's courses | `newQuestionScreen.ts#fetchLookups` always called `listCourses({})`. | When a target student is resolved, `fetchLookups` now calls `listAdminStudentCourses(target.userId)` first, falling back to the full course list only on 404 (endpoint not deployed yet). Course dropdown is scoped to the open student. |
| Secondary side bar still visible after the redesign | The student-restrictions contribution was opening the homework view in the AuxiliaryBar (now no-op), and there was no admin-side hide. | `_hideUIParts` for students now also hides `Parts.AUXILIARYBAR_PART`, the visibility guard re-hides it on toggle, and a new tiny `NourlmsHideAuxiliaryBarContribution` (registered in `nourlmsHomework.contribution.ts`) does the same for admins (any authenticated user). |
| Grade mark not color-coded | The grade was displayed in a fixed-green block regardless of the value. | Added `gradeTierForValue` / `gradeClassForValue` helpers in `screenUtils.ts` and four matching CSS modifiers (`--low` < 50 red, `--mid` 50..80 yellow, `--high` 81..100 green, `--unknown` neutral). Applied to both the AI result screen and the submission-detail AI result section. |
| AI gateway returned 403 after the model fix | The OpenClaw gateway also requires `x-openclaw-scopes: operator.admin,operator.read,operator.write` on every request — without it: HTTP 403. Updated `AI_API.md` documents this; older versions did not. | Added the `x-openclaw-scopes` header in `nourlmsAiProxy.ts` (default `operator.admin,operator.read,operator.write`, overridable via `AI_API_SCOPES`). Updated default `MODEL` to `openclaw/default`. Set both in `.env` so it works out of the box. |
| Scroll wheel did nothing on any homework page (round 1 fix didn't take effect) | The CSS-only fix was insufficient because every screen does `parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll')` — and `parent` was `this.bodyContainer`, which already has `.nourlms-hw-editor__body`. So `.nourlms-hw-editor__body` (display: flex; flex-direction: column; overflow: hidden) AND `.nourlms-hw-screen--scroll` (overflow-y: auto) ended up on the SAME DOM node, with the body's flex-column squashing the screen's inner content (default `flex-shrink: 1`) — nothing to scroll. | Restructured the editor pane: `renderRoute()` now creates a FRESH `<div class="nourlms-hw-screen nourlms-hw-screen--scroll">` as a child of `this.bodyContainer` and passes THAT to `screen.mount(...)`. The body and the scroll container are now distinct DOM nodes; the scroll container is plain block with `overflow-y: auto`, so children stack at natural height and the wheel works. The redundant `parent.classList.add('nourlms-hw-screen', 'nourlms-hw-screen--scroll')` calls in each screen are now no-ops (the classes are already on the parent) and are kept for minimal churn. |
| Admin submission detail showed "(empty submission)" even when the student had answered (round 1 fix didn't catch all field names) | The upstream admin detail endpoint can return the answer text under a wide variety of names. Round 1 covered seven; the user's API uses one we hadn't tried (suspected). | Round 2: extended the `ANSWER_KEYS` list in `NourlmsHomeworkApi.normalizeSubmission` to: `content / answer / submitted_answer / submission_content / body / text / submitted_text / student_answer / student_response / solution / code / submission / response`. Also walks one level of common wrapper keys (`submission`, `homework_submission`, `latest_submission`, `last_submission`) when none of the top-level keys match. The normalizer also now stores the original response on a `__raw` property, and `submissionDetailScreen.refresh()` shows a `<details>` "Show raw API response (debug)" accordion next to the "(empty submission)" placeholder so the user (or me, in the next chat round) can copy the actual JSON and add the right field name in seconds. The `ILogService.warn` log now dumps the FULL JSON, not just the keys. |
| Admin submission still showed "(empty submission)" after round 2 | The user pasted the actual upstream JSON: the field is `answer_content` (NourLMS's canonical name for `/admin/homeworks/:id/submissions/:sid`). We hadn't tried that one. | Round 3: prepended `answer_content` to `ANSWER_KEYS` (now first in priority because that is the production endpoint shape). Also: the same response carries a fully-eager `ai_result` object inside the submission, so `SubmissionDetailScreen.fetchSubmission` now calls `extractEmbeddedAiResult(raw)` to use it directly when present and skip the separate `/ai-result` round-trip — the AI grade now appears the moment the submission detail loads. `maybeLoadAiResult()` short-circuits when the embedded result is already present. Recognized embedded keys: `ai_result`, `latest_ai_result`, `grading_result`. |

---

## Token-saving notes for future chats

- **Don't re-explain the architecture**; read this file.
- **Don't re-search for files**; the table above lists every file the feature owns.
- **Don't re-derive the API allow-list**; copy from the table above and grep `nourlmsApiProxy.ts` to confirm.
- **Bug already fixed?** Check the "Bugs fixed" table; mention the row by name.
- **AI key handling** is server-side only; never put `AI_API_KEY` in any browser-visible code or test fixture.
