# Setting up iCloud (CloudKit) sync

Cursus can sync to your private iCloud database through CloudKit Web Services (REST). This needs an
Apple Developer account. If you only use a Mac with Chrome or Edge, the simpler option is a folder inside
iCloud Drive (the "Folder" destination).

## 1. Create the container

1. Open [CloudKit Console](https://icloud.developer.apple.com/) and sign in with your developer account.
2. Create a container, for example `iCloud.io.github.<you>.cursus`. The identifier cannot be changed later.

## 2. Schema

In the **development** environment, under *Schema → Record Types*, create the record type
`CursusObject` with these fields:

| Field   | Type       | Purpose                                        |
| ------- | ---------- | ---------------------------------------------- |
| `key`   | String     | object key (`seg/…`, `ckpt/…`, `mirror/…`)     |
| `sha`   | String     | SHA-256 of the body, checked on every read     |
| `size`  | Int(64)    | body length in bytes                           |
| `data`  | Bytes      | body, when it is at most ~700 KB               |
| `asset` | Asset      | body, when it is larger (up to 50 MB)          |

Record names are derived from the key (`o-<sha256 of key>`), so writing a key twice replaces the same
record and never creates a duplicate.

## 3. Indexes

Under *Schema → Indexes*, add on `CursusObject`:

- `key`: **Queryable** and **Sortable** (listing uses `BEGINS_WITH` on `key`, sorted by `key`);
- `recordName`: **Queryable** (CloudKit requires it to query a record type).

## 4. API token and sign-in redirect

1. Under *Tokens & Keys → API Tokens*, create an API token.
2. Set **Sign-In Callback** to **URL Redirect** and enter the callback page of your deployment,
   for example `https://<you>.github.io/cursus/oauth-callback.html`.
3. Set **Allowed Origins** to the origin you serve Cursus from (for example `https://<you>.github.io`).
   Add `http://localhost:5173` too if you develop locally against the development environment.

The API token is not a secret: it identifies the app. The per-user `ckWebAuthToken` Apple returns after
sign-in stays on the device, in the Cursus secrets vault; it is never synced.

## 5. Deploy to production

Under *Schema*, choose **Deploy Schema Changes…** to copy the record type and indexes to the
**production** environment. Cursus uses production by default; a schema that exists only in
development makes every request fail.

## 6. Connect Cursus

In *Settings → Sync → Add destination → CloudKit*, enter the container identifier and the API token,
then choose **Sign in with Apple ID**. Cursus redirects to Apple and comes back through
`oauth-callback.html`.

If Apple later answers `AUTHENTICATION_REQUIRED` (signed out, token expired), the destination is shown
as paused with "Reconnect"; Cursus never redirects on its own in the middle of a review.

Validate the setup on an iPad (Safari and the installed app) before relying on it: Apple has archived
the CloudKit Web Services documentation and behaviour can differ between browsers.
