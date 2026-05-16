# Quickstart: NourLMS Homework Side Panel

This is the manual smoke-test guide for the feature. Follow the steps in order; each section maps to a top-priority user story in `spec.md`.

## Prerequisites

- A running upstream NourLMS API reachable at `<NOURLMS_API_URL>` (default `http://nourlmsv3.local/api`). At minimum it must serve the endpoints documented in `documentation/Homework_AI_Grading_API.md`.
- A built `nourlms-codeserver` server (this repo). To build: `npm install && npm run compile` (or use the existing project task — see the repo `README.md`).
- Two test accounts on the upstream LMS:
  - **Admin** account — phone + password.
  - **Student** account — phone + password.
- For the student account: at least one **code-type** question already in the question bank (or be prepared to create one as the admin in step 3 below). One easy way to seed is to log in as admin first, create a code question, then assign it to the student account before signing in as student.

## Start the server

```bash
node out/server-main.js \
    --port 3000 \
    --without-connection-token \
    --nourlms-api-url "<NOURLMS_API_URL>" \
    --nourlms-workspaces-dir "$HOME/nourlms-workspaces"
```

(Adjust `--port` and other args to your local convention; everything else mirrors the existing run script.)

## 0. Smoke test — sanity

1. Open `http://localhost:3000/` in a browser.
2. You should be redirected to `/nourlms-login`.
3. Sign in as the admin account.
4. After login, the workbench loads. Open the Secondary Side Bar via **View → Toggle Secondary Side Bar** (or `Ctrl/Cmd+Alt+B`).
5. From the Secondary Side Bar's container picker (right-click on the bar → pick container, or via **View: Open View** in the command palette), choose **Homework**.

✅ Expected: a container labeled "Homework" opens on the right with two collapsible sections: "Question Bank" and "Assigned to Current Student". The latter shows "No student selected".

## 1. User Story 2 — Admin assigns a code question to a student (P1)

1. From the **primary** sidebar, open the existing **Student Workspaces** view (it has the same activity icon set as the existing nourlms feature).
2. Click on a known student's workspace (e.g. the test student you set up). The workbench reloads with `?folder=...` set to that student's workspace.
3. Re-open the Secondary Side Bar → Homework container. The "Assigned to Current Student" header should now show the student's display name (resolved via the new sidecar lookup).
4. In "Question Bank":
   - Filter by question type = "code" (or use the type column / badge to identify code questions).
   - Pick at least one code question.
   - Click **Assign to current student**.

✅ Expected: a notification appears with `Assigned 1 (0 already assigned)`. The "Assigned to Current Student" pane refreshes to include the new homework.

❌ Common failures:
- "No student selected" stays after step 3 → the `.nourlms-user.json` sidecar wasn't written. Verify the student has logged in **at least once** since this feature was deployed (the sidecar is written on each student login).
- 401 → session expired; you'll be redirected to `/nourlms-login`. Sign in again and retry.

## 2. User Story 1 — Student views and submits assigned homework (P1)

1. Open a private/incognito window to `http://localhost:3000/`.
2. Sign in as the test student.
3. The workbench loads with the student's own workspace forced as the folder.
4. Open the Secondary Side Bar → Homework. The "My Homework" pane lists the homework you just assigned in step 1.
5. Click the homework item. A detail area opens inline.
6. Verify the question content renders sanitized (no `<script>` execution; HTML formatting visible).
7. Click **Open as Page**. The question opens as a regular editor tab in a **new editor group beside the active group**.
8. Move it around with **View → Editor Layout → Two Columns / Three Rows / etc.** to confirm it behaves like any other editor tab.
9. Back in the panel, type any text in the answer area and click **Submit**.

✅ Expected: a notification confirms `Submission #N created.` The "Submissions" sub-area lists the new submission.

10. (If the question is `is_auto_correct`) within ~2 seconds the submission's AI status should flip from "Pending" to "Ready" once the upstream finishes grading. The grade and feedback render. (If grading is slow on your environment the panel will keep polling per the bounded backoff up to ~10 minutes.)

11. Click **Submit from file…** with a workspace file containing your code. The file's text contents are loaded and sent.

❌ Common failures:
- "File exceeds the 1 MB limit." → pick a smaller file.
- "Selected file is not text-readable." → the file failed the UTF-8 / null-byte check; pick a `.py`/`.js`/`.txt`/etc. file.
- The submit controls are disabled and an inline notice says "This homework has been graded by your admin — no further submissions are accepted." → expected behavior per FR-033a; the admin has already corrected one of your prior submissions for this homework.

## 3. User Story 5 — Admin creates a new code question (P3)

1. Back in the admin window, in the Homework container's "Question Bank" pane, click **New code question**.
2. Fill the form:
   - Content (HTML allowed)
   - Course / subject / difficulty / weight / time-in-second
   - Optional best answer + pre-answer
3. Click **Create**.

✅ Expected: the new question appears at the top of the question list (no manual reload). You can now repeat User Story 2 with this newly-created question.

❌ Common failures:
- 422 with field-level errors → fix the fields, your input is preserved.
- The "Type" field is fixed to "code" and not editable — this is by design (FR-020).

## 4. User Story 4 — Admin reviews and grades a submission (P2)

1. With the student's workspace open in the admin window, in "Assigned to Current Student" find the homework that has at least one student submission.
2. Click into the homework → "Submissions" sub-list.
3. Click a submission → click **Open as Page** to read it side-by-side with the original question.
4. Click **Run AI grade (queued)**. A notification confirms the job is dispatched. The submission row's AI status flips to "Pending" and polls until "Ready".
5. After it's "Ready", click the result → it renders inline. Click **Open as Page** to view the result detail (grade, errors, hints, explanation, comparison) full-size.
6. Click **Re-grade**. The status flips to "Pending" again until the new result lands.

## 5. User Story 3 — Student reviews their submissions and AI results (P2)

1. In the student window, click into the homework you submitted to.
2. Click "Submissions" → pick a submission → confirm the AI grading result fields render.
3. Confirm there is **no** "Request AI grade" button anywhere in the student view (only "Open as Page" and submission viewing).

✅ Expected: students can read results but never trigger grading themselves (FR-035a).

## 6. Negative / regression tests

- **Logout**: Click "Sign out" / navigate to `/nourlms-logout`. Any open Homework "as Page" tabs MUST close, and you MUST be redirected to `/nourlms-login`.
- **Session expiry**: Wait 55 minutes (the cookie's max-age) and try a panel action. The panel surfaces a "session expired" message and redirects to `/nourlms-login`.
- **No student workspace open (admin)**: Open the workbench at `?folder=<some non-student folder>`. The "Assigned to Current Student" pane shows empty, and the "Assign to current student" button in the question bank is disabled with the inline tooltip.
- **Non-code question (admin)**: If you happen to have a non-code question in the bank, verify its row shows the assign action **disabled** with the "Only code questions can be assigned from this panel" tooltip.

## 7. Optional automated tests (run after `npm run compile`)

```bash
# Server-side proxy + sidecar
npm test -- --grep "nourlmsApiProxy"
npm test -- --grep "nourlmsAuth.workspace.sidecar"

# Workbench-side polling helper + bundle isolation
npm test -- --grep "HomeworkPollingRegistry"
npm test -- --grep "nourlms-student-view-bundle"
```

## Troubleshooting cheatsheet

| Symptom | Likely cause | Fix |
|---|---|---|
| Container labeled "Homework" never appears in Secondary Side Bar picker | The new contribution wasn't built into the bundle | Re-run `npm run compile` and hard-reload the browser. |
| Admin sees "No student selected" even after opening a student folder | Sidecar `.nourlms-user.json` missing | Have the student log in once after deploy. |
| Student panel shows "Session expired" loop | Session cookie cleared but workbench still cached | Hard-reload (Cmd/Ctrl+Shift+R). |
| AI grading result never lands within 10 minutes | Upstream queue worker not running | Check `Horizon` (Laravel queue) on the upstream LMS. |
| 502 Bad Gateway from `/nourlms-api/...` | Upstream LMS unreachable | Verify `--nourlms-api-url` and DNS. |
| Submitting from a `.py` file says "not text-readable" | UTF-8 decode failed (e.g. file is UTF-16 with BOM) | Re-save the file as UTF-8. |
