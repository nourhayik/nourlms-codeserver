# Contract: `/nourlms-api/*` Server Proxy

**File**: `src/vs/server/node/nourlmsApiProxy.ts` (new) and a small route addition in `src/vs/server/node/remoteExtensionHostAgentServer.ts`.

This proxy sits between the workbench (browser) and the upstream NourLMS API. It exists so the upstream Sanctum bearer token never reaches the browser (FR-011) and so role-based and per-route access control is enforced server-side as defence in depth.

---

## 1. Wire contract

### Request (browser → server)

Same-origin HTTP request from the workbench:

```
<METHOD> /nourlms-api/<path>?<query>     HTTP/1.1
Host: <code-server-host>
Cookie: nourlms.session=<encrypted>
Content-Type: application/json        # only for POST/PATCH bodies
Accept: application/json
<body if any>
```

`<METHOD>` MUST be one of `GET`, `POST`, `PATCH`. The proxy rejects any other method with `405`.

### Response (server → browser)

Status code, `Content-Type`, and body are forwarded verbatim from the upstream LMS, except in these cases:

- **No session cookie / invalid cookie**: 302 redirect to `/nourlms-login` (handled by the existing pre-`/nourlms-api` middleware in `remoteExtensionHostAgentServer.ts:235–243`).
- **Session present but route not in allow-list**: `404 Not Found` with body `{"error":"Route not exposed"}`. (Returns 404, not 403, to avoid leaking the existence of admin-only routes to a student.)
- **Session present, route allow-listed, but role mismatch** (admin route called by a student or vice versa): `404 Not Found` with body `{"error":"Route not exposed"}`. Same reasoning.
- **Upstream returns 401**: `401 Unauthorized` with body `{"error":"Session expired"}`. The panel detects this and triggers re-login.
- **Upstream timeout / network error**: `502 Bad Gateway` with body `{"error":"Upstream unreachable","retry":true}`.
- **Upstream `Content-Type` is non-JSON**: still forwarded verbatim, but the panel ignores anything that isn't `application/json` and surfaces an inline error.

---

## 2. Allow-list

Each entry is `[method, path-pattern, role]`. `path-pattern` uses Express-style `:param` placeholders. Patterns are matched after stripping the leading `/nourlms-api`.

### 2.1 Question Bank — admin only

| Method | Path pattern | Required role | Upstream | Spec FR |
|---|---|---|---|---|
| `GET` | `/question-bank/questions` | `admin` | `GET /api/question-bank/questions` | FR-014 |
| `POST` | `/question-bank/questions` | `admin` | `POST /api/question-bank/questions` | FR-020, FR-021 |
| `GET` | `/question-bank/questions/:id` | `admin` | `GET /api/question-bank/questions/:id` | (open-as-page) |
| `GET` | `/question-bank/courses` | `admin` | `GET /api/question-bank/courses` | FR-014 (filter source) |
| `GET` | `/question-bank/subjects` | `admin` | `GET /api/question-bank/subjects` | FR-014 |
| `GET` | `/question-bank/courses/:id/subjects` | `admin` | `GET /api/question-bank/courses/:id/subjects` | FR-014 |
| `GET` | `/question-bank/difficulty-rates` | `admin` | `GET /api/question-bank/difficulty-rates` | FR-020 (form options) |
| `GET` | `/question-bank/question-types` | `admin` | `GET /api/question-bank/question-types` | FR-015 (resolve `code` type ID) |

### 2.2 Admin Homeworks

| Method | Path pattern | Required role | Upstream | Spec FR |
|---|---|---|---|---|
| `GET` | `/admin/homeworks` | `admin` | `GET /api/admin/homeworks` | FR-023 |
| `POST` | `/admin/homeworks/assign` | `admin` | `POST /api/admin/homeworks/assign` | FR-017 |
| `GET` | `/admin/homeworks/:id` | `admin` | `GET /api/admin/homeworks/:id` | FR-024 |
| `GET` | `/admin/homeworks/:id/submissions` | `admin` | `GET /api/admin/homeworks/:id/submissions` | FR-024 |
| `GET` | `/admin/homeworks/:id/submissions/:sid` | `admin` | `GET /api/admin/homeworks/:id/submissions/:sid` | FR-024 |
| `PATCH` | `/admin/homeworks/:id/submissions/:sid/correct` | `admin` | `PATCH /api/admin/homeworks/:id/submissions/:sid/correct` | (admin manual correction) |
| `POST` | `/admin/homeworks/:id/ai-grade` | `admin` | `POST /api/admin/homeworks/:id/ai-grade` | FR-025 |
| `POST` | `/admin/homeworks/:id/ai-grade/regrade` | `admin` | `POST /api/admin/homeworks/:id/ai-grade/regrade` | FR-026 |

### 2.3 Student Homeworks

| Method | Path pattern | Required role | Upstream | Spec FR |
|---|---|---|---|---|
| `GET` | `/student/homeworks` | `student` | `GET /api/student/homeworks` | FR-028, FR-029 |
| `GET` | `/student/homeworks/courses` | `student` | `GET /api/student/homeworks/courses` | FR-029 (filter helper) |
| `GET` | `/student/homeworks/:id` | `student` | `GET /api/student/homeworks/:id` | FR-030 |
| `POST` | `/student/homeworks/:id/submit` | `student` | `POST /api/student/homeworks/:id/submit` | FR-031 |
| `GET` | `/student/homeworks/:id/submissions` | `student` | `GET /api/student/homeworks/:id/submissions` | FR-034 |
| `GET` | `/student/homeworks/:id/submissions/:sid` | `student` | `GET /api/student/homeworks/:id/submissions/:sid` | FR-034 |

### 2.4 AI Grading Results — both roles, ownership enforced upstream

| Method | Path pattern | Required role | Upstream | Spec FR |
|---|---|---|---|---|
| `GET` | `/ai-grading/results/:id` | `admin` or `student` | `GET /api/ai-grading/results/:id` | FR-027, FR-034 |
| `GET` | `/homeworks/:id/submissions/:sid/ai-result` | `admin` or `student` | `GET /api/homeworks/:id/submissions/:sid/ai-result` | FR-027, FR-034 |
| `GET` | `/homeworks/:id/submissions/:sid/ai-result/status` | `admin` or `student` | `GET /api/homeworks/:id/submissions/:sid/ai-result/status` | FR-035 (poll) |

The upstream API enforces the student-ownership check (returns 404 for the wrong student per the API doc §3); the proxy doesn't re-check ownership.

---

## 3. Header forwarding rules

### Browser → upstream

| Header | Action |
|---|---|
| `Authorization` | **Replaced** with `Bearer <session.token>` from the encrypted session cookie. The browser MUST NOT send any `Authorization` header; if it does, it's stripped before the upstream call. |
| `Content-Type` | Forwarded as-is for write methods. |
| `Accept` | Forwarded as-is, defaulted to `application/json` if absent. |
| `Cookie` | **Stripped** — the session cookie is local to this server only; we don't share it with upstream. |
| `Cache-Control`, `If-None-Match`, etc. | Forwarded as-is. |
| All other headers | Stripped (defence against header smuggling). |

### Upstream → browser

| Header | Action |
|---|---|
| `Content-Type` | Forwarded verbatim. |
| `Cache-Control` | Forwarded verbatim (the LMS already sets `no-store` where appropriate; we don't add it ourselves). |
| `Set-Cookie` | **Stripped** — upstream may set its own session cookies (we don't want them in the browser). |
| Pagination headers (`Link`, etc.) | Forwarded verbatim. |
| All other headers | Stripped. |

---

## 4. Body forwarding rules

- **Request body**: forwarded verbatim (the proxy reads the entire body into a `Buffer` first because POST bodies in this codebase are typically tiny — see `_handleNourlmsLogin` at `remoteExtensionHostAgentServer.ts:407–426` for the same pattern). Hard cap at **2 MB**; bodies larger return `413 Payload Too Large` without forwarding (the panel's own client-side cap is 1 MB per research.md §7, so 2 MB is plenty of headroom for small JSON-wrapped payloads).
- **Response body**: streamed back chunk-by-chunk to avoid buffering large lookup-list responses in memory.

---

## 5. Concrete TypeScript signature

```ts
// src/vs/server/node/nourlmsApiProxy.ts

import type * as http from 'http';
import type * as nodeHttp from 'http';
import type { ILogService } from '../../platform/log/common/log.js';
import type { NourlmsSession } from './nourlmsAuth.js';

export interface NourlmsProxyRoute {
    method: 'GET' | 'POST' | 'PATCH';
    pathPattern: string;       // express-style with :param tokens
    role: 'admin' | 'student' | 'any';
}

/** Static, exported so tests can assert the shape. */
export const NOURLMS_PROXY_ALLOWLIST: readonly NourlmsProxyRoute[];

export function handleNourlmsApiProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,           // already stripped of /nourlms-api
    nourlmsApiUrl: string,
    session: NourlmsSession,
    logService: ILogService
): Promise<void>;
```

---

## 6. Allow-list test contract

A unit test in `src/vs/server/test/node/nourlmsApiProxy.test.ts` MUST cover:

| Test | Expected |
|---|---|
| Each route in the allow-list parses cleanly. | All `:param` tokens resolved. |
| Every spec FR that references an upstream endpoint has at least one matching allow-list entry. | Verified by a static map FR → route in the test. |
| A request to a non-allow-listed path returns 404 (not 403). | True. |
| A student calling an admin-only allow-listed route returns 404 (not 403). | True. |
| `Authorization` and `Cookie` headers from the browser are stripped. | True. |
| The upstream `Set-Cookie` is stripped. | True. |
| 401 from upstream is forwarded as 401 with `{"error":"Session expired"}`. | True. |
| Upstream network failure becomes 502. | True. |
| **Forged ID — SC-005 (a)**: a student session calls `/nourlms-api/student/homeworks/<id-not-owned>` (mocked upstream returns 404 per API §3); the proxy MUST forward as 404 unmodified, MUST NOT re-shape the body, and MUST NOT log the upstream body content (only the status). | True. |
| **No timer-driven list polling — FR-039 / SC-010**: a static grep over the proxy + view source code asserts that no `setInterval` or `setTimeout` call wraps an `IRequestService.request(...)` to a list endpoint (`/question-bank/questions`, `/admin/homeworks`, `/student/homeworks`, `/admin/homeworks/:id/submissions`, `/student/homeworks/:id/submissions`). | True. |

---

## 7. Operational notes

- **Logging**: Every proxy request is logged at `trace` level with method + path (no body, no token). 5xx responses are logged at `warn`.
- **No metrics added** in this slice; the existing telemetry surfaces are not extended.
- **No new CLI args**: the existing `--nourlms-api-url` (`src/vs/server/node/serverEnvironmentService.ts:102–103`) is used as the upstream base URL. `nourlmsApiUrl` defaulting follows the same code path as `_handleNourlmsLogin` (`remoteExtensionHostAgentServer.ts:209–212`).
