# Sync with a GitHub repository

Cursus can sync to a GitHub repository with a fine-grained personal access token. The app talks to the GitHub REST
API (`https://api.github.com`) directly from your browser; there is no server and no OAuth app to create.

## 1. Create a private repository

1. Open <https://github.com/new>.
2. Pick a name (for example `cursus-backup`) and choose **Private**.
3. Creating it empty is fine: Cursus makes the first commit itself. A repository with a README or other files works
   too; Cursus only writes inside its own folder.

## 2. Create a fine-grained token

1. Open **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
   (<https://github.com/settings/personal-access-tokens/new>).
2. **Resource owner**: the account or organisation that owns the repository.
3. **Expiration**: as long as you are comfortable with. When the token expires, sync stops with an authentication
   error until you paste a new one.
4. **Repository access → Only select repositories**, and pick only the backup repository.
5. **Permissions → Repository permissions → Contents: Read and write**. GitHub adds **Metadata: Read-only** by
   itself; nothing else is needed.
6. Generate the token and copy it (`github_pat_…`). GitHub shows it only once.

An organisation may require an administrator to approve fine-grained tokens before they work.

## 3. Connect in Cursus

In **Settings → Sync & backup → GitHub repository**, enter:

- **Repository**: `owner/name` (for example `maxgfr/cursus-backup`), or the repository's address.
- **Token**: the token from step 2. It stays on the device and is never synchronised.
- Under **Advanced**, optionally:
  - **Branch**: empty means the repository's default branch. A branch that does not exist yet is created from the
    default branch on the first sync.
  - **Folder**: the folder of the repository that holds the backup; `cursus` when empty.

Press **Test connection**, then **Add**. Changing the repository, branch or folder makes a new destination; a new
token for the same one is entered from the destination's sheet (**Update keys**).

## How the data is stored

- Every object is a file under the folder, at its key (for example `cursus/seg/…`). Objects are stored as base64
  text, because the Git API used for batched writes only accepts text, so they take about a third more space than
  on other destinations.
- Writes are grouped: the objects a sync round sends are written as a few commits (one per stage of the round),
  each made of one tree, one commit and one branch update, never one commit per object. The commit messages read
  `Cursus backup: N objects`.
- When the repository is empty, the first commit adds `README.md` to the folder, saying the folder holds a Cursus
  backup and must not be edited.
- Cursus never deletes files and never force-pushes. Objects are never rewritten, except the readable `mirror/`
  export. If another device pushed in the meantime, Cursus rebuilds its commit on top of that one.
- Do not edit, move or delete files in the folder. The rest of the repository is left alone.

## Limits

- GitHub recommends keeping a repository under 1 GB, and strongly under 5 GB. Large attachments grow the
  repository quickly; history is kept, so the size only grows.
- GitHub refuses files over 100 MB. Cursus objects are at most about 5.6 MB once base64-encoded.
- The API allows 5,000 requests per hour per token, and secondary limits on writes (about 80 content-creating
  requests per minute and 500 per hour). Batching keeps a sync round to a few writes. When GitHub asks to wait,
  Cursus waits for the time it gives before trying again.

## Security

- Turn on sealing (encryption with a passphrase) for this destination, even on a private repository: repository
  contents are readable by every collaborator, by anyone the repository is later shared with, and in any fork or
  clone.
- The token stays on this device, in its vault. It is never synchronised: enter it again on each device, or give each
  device its own token.
- A token limited to one repository with **Contents** only cannot reach your other repositories or account
  settings. Revoke it from the same settings page if a device is lost.

## Test connection: what the results mean

| Result | Cause | Fix |
|---|---|---|
| Token | GitHub does not accept the token (mistyped, expired or revoked). | Copy the token again, or generate a new one. |
| Not found | No GitHub account or organisation with that owner name. | Check the owner name. |
| No access | The repository does not exist, or the token does not include it. GitHub answers the same for both. | Check the repository name; add the repository to the token's repository access. |
| Read only | You cannot push to the repository, or it is archived. | Use a repository you can write to, or unarchive it. |
| Rate limited | GitHub asks to wait before the next request. | Try again after the time shown. |
| Network | GitHub cannot be reached. | Check your connection. |

The test reads only the repository settings: a token with **Contents: Read-only** passes it, and the first sync then
fails with a permission error. Give the token **Contents: Read and write**.
