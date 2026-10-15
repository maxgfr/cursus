# Setting up Dropbox

Cursus talks to Dropbox straight from the browser with OAuth 2 + PKCE. There is no client secret and no server:
only the app key is needed.

When the build ships its own app key (`DROPBOX_APP_KEY` in `src/app/oauthApps.ts`, a public identifier), the
Dropbox row in **Settings → Sync & backup** connects in one tap and none of this page is needed. While that key is
empty, each student connects with an app of their own, as below.

## 1. Create the Dropbox app

1. Open <https://www.dropbox.com/developers/apps> and choose **Create app**.
2. API: **Scoped access**. Access type: **App folder**. Name it, e.g. `Cursus` (the folder becomes `Apps/Cursus`).
3. In **Permissions**, enable `files.metadata.read`, `files.content.read` and `files.content.write`, then **Submit**.
4. In **Settings**, copy the **App key**. Ignore the app secret: Cursus never uses it.

## 2. Redirect URI

Under **Settings → OAuth 2 → Redirect URIs**, add the callback page of every place the app is served from. The
Dropbox form in Cursus shows the exact address for the page you are on, with a copy button. For example:

- `https://<user>.github.io/cursus/oauth-callback.html`
- `http://localhost:5173/cursus/oauth-callback.html` (development: the dev server serves the app under `/cursus/`)

The URI must match exactly, including the path.

Do not use **Webhooks**. A webhook URI is something Dropbox calls on its own (it first sends
`GET ?challenge=…` and expects the challenge echoed back); Cursus has no server to answer it, and putting the
callback page there makes the console report an error. Leave Webhooks empty.

## 3. Connect in Cursus

In **Settings → Sync & backup → Dropbox**, paste the app key and press **Connect**. Cursus first seals what you
typed, keeps the PKCE verifier and `state` in this device's vault, then leaves the page for Dropbox (a full-page
redirect, so it also works in an installed PWA where popups break). Dropbox asks for consent and sends you back to
`oauth-callback.html`, which stores the result and returns to Cursus; Cursus checks `state`, exchanges the code
(with `token_access_type=offline`, no client secret) for a refresh token, kept only in this device's vault and
refreshed without a secret, and drops the pending entry. A reload in between loses nothing.

## Notes

- Development apps work for up to 50 users without review; that is enough for personal use.
- Files live in `Apps/Cursus`. Removing that folder or revoking the app in your Dropbox account settings
  disconnects every device.
- Uploads above 150 MB use upload sessions; rate limits (HTTP 429) are retried after `Retry-After`.
