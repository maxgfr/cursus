/**
 * Cursus's own OAuth applications. These are public identifiers, not secrets: Dropbox and Microsoft both
 * use PKCE without a client secret for a browser app, so they are safe to commit. Empty means « not set up
 * yet »: the student then connects with an app of their own (docs/setup-dropbox.md, docs/setup-onedrive.md).
 */
export const DROPBOX_APP_KEY = ''
export const ONEDRIVE_CLIENT_ID = ''
