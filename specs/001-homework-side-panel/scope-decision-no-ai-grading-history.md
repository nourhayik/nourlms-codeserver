# Scope decision: AI grading history is intentionally not surfaced

**Status**: Accepted (locked)
**Date**: 2026-05-04
**Audience**: anyone reading this slice — engineers, reviewers, future feature owners
**Originating slice**: `specs/001-homework-side-panel/`
**Related requirement**: `spec.md` FR-027

> **TL;DR**: The Homework Side Panel renders **only the latest** AI grading result per submission. There is no history, the panel does not show any history, and we are **not** asking the NourLMS backend to add a history capability. This is a permanent design decision, not a deferred feature.

---

## 1. The decision

For each student submission (`QuestionAnswer` row), the panel surfaces only the **single latest** `AiGradingResult` row. When an admin re-grades, the upstream `AiReGradeJob` updates that same row in place and stamps `regraded_at`; previous-version data is overwritten. The panel reflects whatever the upstream now reports as "latest" and shows no record of prior grading attempts.

The two API methods exposed in the panel's typed client cover exactly this:

- `getLatestAiResult(homeworkId, submissionId)` → the single most recent `AiGradingResult`, or 404 if none exists.
- `getAiGradingResult(resultId)` → fetch one specific result by id (used to render the same row from a notification or a saved bookmark; not used to enumerate).

There is no "list results for a submission" call, no history tab in any panel view, no audit trail of grading attempts inside this feature.

## 2. Why we don't ask the backend to add history

This was discussed during `/speckit.analyze` fix-up on 2026-05-04. We considered three options and rejected the two that would have introduced history:

| Option | Outcome | Why rejected |
|---|---|---|
| **A. Tighten spec to "latest only"** | Chosen. Panel commits to latest-only forever. | (No rejection — this is the chosen path.) |
| B. Ask the backend to add `GET /api/homeworks/{id}/submissions/{sid}/ai-results` + a soft-history table or append-only `is_current` flag. | Rejected. | The NourLMS backend currently has **no** grading-history concept (each `AiGradingResult` is updated in place by `AiReGradeJob`). Adding history requires a schema change (new table or new column), migration, job rewrite, contract test, and a follow-up panel slice. The cost is large; the user-visible benefit (admin can see "this used to be 62, now it's 78") is small and is not in any user story in `spec.md`. |
| C. Have the panel cache previous result ids client-side as an admin re-grades within the same workbench session. | Rejected. | Best-effort, wiped on reload; misleading UX ("history exists, but only sometimes"); inconsistent across tabs/users. |

**Bottom line**: the upstream is the source of truth for what "the AI graded this submission" means today, and the upstream's truth is "the latest result, period". The panel matches that truth exactly.

## 3. Implications for users

- **Admins**: After re-grading, the previous grade and feedback are gone from the panel — the new latest result replaces them. If you want a paper trail across re-grades, write notes in the **manual correction** field (`PATCH /admin/homeworks/{id}/submissions/{sid}/correct` with `correct_the_answer`); that field is preserved separately and is the intended audit channel.
- **Students**: Always see one (1) AI grade per submission. If you re-submit (allowed only when no submission has been corrected yet — see FR-033a), each new submission has its own grading lifecycle and its own latest result.

## 4. Implications for implementation

- **Spec**: `FR-027` reads "the **latest** result MUST be reachable" and explicitly says historical results are **not** in scope. This is permanent — no asterisk, no "follow-up slice".
- **Plan / Tasks**: There are no tasks to add a history view, no backend hand-off task, no dependency on a future endpoint. The two API methods `getLatestAiResult` and `getAiGradingResult` are the entire surface.
- **Data model**: `Submission.latest_ai_result_id` is the only pointer the panel keeps; we do not collect, list, or persist any other result ids.
- **Contracts**: `contracts/workbench-views.md` §2 documents `getLatestAiResult` with a note that history is intentionally not exposed; `contracts/server-proxy.md` allow-lists only the latest + by-id endpoints under "shared roles".
- **No backend ticket**: Do **not** open a ticket against the NourLMS Laravel backend asking for a history endpoint as a result of this slice. If a future product decision genuinely needs history, that's a new slice with its own spec — at which point this decision record is the right place to record the reversal.

## 5. If you find yourself wanting to revisit this

You're allowed to. The right path is:

1. Open a new feature spec (`/speckit.specify`) describing the user story that needs history (e.g. "as an admin I need to see how a student improved across re-grades").
2. In that new spec, link back to this decision record and explain what changed.
3. Generate a fresh backend prompt (this time genuinely a prompt — asking for a real new endpoint) **inside that new spec's directory**, not this one.

That keeps every "decision and its later reversal" properly attributed in version control.

## 6. Why this file exists at all

So nobody re-litigates the question silently. If a future reader (or a future agent) sees the panel only showing the latest result and wonders "why don't we have history?", the answer is here, with the rationale and the rejected alternatives recorded. This is an Architecture Decision Record (ADR), not a request for action.
