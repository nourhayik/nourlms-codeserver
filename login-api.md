# Login API Documentation

## Base URL

```
http://nourlmsv3.local/api
```

> Replace with your production domain when deploying.

---

## Authentication Endpoints

### Login

Authenticate a user by phone number and password. Returns a Sanctum bearer token and the user profile with their assigned roles.

**Endpoint**

```
POST /api/auth/login
```

**Rate Limiting** — 5 requests per minute per IP. Exceeding this limit returns `429 Too Many Requests`.

#### Request Body

| Field      | Type   | Required | Description            |
|------------|--------|----------|------------------------|
| `phone`    | string | Yes      | User's phone number    |
| `password`  | string | Yes      | User's password        |

#### Example Request

```bash
curl -X POST http://nourlmsv3.local/api/auth/login \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"phone": "+9647700000000", "password": "secret123"}'
```

#### Success Response — `200 OK`

```json
{
  "user": {
    "id": 1,
    "name": "Ahmed",
    "phone": "+9647700000000",
    "is_block": false,
    "roles": ["student"],
    "created_at": "2025-01-01T00:00:00.000000Z"
  },
  "token": "1|abc123def456ghi789..."
}
```

| Field             | Type    | Description                        |
|-------------------|---------|------------------------------------|
| `user.id`         | int     | User's unique ID                   |
| `user.name`       | string  | User's full name                   |
| `user.phone`      | string  | User's phone number                |
| `user.is_block`   | boolean | Whether the account is suspended   |
| `user.roles`      | array   | List of role names (e.g. `admin`, `student`) |
| `user.created_at` | string  | ISO 8601 timestamp                 |
| `token`           | string  | Sanctum bearer token               |

---

### Logout

Invalidate the current bearer token.

**Endpoint**

```
POST /api/auth/logout
```

**Authentication** — Requires a valid Sanctum bearer token.

#### Example Request

```bash
curl -X POST http://nourlmsv3.local/api/auth/logout \
  -H "Accept: application/json" \
  -H "Authorization: Bearer 1|abc123def456ghi789..."
```

#### Success Response — `200 OK`

```json
{
  "message": "Logged out successfully"
}
```

---

## Authenticated Requests

Include the token in the `Authorization` header on all subsequent requests:

```
Authorization: Bearer <token>
```

#### Example

```bash
curl http://nourlmsv3.local/api/user \
  -H "Accept: application/json" \
  -H "Authorization: Bearer 1|abc123def456ghi789..."
```

---

## Error Responses

### 401 Unauthorized — Invalid Credentials

Returned when the phone number does not exist or the password is incorrect. The response does **not** reveal which field is wrong.

```json
{
  "message": "Invalid credentials"
}
```

### 403 Forbidden — Account Suspended

Returned when the user's account has been blocked (`is_block = true`).

```json
{
  "message": "Account is suspended"
}
```

### 422 Unprocessable Entity — Validation Error

Returned when required fields are missing or invalid.

```json
{
  "message": "The phone number is required.",
  "errors": {
    "phone": ["The phone number is required."]
  }
}
```

### 429 Too Many Requests — Rate Limit Exceeded

Returned when more than 5 login attempts are made within 60 seconds from the same IP.

```json
{
  "message": "Too many login attempts. Please try again later."
}
```

### 401 Unauthorized — Token Expired or Invalid

Returned when making authenticated requests with an expired or invalid token.

```json
{
  "message": "Unauthenticated."
}
```

---

## Token Expiration

- Tokens expire **1 hour** after issuance (configured in `config/sanctum.php` `expiration => 60` minutes).
- After expiration, the client must re-authenticate via `POST /api/auth/login`.
- Expired token records are pruned daily via the scheduled `sanctum:prune-expired` command.

---

## Security Notes

- **Rate limiting**: The login endpoint is limited to 5 requests per minute per IP address.
- **No credential leak**: Error messages for wrong phone and wrong password are identical (`Invalid credentials`).
- **Blocked accounts**: Suspended users receive a distinct `403` response, not `401`.
- **Token storage**: Tokens are stored as SHA-256 hashes in the database. The plain-text token is only returned once at login time.
- **HTTPS**: Always serve this API over HTTPS in production to protect tokens in transit.