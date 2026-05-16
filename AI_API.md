# AI API — integration guide

This is an **OpenAI-compatible** API. If you can call OpenAI's chat completions, you can call this API with minimal changes.

---

## Base URL

```
https://ai.nourlms.com/v1
```

## Authentication & required headers

Every request must include all three headers:

```http
Authorization: Bearer reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw
Content-Type: application/json
x-openclaw-scopes: operator.admin,operator.read,operator.write
```

> `x-openclaw-scopes` is required by this gateway — requests without it will be rejected.

## Model

```
openclaw/default
```

---

## Making a request

### Endpoint

```
POST https://ai.nourlms.com/v1/chat/completions
```

### Request body

```json
{
  "model": "openclaw/default",
  "temperature": 0.3,
  "response_format": { "type": "json_object" },
  "messages": [
    { "role": "system", "content": "You only reply with valid JSON." },
    { "role": "user",   "content": "Your prompt here." }
  ]
}
```

### Reading the response

```
response.choices[0].message.content   →   string (parse as JSON when using response_format)
```

---

## Examples

### curl

```bash
curl -sS https://ai.nourlms.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw" \
  -H "x-openclaw-scopes: operator.admin,operator.read,operator.write" \
  -d '{
    "model": "openclaw/default",
    "temperature": 0.3,
    "response_format": { "type": "json_object" },
    "messages": [
      { "role": "system", "content": "You only reply with valid JSON." },
      { "role": "user", "content": "Return {\"hello\": \"world\"}." }
    ]
  }'
```

### Node.js (`openai` package)

```js
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw",
  baseURL: "https://ai.nourlms.com/v1",
  defaultHeaders: {
    "x-openclaw-scopes": "operator.admin,operator.read,operator.write",
  },
});

const completion = await client.chat.completions.create({
  model: "openclaw/default",
  temperature: 0.3,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: "You only reply with valid JSON." },
    { role: "user",   content: "Your prompt here." },
  ],
});

const result = JSON.parse(completion.choices[0].message.content);
```

### Python (`openai` library)

```python
from openai import OpenAI

client = OpenAI(
    api_key="reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw",
    base_url="https://ai.nourlms.com/v1",
    default_headers={
        "x-openclaw-scopes": "operator.admin,operator.read,operator.write",
    },
)

completion = client.chat.completions.create(
    model="openclaw/default",
    temperature=0.3,
    response_format={"type": "json_object"},
    messages=[
        {"role": "system", "content": "You only reply with valid JSON."},
        {"role": "user",   "content": "Your prompt here."},
    ],
)

result = completion.choices[0].message.content  # parse as JSON if needed
```

### PHP (Laravel `Http` facade)

```php
$response = Http::withHeaders([
    'Authorization' => 'Bearer reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw',
    'Content-Type'  => 'application/json',
    'x-openclaw-scopes' => 'operator.admin,operator.read,operator.write',
])->post('https://ai.nourlms.com/v1/chat/completions', [
    'model'           => 'openclaw/default',
    'temperature'     => 0.3,
    'response_format' => ['type' => 'json_object'],
    'messages'        => [
        ['role' => 'system', 'content' => 'You only reply with valid JSON.'],
        ['role' => 'user',   'content' => 'Your prompt here.'],
    ],
]);

$result = json_decode($response->json('choices.0.message.content'), true);
```

---

## Environment variables (recommended)

```env
AI_API_KEY=reMoT-sKMqhgjSxWOkcQ7RfaeaZn7sMxnLs30AWT3uw
AI_API_BASE_URL=https://ai.nourlms.com/v1
AI_API_MODEL=openclaw/default
AI_API_SCOPES=operator.admin,operator.read,operator.write
```

---

## Error codes

| Code | Meaning |
|------|---------|
| `401` | Invalid or missing `Authorization` header |
| `403` | Missing or invalid `x-openclaw-scopes` header |
| `429` | Rate limited — back off and retry |
| `5xx` | Gateway/upstream error — retry with exponential backoff |

---

## Security

- Keep the API key server-side only — never expose it in client/browser code.
- Rotate the key if this file or the repo is ever made public.
