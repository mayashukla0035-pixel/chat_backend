# SkillParkho Chat backend

Node.js + Express + MongoDB + Socket.IO. Google Sheets is the access-control source of truth; MongoDB stores chat data.

## Run

```bash
cp .env.example .env
npm install
npm run seed   # demo student rahul@gmail.com + teacher ravi_linux sharing GRP002
npm run dev    # :4000
```

## REST

- `POST /api/auth/request-otp { email, teacherId? }` → `{ ok, code, expiresMin, resendAfter }` — real codes are emailed via Resend; without `RESEND_API_KEY` the code is logged/returned for dev. SkillParkho Support (`SUPPORT_EMAIL` + `SUPPORT_TEACHER_ID` in `.env`) skips OTP and gets `{ ok, directToken, user }` on this call.
- `POST /api/auth/verify-otp { email, code }` → `{ token, user }` (JWT; store on device for auto-login)
- `GET /api/auth/me` (Bearer token)
- `GET /api/conversations` — only authorized conversations for the caller (per-user isolation)
- `POST /api/conversations/direct { peerId }` — strict shared-batch-group check
- `GET /api/teachers/search?username=ravi_linux` — exact username, only if shared group + teacherChatAccess
- `GET /api/messages?conversation=group:GRP002` / `POST /api/messages` / react / vote / delete (24h rule)
- `POST /api/messages/read { conversation }` — read receipt (marks messages received+read, broadcasts `message:updated`)
- `GET /api/messages/:id/info` — WhatsApp-style receipts: BATCH group teachers/support see each group student's `received`/`read` + counts; on the SUPPORT group it returns the sender's full sheet profile; direct chats return peer counts
- `GET /api/users/:id` — full sheet profile. Support account (and supportAdmin) may view any Active user; teachers/students need a shared authorized batch group
- `GET /api/sync/status`, `POST /api/sync/run`

## Config (`.env`)

- `RESEND_API_KEY` + `RESEND_FROM_EMAIL` — real OTP emails (falls back to `FROM_EMAIL`, then `RESEND_FROM`)
- `OTP_EXPIRES_MINUTES` (default 5), `OTP_RESEND_SECONDS` (default 45), `OTP_DEV_RETURN_CODE`
- `SUPPORT_EMAIL` + `SUPPORT_TEACHER_ID` — `ensureSupportAccount()` keeps this teacher (role `teacher`, username `support`, Active + verified) in the DB, grants the `GRP_SUPPORT` teacher membership, and login for those credentials returns a token with **no OTP**

## Socket.IO

Connect with `{ auth: { token } }`, then:

```js
socket.emit('join', 'group:GRP002')
socket.emit('send', { conversation: 'group:GRP002', content: 'hello', _clientId: 'local-123' })
// receives: message:new, message:updated, message:deleted, typing
```

Server re-checks permissions on every join/send — UI hiding is never the only guard.

## Sheets sync

Tabs: `Students | Teachers | Groups | Student_Group_Access | Teacher_Group_Access`.
Set `GOOGLE_SHEET_ID` + `GOOGLE_API_KEY` (or service account), then `POST /api/sync/run`.
Idempotent; duplicate TRUE/FALSE → FALSE wins; failure keeps last good state.

## Media (images/videos/audio/files)

- `POST /api/uploads` accepts one file (default cap `MAX_UPLOAD_MB`, default 100). When
  `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` are set, the file is uploaded to Cloudinary
  (correct `resource_type`: image/video/audio→video/raw) into a PER-USER folder
  `skillparkho/<type>/<ownerId>/` and the response includes the URL + video/audio duration.
  Without the keys it falls back to `UPLOAD_DIR/<ownerId>/` on the local disk.
- Every upload is recorded in `models/Upload` against its owner. Sending a message with an
  attachment (`attachment.url`) is only allowed when that URL belongs to a record OWNED by
  the sender (`services/attachments.js`) — both on REST and on the realtime Socket.IO path.
  This is what guarantees media from one account can never appear in (or be quoted into)
  another account's chat. Message/conversation access itself is already per-user
  (`canReadConversation` / `canSendInConversation`).
