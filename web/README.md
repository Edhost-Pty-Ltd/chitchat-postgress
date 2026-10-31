# ChitChat Business — Browser Meeting Page (`/meet/:id`)

`meet.html` is a self-contained (no build step) browser meeting room for
`https://chitchatbusiness.com/meet/<meetingId>`. A participant opens the link,
enters a name, grants camera/mic, and joins the same live meeting as the mobile
app via the existing Socket.IO signaling backend. Small meetings use a WebRTC
**mesh** (every peer connects to every other peer) — no media server needed.

## How it fits the existing system

- Meetings are created by the **mobile app** → `POST /meetings` (unchanged).
- The mobile app shares `https://chitchatbusiness.com/meet/<meetingId>`.
- The **website** serves `meet.html` for the `/meet/:meetingId` route.
- The page talks to the **existing backend**:
  - `GET  /meet/:id/info`  — public: does the meeting exist / is it joinable (no secrets).
  - `POST /meet/:id/guest` — public: issues a short-lived guest token scoped to this one meeting.
  - Socket.IO with `auth: { guestToken }` → `meeting:join`, `meeting:peer-joined`,
    `meeting:signal` (targeted offer/answer/ICE), `meeting:peer-left`, `meeting:ended`.

Guests never get a Firebase account or a `meeting_participants` row, and the
guest token can only act on the meeting it was issued for.

## Deploy

1. Put `meet.html` on the website so **both** of these serve its contents:
   - `GET /meet/:meetingId`  (direct navigation / refresh must work — SPA-style rewrite)
   - the page's own assets

   Examples:
   - **Nginx**: `location ~ ^/meet/ { try_files /meet.html =404; }`
   - **Netlify** `_redirects`: `/meet/*   /meet.html   200`
   - **Vercel** `vercel.json`: `{ "rewrites": [{ "source": "/meet/(.*)", "destination": "/meet.html" }] }`
   - **Cloudflare Pages**: add `/meet/*  /meet.html  200` to `_redirects`.

2. Point the page at the API. By default it uses the page's own origin. If the
   API is on a different origin, set a global before the script runs, e.g. in the
   page `<head>`:
   ```html
   <script>window.CHITCHAT_API_BASE = 'https://api.chitchatbusiness.com';</script>
   ```
   and add that origin to the backend `CORS_ORIGINS`.

3. **HTTPS is required** — browsers only grant camera/mic on secure origins, and
   `wss://` is required for the socket in production. Serve the site over HTTPS;
   Socket.IO upgrades to `wss://` automatically on an `https://` page.

## Backend configuration

- `MEET_GUEST_SECRET` — set a strong random value in production (used to sign
  guest tokens). A dev-only default exists so local testing works out of the box.
- `CORS_ORIGINS` — include the website origin (and the API origin if separate).
- `MEET_URL_BASE` — already defaults to `https://chitchatbusiness.com`; this is
  what the mobile app embeds in the shared link.

## TURN (for reliable connectivity)

Mesh works peer-to-peer. STUN (Google public) is configured by default, which
covers most networks. For users behind strict/symmetric NATs you need a TURN
server. Add it to `ICE_SERVERS` in `meet.html`:
```js
{ urls: 'turn:your.turn.host:3478', username: 'user', credential: 'pass' }
```
A free self-hosted option is **coturn**. Managed options: Twilio NTS, Metered,
Cloudflare TURN.

## Scaling note (mesh vs SFU)

A mesh is ideal for small meetings (roughly up to 4–5 participants): each client
sends its stream to every other client. Beyond that, uplink bandwidth and CPU
grow quickly. For larger meetings, introduce an **SFU** (e.g. mediasoup,
LiveKit, Janus): clients send one stream up to the SFU, which forwards to
everyone. The signaling events (`meeting:join` / `meeting:signal`) and the guest
token layer stay the same — only the media path changes. This was a deliberate
choice to avoid adding infrastructure for the common small-meeting case.
