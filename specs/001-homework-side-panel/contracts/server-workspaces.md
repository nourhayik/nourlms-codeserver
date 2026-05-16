# Contract: Workspace Sidecar + Extended `/nourlms-workspaces`

This contract defines (a) the new local-disk sidecar file that links a workspace folder to its LMS user ID and (b) the small extensions to the existing `/nourlms-workspaces` server route plus a brand-new lookup endpoint that the Admin Homework view consumes.

---

## 1. Sidecar file

**Path**: `<studentWorkspacePath>/.nourlms-user.json`

**Mode**: `0o600` (owner-only).

**Schema**:

```json
{
    "userId": 42,
    "name": "Ahmed Al-Rashid",
    "sanitizedName": "ahmedalrashid",
    "writtenAt": "2026-05-04T08:00:00.000Z",
    "writtenBy": "nourlms-codeserver"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | integer | yes | LMS user ID. Must be > 0. |
| `name` | string | yes | Original (un-sanitized) display name from the upstream login response. |
| `sanitizedName` | string | yes | The directory's basename. Must equal `path.basename(workspacePath)`. Self-validation. |
| `writtenAt` | string (ISO 8601 UTC) | yes | Last write timestamp. |
| `writtenBy` | string | yes | Constant `"nourlms-codeserver"` for traceability. |

**Write contract** (in `webClientServer.ts`, immediately after `nourlmsAuth.ensureWorkspaceDir(...)` at line 348):

- Called only for `nourlmsSession.role === 'student'`.
- Idempotent: overwrites on every login (cheap, ensures the file always reflects the latest LMS state).
- Failures (EIO, EACCES) are **non-fatal** — logged at `warn`, don't block workbench load. The Admin View will simply show the workspace without `userId` if the sidecar can't be read.

**Read contract** (in a new helper `nourlmsAuth.readWorkspaceSidecar(workspacePath)`):

```ts
export interface NourlmsWorkspaceSidecar {
    userId: number;
    name: string;
    sanitizedName: string;
    writtenAt: string;
    writtenBy: string;
}

export function readWorkspaceSidecar(workspacePath: string): NourlmsWorkspaceSidecar | null;
```

- Returns `null` on missing file, parse error, or `sanitizedName` mismatch.
- Logs `trace` on missing, `warn` on parse error.

**Visibility for student session**: `webClientServer.ts` already injects `configurationDefaults` for the workbench config (`webClientServer.ts:393–397`). Add to those defaults for `role === 'student'`:

```jsonc
{
    "files.exclude": {
        ".nourlms-user.json": true
    }
}
```

---

## 2. Extended `GET /nourlms-workspaces`

**Existing handler**: `_handleNourlmsWorkspaces` in `src/vs/server/node/remoteExtensionHostAgentServer.ts:570–607`.

**Existing response** (admin-only):

```json
{
    "workspaces": [
        { "name": "ahmedalrashid", "path": "/home/nour/nourlms-workspaces/ahmedalrashid" },
        { "name": "lina",          "path": "/home/nour/nourlms-workspaces/lina" }
    ]
}
```

**New response** (admin-only, backward-compatible):

```json
{
    "workspaces": [
        {
            "name": "ahmedalrashid",
            "path": "/home/nour/nourlms-workspaces/ahmedalrashid",
            "userId": 42,
            "displayName": "Ahmed Al-Rashid"
        },
        {
            "name": "lina",
            "path": "/home/nour/nourlms-workspaces/lina"
        }
    ]
}
```

| Field | Type | Required |
|---|---|---|
| `name` | string | yes (unchanged) |
| `path` | string | yes (unchanged) |
| `userId` | integer | **optional** (only present when sidecar exists and parses) |
| `displayName` | string | **optional** (only present when sidecar exists) |

The existing Student Workspaces view (`nourlmsAdminWorkspacesView.ts`) ignores the new fields. The new Admin Homework view consumes `userId` to enable the "Assign to current student" action and `displayName` for nicer rendering.

---

## 3. New endpoint: `GET /nourlms-workspaces/lookup`

**Purpose**: Resolve a single workspace folder path to its LMS `userId`. Used by the Admin Homework view when the open folder changes — the panel calls this once with the basename or full path of the active workspace folder and learns who the current target student is.

**Request**:

```
GET /nourlms-workspaces/lookup?path=<URL-encoded absolute or relative path>
Cookie: nourlms.session=<encrypted>
```

| Query param | Type | Required | Notes |
|---|---|---|---|
| `path` | string | yes | Absolute filesystem path **or** the basename (sanitized name). The handler tries the path as-is, then `<workspacesDir>/<path>`. |

**Response — 200 OK** (sidecar found, `userId` resolvable):

```json
{
    "userId": 42,
    "name": "Ahmed Al-Rashid",
    "sanitizedName": "ahmedalrashid",
    "path": "/home/nour/nourlms-workspaces/ahmedalrashid"
}
```

**Response — 404 Not Found** (folder is not under the configured `nourlms-workspaces-dir`, or sidecar missing/invalid):

```json
{ "error": "Workspace not recognized" }
```

The Admin View treats 404 as "no target student" and disables the assign action (FR-018).

**Response — 403 Forbidden** (caller is not admin):

```json
{ "error": "Access denied." }
```

---

## 4. Path-safety rules (security)

The `lookup` endpoint must not allow path traversal:

1. Resolve the configured `workspacesDir` once: `const wsDirAbs = path.resolve(workspacesDir);`
2. For the incoming `path`:
    - If it's relative, treat it as a basename and resolve against `wsDirAbs`: `const candidate = path.resolve(wsDirAbs, path.basename(rawPath));`
    - If it's absolute, resolve and verify with `candidate.startsWith(wsDirAbs + path.sep) || candidate === wsDirAbs`.
3. If verification fails → 404.
4. Read the sidecar inside `candidate` only — never follow symlinks outside.

Mirrors the existing student-workspace-isolation logic in `remoteExtensionHostAgentServer.ts:271–298`.

---

## 5. Concrete TypeScript signatures

```ts
// src/vs/server/node/nourlmsAuth.ts (additions)

export interface NourlmsWorkspaceSidecar {
    userId: number;
    name: string;
    sanitizedName: string;
    writtenAt: string;
    writtenBy: string;
}

export function writeWorkspaceSidecar(
    workspacePath: string,
    session: NourlmsSession
): void;

export function readWorkspaceSidecar(
    workspacePath: string
): NourlmsWorkspaceSidecar | null;
```

```ts
// In remoteExtensionHostAgentServer.ts — extended handler shape (replaces existing one)

private _handleNourlmsWorkspaces(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    session: NourlmsSession
): void;

private _handleNourlmsWorkspacesLookup(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: NourlmsSession
): void;
```

---

## 6. Backward compatibility

- The extended `/nourlms-workspaces` is fully backward-compatible (`userId` and `displayName` are optional). The existing `nourlmsAdminWorkspacesView.ts` declares `IWorkspaceInfo { name; path; }` and reads only those fields — extra fields are tolerated.
- Old workspaces created before this change will have no sidecar. The first time a student logs in after deploy, the sidecar is written. Until then, the Admin View shows that workspace with no `userId` and the assign action stays disabled with the existing "No student selected" message.

---

## 7. Test contract

Unit tests under `src/vs/server/test/node/`:

| Test | Expected |
|---|---|
| `writeWorkspaceSidecar` writes a valid JSON file at the right path with mode `0o600`. | True. |
| `readWorkspaceSidecar` returns `null` for missing file, malformed JSON, or `sanitizedName` mismatch. | True. |
| Round-trip write→read returns the same data. | True. |
| `_handleNourlmsWorkspaces` includes `userId`/`displayName` only when sidecar present. | True. |
| `_handleNourlmsWorkspaces` returns 403 for non-admin sessions. | True (existing behavior, regression-protected). |
| `_handleNourlmsWorkspacesLookup` returns 404 for paths outside `workspacesDir`. | True. |
| `_handleNourlmsWorkspacesLookup` returns 404 for valid path with missing sidecar. | True. |
| `_handleNourlmsWorkspacesLookup` returns 403 for non-admin sessions. | True. |
| Path traversal (`../../etc/passwd`) returns 404. | True. |
