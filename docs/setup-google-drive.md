# Setting up Google Drive

Cursus syncs to a visible `Cursus` folder in your Google Drive, using your own Google OAuth client. The client ID
and secret are entered on each device (or passed along when pairing a device). They stay in that device's vault
and are never synced or published.

## 1. Create the OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (any name).
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External**, app name "Cursus", your e-mail as support and developer contact.
   - Scopes: add `https://www.googleapis.com/auth/drive.file` only. It is a non-sensitive scope, so Google does
     not need to verify the app.
   - **Publish the app** (status "In production"). In "Testing" status, refresh tokens expire after 7 days and
     sync stops every week.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - Authorized JavaScript origin: the origin Cursus runs on, e.g. `https://<you>.github.io`.
   - Authorized redirect URI: `https://<you>.github.io/cursus/oauth-callback.html` (exactly, with the
     `/cursus/` base path). Add `http://localhost:5173/cursus/oauth-callback.html` for local development.
5. Copy the **client ID** and **client secret**.

Google requires the secret for a Web client even with PKCE. It is not a server secret here: it only lets
someone holding it ask *you* for consent under your app's name, so keep it to your own devices.

## 2. Connect a device

1. In Cursus: **Settings → Sync → Add destination → Google Drive**.
2. Paste the client ID and secret (or receive them through device pairing).
3. Tap **Connect**. Cursus saves your work, then goes to Google (a full-page redirect, not a popup: popups break
   in installed apps on iOS). Approve access.
4. Google sends you back to `oauth-callback.html`, which hands the result to the app. Cursus exchanges the code
   for a refresh token, kept in this device's vault. Sync then runs on its own.

## What Cursus does in your Drive

- It only sees files it created (`drive.file` scope), never the rest of your Drive.
- It creates one folder named `Cursus` at the root of "My Drive", tagged as a Cursus root. If two devices created
  one at the same time, both are read and new files go to one of them; you can leave both.
- Do not rename, move or edit files inside it. Deleting the folder deletes your synced data.

## When Drive pauses

If Google revokes access (password change, access removed in your Google account, client secret rotated), sync
shows **"Drive paused — reconnect"**. Cursus never redirects you by itself in the middle of a review: tap
**Reconnect** when convenient. Nothing is lost meanwhile; changes stay on the device until the next sync.

Rate limits (`429`, `userRateLimitExceeded`) only delay sync; a full Drive (`storageQuotaExceeded`) is reported
in the sync status.
