# Setting up Microsoft OneDrive

Cursus talks to OneDrive straight from the browser through Microsoft Graph, with OAuth 2 + PKCE on the Microsoft
identity platform. The app is registered as a single-page application: there is no client secret and no server,
only the Application (client) ID is needed. Cursus reads and writes only its app folder (`Apps/Cursus`).

When the build ships its own client ID (`ONEDRIVE_CLIENT_ID` in `src/app/oauthApps.ts`, a public identifier), the
OneDrive row in **Settings → Sync & backup** connects in one tap and none of this page is needed. While that ID is
empty, each student connects with a registration of their own, as below.

## 1. Register the application

1. Open the Azure portal at <https://portal.azure.com> and go to **Microsoft Entra ID → App registrations**
   (also reachable as **App registrations** in the search bar). A free personal Microsoft account works.
2. Choose **New registration**. Name it, e.g. `Cursus`.
3. **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts*
   (Cursus signs in through the `common` authority, so both work).
4. **Redirect URI**: platform **Single-page application (SPA)**, and the callback page of the place the app is
   served from (see step 2). Choose **Register**.

## 2. Redirect URIs

Under **Authentication → Single-page application → Redirect URIs**, add the callback page of every place the app
is served from. The OneDrive form in Cursus shows the exact address for the page you are on, with a copy button.
For example:

- `https://<user>.github.io/cursus/oauth-callback.html`
- `http://localhost:5173/cursus/oauth-callback.html` (development)

The platform must be **Single-page application**, not *Web*: a *Web* redirect URI makes Microsoft require a client
secret, which a static app cannot keep. Do not enable the implicit grant: Cursus uses the authorization code flow
with PKCE.

## 3. API permissions

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add
`Files.ReadWrite.AppFolder` (and keep `offline_access`, which Cursus also asks for, so it can keep syncing without
asking again). No admin consent is needed for a personal account.

## 4. Copy the client ID

On the registration's **Overview**, copy the **Application (client) ID**. Do not create a client secret under
*Certificates & secrets*: Cursus never uses one.

## 5. Connect in Cursus

In **Settings → Sync & backup → Microsoft OneDrive**, paste the Application (client) ID and press **Connect**.
Cursus seals what you typed, keeps the PKCE verifier and `state` in this device's vault, then leaves the page for
Microsoft (a full-page redirect, which also works in an installed PWA). After consent, Microsoft sends you back to
`oauth-callback.html`, which stores the result and returns to Cursus; Cursus checks `state`, exchanges the code for
an access token and a refresh token, kept only in this device's vault, and drops the pending entry.

## Notes

- Files live in `Apps/Cursus` of your OneDrive (the app folder). Revoking the app at
  <https://account.live.com/consent/Manage> (or, for a work account, in *My Apps*) disconnects every device.
- Microsoft rotates the refresh token on every refresh and, for single-page applications, limits its lifetime to
  24 hours. When it has expired, the OneDrive backup shows *Sign in again to keep syncing*; **Reconnect** in its
  sheet goes through the consent page once more. Nothing waiting on the device is lost meanwhile.
- Uploads above 4 MB use upload sessions; rate limits (HTTP 429) and service errors are retried after
  `Retry-After`.
