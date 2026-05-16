# REST API additions required by the new Homework feature

The code-server side now calls **two new endpoints** that the upstream NourLMS Laravel API doesn't yet expose. Run the prompts below in your `nourlmsv3` (REST API) project — each is self-contained and can be pasted as a single Cursor prompt.

If either endpoint already exists under a different name, just route the existing one to the new path (or update the proxy allow-list in `src/vs/server/node/nourlmsApiProxy.ts` here to match the existing path).

> **Response-shape note** — the Code Server client now accepts BOTH raw and Laravel-API-Resource-wrapped responses for ALL list and detail endpoints (raw `[...]`, `{data:[...]}`, `{data:{data:[...]}}` for lists; raw `{...}` and `{data:{...}}` for single items; native `paginate()` and resource-wrapped paginators). So you may freely use `Resource::collection(...)`, `new SubjectResource(...)`, or just return the model — whichever the rest of your project uses. The previous "many things flash and disappear" / `TypeError: this.courses.map is not a function` bugs were caused by the client not unwrapping; that is now fixed and you don't need to constrain the API to a specific shape.

---

## Prompt 1 — `GET /admin/students/{id}/courses`

> **Why:** the Code Server admin Question Bank limits the question list to courses the current student is enrolled in. Without this endpoint, the admin sees every question in the system.

```
Add a new admin-only endpoint to the NourLMS REST API:

ROUTE: GET /api/admin/students/{id}/courses
ROLE GATE: admin only (return 404 not 403 if the caller is not an admin, to match the rest of the admin/* routes)

BEHAVIOR:
- Resolve the User by id; 404 if not found.
- Return the distinct list of Courses that the student is currently enrolled in.
  - Use whichever relation already wires students to courses in the existing schema (e.g. `enrollments`, `course_user`, `student_courses`, etc.). Don't invent a new pivot if one already exists.
- Each Course in the response must use the same JSON shape as `GET /api/question-bank/courses` already returns (id, name, university_id when applicable).

RESPONSE: JSON array of Course objects (NOT paginated — students are typically enrolled in <50 courses).

EXAMPLE 200:
[
  { "id": 12, "name": "Intro to Programming", "university_id": 3 },
  { "id": 18, "name": "Data Structures", "university_id": 3 }
]

VALIDATION:
- 404 if the user id doesn't exist OR the authenticated caller is not an admin.
- Add a controller test: admin sees a known student's enrollment list; student calling this endpoint gets 404.

DO NOT change any other route, service, or model. Only add the new controller method, route, and test.
```

---

## Prompt 2 — `POST /question-bank/subjects`

> **Why:** the new "New code question" form (admin-only) uses the AI assistant to draft a question from a free-text prompt. If the AI suggests a subject that doesn't exist yet under the chosen course, the admin can click "Create subject" inline. That click currently has no upstream endpoint to call.

```
Add a new admin-only endpoint to the NourLMS REST API:

ROUTE: POST /api/question-bank/subjects
ROLE GATE: admin only (404 on non-admin, matching the rest of /question-bank/*).

REQUEST BODY (JSON):
{
  "name": string (required, 2..120 chars, trimmed),
  "course_id": integer (required, must reference an existing course)
}

BEHAVIOR:
- Validate the body. On validation failure return 422 with the standard Laravel error envelope:
    { "message": "...", "errors": { "field": ["msg", ...] } }
- Reject duplicates: if a Subject with the same `name` already exists for the same `course_id`, return 422 with:
    { "message": "A subject with this name already exists in the chosen course.",
      "errors": { "name": ["A subject with this name already exists in the chosen course."] } }
- On success, create a new row in the same Subject table that `GET /api/question-bank/subjects` and `GET /api/question-bank/courses/{id}/subjects` already return from. 201 with the created Subject in the SAME shape those existing endpoints return:
    { "id": 42, "name": "List comprehensions", "course_id": 18 }

DO NOT trigger any side effects (no email, no event, no audit log call) — this is a CRUD insert only.

ADD A CONTROLLER TEST:
- admin creates a subject — 201, body matches shape;
- admin posts a duplicate name+course pair — 422 with the named error;
- student calls the endpoint — 404 (not 403);
- missing name OR course_id — 422.

DO NOT change any other route, service, or model. Only add the new controller method, route, FormRequest (if your project uses them), and tests.
```

---

## After the API merges

1. Pull / deploy the API.
2. No code-server change needed — both endpoints are already wired in the proxy allow-list (`src/vs/server/node/nourlmsApiProxy.ts`) and the client (`src/vs/workbench/contrib/nourlms/browser/homework/nourlmsHomeworkApi.ts`).
3. Verify by:
   - opening the Homework page as admin in a student's workspace → the Course filter dropdown shows only that student's courses;
   - in "New question" → AI prompt → if the AI suggests a brand-new subject, the inline "Create subject" button finishes the round-trip without a 404 in DevTools.
