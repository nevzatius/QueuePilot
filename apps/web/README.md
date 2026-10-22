# @queuepilot/web

React dashboard (Vite). It is a static build that talks to the API over HTTPS on **another origin**
(ADR-019: Firebase Hosting for the web, Render free for the API).

## Environment variables (build time)

Copy `.env.example` to `.env.local`. Vite inlines these at build time, so changing one needs a rebuild.

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | API base URL. Production: absolute `https://` URL, no credentials, query or fragment. Trailing slashes are stripped. Development: empty uses the Vite dev proxy. |
| `VITE_DEV_API_PROXY` | Dev server target for `/api` when `VITE_API_BASE_URL` is empty (default `http://localhost:8080`). |
| `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_APP_ID` | Firebase web config (public identifiers). |
| `VITE_FIREBASE_AUTH_EMULATOR_URL` | Optional Auth emulator. |
| `VITE_USE_MOCK_API` | Development only: in-memory API and fake sign-in. Ignored in production builds. |

A production build with a missing, malformed or `http://` `VITE_API_BASE_URL` still builds (CI builds without it)
but the app renders a configuration error instead of starting. Nothing is ever sent to a wrong or insecure origin.

## CORS: what the API side must allow

Every call sends `Authorization: Bearer <Firebase ID token>` with `credentials: 'omit'`; writes also send
`Idempotency-Key`. So the API must list the web origin(s) in `QP_CORS_ORIGINS` (exact `https://` origins, no
wildcard), for example both `https://<project>.web.app` and `https://<project>.firebaseapp.com` if both are used.
The API exposes `Retry-After`, `Idempotent-Replayed`, `X-Correlation-Id` and `Location`; the client reads only
`Idempotent-Replayed`.

## Free-tier cold start

A sleeping Render service takes 8-14 s to answer (measured once) and up to about 50 s per Render docs. The client
(`src/api/coldStart.ts` holds the constants):

- shows a non-blocking "The service is waking up" notice when a call has no answer for 4 s, or fails in a
  platform way (network error or 502/503/504 without a QueuePilot Problem Details body);
- retries those failures with backoff (2 s, 4 s, 8 s, then 10 s) until 90 s have passed since the call began, then shows
  the normal error with its manual "Try again" button;
- retries only reads, and writes that carry an `Idempotency-Key` (the same key every time). Answers with a Problem
  Details body and every 4xx are final and never retried.

Polling runs every 30 s (ADR-019, Firestore read budget) and skips fetches while the tab is hidden.
