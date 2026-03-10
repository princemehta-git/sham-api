# ShamCash API Wrapper

A local REST API that mimics the ShamCash **mobile app** (Flutter/Android). Supports unlimited simultaneous sessions, persistent JWT storage, and full account/transaction access.

> **How it works**: Calls `api.shamcash.sy` using the same AES-192-GCM encryption, Bearer JWT tokens, and HTTP headers as the official Android app. Sessions are stored permanently in MySQL (or in-memory) and reused indefinitely.

---

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and set:

```env
PORT=3009
USE_MEMORY=true          # true = no MySQL needed (data lost on restart)

# Already filled with correct values from APK — no change needed
SHAMCASH_AES_KEY=g0Zrgp8XRK/BN2ZAtUfJDQ==
SHAMCASH_SERVER_PUBLIC_KEY="-----BEGIN RSA PUBLIC KEY----- ..."
```

For **persistent sessions** across restarts, set `USE_MEMORY=false` and configure MySQL:

```env
USE_MEMORY=false
MYSQL_HOST=localhost
MYSQL_USER=root
MYSQL_PASSWORD=yourpassword
MYSQL_DATABASE=shamcash_api
```

### 3. Start the server

```bash
node src/index.js
# or with auto-restart:
npx nodemon src/index.js
```

---

## Authentication Flow

Two ways to get an `apiKey`:

| Method | Endpoint | Use when |
|--------|----------|----------|
| Email/Password | `POST /login` | You have credentials |
| QR Scan | `POST /session/createNew` | You want to scan from the mobile app |

Once you have an `apiKey`, pass it in every request:

```
X-API-Key: sk_abc123...
```

---

## API Reference

### Health Check

#### `GET /health`

```bash
curl http://localhost:3009/health
```

**Response:**
```json
{ "ok": true, "service": "shamcash-api", "store": "memory" }
```

---

### Email / Password Login

#### `POST /login`

Login with email and password. Returns an `apiKey` for all subsequent requests.

**Request body:**
```json
{
  "email": "user@example.com",
  "password": "yourpassword",
  "label": "My Account"
}
```

> `label` is optional — a friendly name for the session shown in `GET /sessions`.

**Response (success):**
```json
{
  "success": true,
  "apiKey": "sk_abc123...",
  "email": "user@example.com",
  "message": "Use apiKey in X-API-Key header for all /account/* calls."
}
```

**Response (OTP required):**
```json
{
  "success": false,
  "otpRequired": true,
  "phoneNumber": "+963...",
  "pendingKey": "sk_xyz...",
  "message": "OTP sent. Call POST /login/verify-otp with { email, otpCode, pendingKey }"
}
```

**Response (2FA required):**
```json
{
  "success": false,
  "twoFaRequired": true,
  "phoneNumber": "+963...",
  "message": "Call POST /login/verify-2fa with { email, code }"
}
```

```bash
curl -X POST http://localhost:3009/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpass","label":"Main"}'
```

---

#### `POST /login/verify-otp`

Complete OTP verification after `/login` returns `otpRequired: true`.

**Request body:**
```json
{
  "email": "user@example.com",
  "otpCode": "123456",
  "pendingKey": "sk_xyz..."
}
```

**Response:**
```json
{
  "success": true,
  "apiKey": "sk_abc123...",
  "email": "user@example.com",
  "message": "OTP verified. Use apiKey in X-API-Key header."
}
```

```bash
curl -X POST http://localhost:3009/login/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","otpCode":"123456","pendingKey":"sk_xyz..."}'
```

---

#### `POST /login/verify-2fa`

Complete 2FA after `/login` returns `twoFaRequired: true`.

**Request body:**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**Response:**
```json
{ "success": true, "apiKey": "sk_abc123...", "email": "user@example.com" }
```

---

#### `POST /login/logout`

Revoke a session — calls ShamCash server logout and removes the key from DB.

**Headers:** `X-API-Key: sk_abc123...`

```bash
curl -X POST http://localhost:3009/login/logout \
  -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{ "success": true, "message": "Logged out and API key revoked." }
```

---

### QR Login (Device-to-Device)

#### `POST /session/createNew`

Generate a QR code. Scan it with the ShamCash mobile app. The server polls in the background until the app confirms login.

**Request body:** *(none required)*

**Response:**
```json
{
  "success": true,
  "qrImage": "data:image/png;base64,...",
  "sessionId": "encrypted-session-id#XXX",
  "checkUrl": "http://localhost:3009/session/.../check",
  "message": "Scan QR with ShamCash app. Poll the checkUrl until loggedIn: true and apiKey."
}
```

---

#### `GET /session/:sessionId/check`

Poll after `createNew`. Returns `apiKey` once the QR is scanned and confirmed.

**Response (waiting):**
```json
{ "success": true, "loggedIn": false, "message": "Waiting for scan. Backend is polling ShamCash." }
```

**Response (logged in):**
```json
{
  "success": true,
  "loggedIn": true,
  "apiKey": "sk_abc123...",
  "message": "Use this apiKey in header X-API-Key for /balance and /transactions"
}
```

---

#### `GET /session/:sessionId/status`

Returns metadata about a pending QR session (does not poll ShamCash).

---

### Session Management

#### `GET /sessions`

List all active API keys stored in DB.

```bash
curl http://localhost:3009/sessions
```

**Response:**
```json
{
  "success": true,
  "count": 2,
  "sessions": [
    {
      "apiKey": "sk_abc123...",
      "email": "user@example.com",
      "label": "Main Account",
      "sessionId": "session_1234567890...",
      "createdAt": 1710000000000,
      "createdAtHuman": "2024-03-10T00:00:00.000Z",
      "infoDevice": { "deviceName": "Pixel 7", "osName": "Android 14", "brand": "Google", "model": "Pixel 7" }
    }
  ]
}
```

---

#### `DELETE /sessions/:apiKey`

Revoke an API key from local DB (does **not** call ShamCash logout).

```bash
curl -X DELETE http://localhost:3009/sessions/sk_abc123...
```

**Response:**
```json
{ "success": true, "message": "Session revoked" }
```

---

### Account Endpoints

All endpoints below require `X-API-Key` header.

```
X-API-Key: sk_abc123...
```

---

#### `GET /account/balance`

Get account balances (SYP, EUR, USD).

```bash
curl http://localhost:3009/account/balance -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "balances": [
      { "currencyId": 1, "currencyCode": "SYP", "balance": 150000 },
      { "currencyId": 2, "currencyCode": "USD", "balance": 25.50 },
      { "currencyId": 3, "currencyCode": "EUR", "balance": 10.00 }
    ]
  }
}
```

---

#### `GET /account/profile`

Get user profile (name, email, phone, receive address, etc.).

```bash
curl http://localhost:3009/account/profile -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": 3401602,
      "name": "John Doe",
      "email": "john@example.com",
      "address": "2d2b49e3bc2b576e34907d3c52ec7ed4"
    }
  }
}
```

---

#### `GET /account/personal`

Get full personal account details including receive address.

```bash
curl http://localhost:3009/account/personal -H "X-API-Key: sk_abc123..."
```

---

#### `GET /account/settings`

Get account settings (currency limits, visibility options).

---

#### `GET /account/favorites`

Get saved favorite accounts.

---

#### `GET /account/exchange`

Get exchange/conversion services and rates (calls `bank.shamcash.sy`).

---

#### `GET /account/mtn-wallets`

Get linked MTN Cash wallets.

---

#### `GET /account/syriatel-wallets`

Get linked Syriatel Cash wallets.

---

### Receive QR Code

#### `GET /account/qr`

Get the user's receive QR code and their unique receive address.

```bash
curl http://localhost:3009/account/qr -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "address": "2d2b49e3bc2b576e34907d3c52ec7ed4",
  "qrImage": "data:image/png;base64,..."
}
```

> `address` is the unique hex code shown in the ShamCash Receive screen. Use it to receive payments or look up the account.

---

#### `GET /account/address/:code`

Resolve a receive address/code to account information.

```bash
curl http://localhost:3009/account/address/2d2b49e3bc2b576e34907d3c52ec7ed4 \
  -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "address": "2d2b49e3bc2b576e34907d3c52ec7ed4",
  "data": {
    "name": "John Doe",
    "accountId": 3401602
  }
}
```

---

### Transactions

#### `GET /account/transactions`

Full transaction history (`Transaction/history-logs`). Uses minimal payload `{ accessToken }` — the mobile API returns empty when pagination params are sent.

**Query params (filters only):**

| Param | Type | Description |
|-------|------|-------------|
| `fromDate` | string | Start date filter |
| `toDate` | string | End date filter |
| `currencyId` | number | Filter by currency (1=SYP, 2=USD, 3=EUR) |
| `type` | number | Transaction type filter |

*Note: `page`/`pageSize` cause empty results on the mobile API — omit them.*

```bash
curl "http://localhost:3009/account/transactions?page=1&pageSize=20" \
  -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalCount": 142,
    "items": [
      {
        "id": 9876,
        "type": 1,
        "amount": 5000,
        "currencyCode": "SYP",
        "date": "2024-03-10T12:00:00",
        "description": "Transfer from John"
      }
    ]
  }
}
```

Alias: `GET /account/transaction-history` (identical endpoint).

---

#### `GET /account/transactions-debug`

Try different payload formats to find which the mobile API accepts. Use when transactions return empty but the app shows data.

**Query params:**

| Param | Values | Description |
|-------|--------|-------------|
| `format` | `minimal` \| `web` \| `no-next` \| `page` \| `default` \| `all` | Payload format. `all` tries all formats. |
| `endpoint` | `history-logs` \| `logs` | Which endpoint to call. |

**Formats:** `minimal` = `{ accessToken }` only; `web` = limit:7, pageSize:1, next; `no-next` = limit/pageSize without next; `page` = page/pageSize; `default` = current implementation.

```bash
curl "http://localhost:3009/account/transactions-debug?format=all" -H "X-API-Key: sk_..."
```

#### `GET /account/transaction-logs`

Transaction log (`Transaction/logs`). Same filters as above. *Note: May return empty on mobile API — use `/account/transactions` if needed.*

```bash
curl "http://localhost:3009/account/transaction-logs?pageSize=10" \
  -H "X-API-Key: sk_abc123..."
```

---

#### `GET /account/transactions/:id`

Get a single transaction by ID.

```bash
curl http://localhost:3009/account/transactions/9876 \
  -H "X-API-Key: sk_abc123..."
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 9876,
    "type": 1,
    "amount": 5000,
    "currencyCode": "SYP",
    "senderName": "Jane Doe",
    "receiverName": "John Doe",
    "date": "2024-03-10T12:00:00",
    "note": "Payment"
  }
}
```

---

## Multi-Session Example

Log in with multiple accounts simultaneously — each gets its own `apiKey`:

```bash
# Login account A
curl -X POST http://localhost:3009/login \
  -H "Content-Type: application/json" \
  -d '{"email":"accountA@example.com","password":"passA","label":"Account A"}'
# → { "apiKey": "sk_aaa..." }

# Login account B
curl -X POST http://localhost:3009/login \
  -H "Content-Type: application/json" \
  -d '{"email":"accountB@example.com","password":"passB","label":"Account B"}'
# → { "apiKey": "sk_bbb..." }

# Use both simultaneously
curl http://localhost:3009/account/balance -H "X-API-Key: sk_aaa..."
curl http://localhost:3009/account/balance -H "X-API-Key: sk_bbb..."

# List all sessions
curl http://localhost:3009/sessions
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Short description",
  "detail": "Longer message from ShamCash",
  "data": { }
}
```

| HTTP Status | Meaning |
|-------------|---------|
| `400` | Missing required field |
| `401` | No/invalid X-API-Key |
| `404` | Resource not found |
| `502` | ShamCash upstream error |
| `500` | Internal server error |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `USE_MEMORY` | `false` | `true` = RAM only (no MySQL) |
| `MYSQL_HOST` | `localhost` | MySQL host |
| `MYSQL_USER` | `root` | MySQL user |
| `MYSQL_PASSWORD` | *(empty)* | MySQL password |
| `MYSQL_DATABASE` | `shamcash_api` | MySQL database |
| `SHAMCASH_AES_KEY` | *(required)* | 24-char AES-192 key from APK |
| `SHAMCASH_SERVER_PUBLIC_KEY` | *(required)* | RSA public key from APK |
| `SHAMCASH_API_BASE` | `https://api.shamcash.sy/v4/api` | Primary API URL |
| `SHAMCASH_API_BASE_02` | `https://api-02.shamcash.sy/v4/api` | Failover 1 |
| `SHAMCASH_API_BASE_03` | `https://api-03.shamcash.sy/v4/api` | Failover 2 |
| `SHAMCASH_BANK_API_BASE` | `https://bank.shamcash.sy/v4/api` | Bank/exchange API |
| `SHAMCASH_LOCALE` | `en` | `lang` header value |
| `DEVICE_NAME` | `Pixel 7` | Fake device name |
| `DEVICE_OS` | `Android 14` | Fake OS string |
| `DEVICE_BRAND` | `Google` | Fake device brand |
| `DEVICE_MODEL` | `Pixel 7` | Fake device model |
| `DEVICE_TOKEN` | *(auto)* | FCM token (auto-generated if blank) |
| `PENDING_SESSION_TTL_MS` | `900000` | QR session expiry (ms) |
| `API_KEY_TTL_MS` | `0` | API key expiry (0 = never) |
| `CLEANUP_INTERVAL_MS` | `300000` | Cleanup interval (ms) |
| `SHAMCASH_PLAIN_BODY` | `false` | `true` = skip encryption (debug 401s) |
| `SHAMCASH_DEBUG_LOG_BODY` | `false` | `true` = log plaintext payload before encryption (debug transactions) |

---

## Architecture Notes

- **Mobile API only** — uses `api.shamcash.sy` (not `api.shamcash.com` which is dead)
- **Bearer JWT** — `Authorization: Bearer <token>` header, no web cookies
- **AES-192-GCM** — all authenticated request bodies encrypted with fixed key from APK (`assets/aes_key.pem`)
- **Automatic failover** — on 5xx, retries `api-02.shamcash.sy` then `api-03.shamcash.sy`
- **Permanent sessions** — JWT tokens are long-lived; stored in DB, reused until ShamCash invalidates them
- **Unlimited sessions** — each `POST /login` creates an independent `apiKey`; all run simultaneously

### Transaction payload

The mobile API returns data with **minimal payload** `{ accessToken }` only. Sending `limit`, `pageSize`, or `next` causes empty results. Use `GET /account/transactions-debug?format=all` to test payload formats.
