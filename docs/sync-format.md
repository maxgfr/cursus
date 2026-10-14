# Sync format, version 1

This is the on-storage format Cursus writes to every destination (S3-compatible bucket, Google Drive,
Dropbox, CloudKit, a local or iCloud Drive folder, a backup archive). It is described from the code in
`src/core/log/codec.ts`, `src/core/log/blobs.ts`, `src/core/sync/**` and `src/core/crypto/**`.

**Stability rule.** Version 1 never changes. Any change to a byte layout, key name, header field or
envelope below requires a new format version (a new `fmt/vN` marker, a new version byte) and new frozen
fixtures next to `tests/fixtures/v1`. The v1 fixtures (`segment.bin`, `checkpoint.bin`) are never
rewritten; if the codec stops decoding them, the codec is wrong.

## Invariant

No remote object is ever rewritten or deleted. The state of a library is the commutative, idempotent
merge of every object present. There are two exceptions:

- `mirror/**`, the human-readable export, which is derived and rewritable;
- removing an old plaintext root after it was sealed, only on an explicit user action and only once a
  complete, verified sealed copy exists.

## Keys

Keys are relative to the destination root (bucket prefix, Drive root folder, Dropbox app subfolder,
CloudKit record field `key`). Parsing is strict: a name that does not match one of these patterns exactly
(for example `x 2.seg` left by a sync client, uppercase hex, extra directories) is ignored.

| Key | Pattern | Content |
|---|---|---|
| `fmt/v1` | literal | the 9 bytes `cursus/1\n` (UTF-8, newline included) |
| `ws/<workspaceId>` | `workspaceId` = `[A-Za-z0-9_-]{1,64}` | workspace marker, empty body |
| `keys/<sha256>.json` | 64 lowercase hex | key envelope (sealed destinations only), name = sha256 of the body |
| `seg/<deviceId>/<seq10>-<h16>.seg` | `deviceId` = `[A-Za-z0-9_-]{1,64}`, `seq10` = 10 digits, `h16` = 16 lowercase hex | segment envelope |
| `ckpt/<deviceId>/<h16>.ckpt` | as above | checkpoint envelope |
| `blob/<h2>/<h64>` | `h64` = 64 lowercase hex, `h2` = its first 2 characters | file chunk, `h64` = sha256 of the chunk |
| `bman/<h64>` | 64 lowercase hex | file manifest, `h64` = sha256 of the manifest bytes (the blob id) |
| `inbox/*.cursus` | folder destinations only | archives dropped by another device, absorbed by content hash, never deleted |
| `mirror/**` | free-form | readable Markdown export; rewritten in place, stale files left and reported, never read back as sync data |

Every key except `mirror/**` is immutable and content-addressed (`ws/` and `fmt/v1` have fixed
content). Providers that allow several files with the same name (Google Drive) may list duplicates;
readers try each copy until one verifies.

## Segment and checkpoint envelope

```
offset 0   4 bytes  magic "CRSY" (0x43 0x52 0x53 0x59)
offset 4   1 byte   format version, 0x01
offset 5   ...      zlib stream (RFC 1950) of:
                      u32 big-endian  headerLen
                      headerLen bytes header JSON (UTF-8)
                      rest            Yjs update, encoding V2
```

- `h16` in the key is the first 16 hex characters of sha256 over the **whole stored plaintext file**
  (magic included).
- Writers compress with zlib level 6 (`fflate.zlibSync`); readers accept any valid zlib stream.
- Header JSON is written with this exact field order, no whitespace:
  `{"v":1,"kind":"seg"|"ckpt","deviceId":…,"seq":…,"createdAt":…,"blobRefs":[…],"covers":[…]}`.
  `covers` is present only on checkpoints.
  - `deviceId`: the writing device, equal to the one in the key.
  - `seq`: per-device sequence number, `0 <= seq < 10^10`, equal to the key's `seq10`. Checkpoint keys
    carry no sequence number; writers set `seq` to `0` there and readers do not check it.
  - `createdAt`: epoch milliseconds, informative only.
  - `blobRefs`: sorted, de-duplicated blob ids (manifest `h64`) referenced by the update. They are found by
    decoding the update (`Y.decodeUpdateV2`) and collecting every `cursus-blob:<h64>` occurrence in string,
    any, embed, format and JSON contents.
  - `covers` (checkpoints): sorted list of the segment keys whose updates the checkpoint contains.
- Decoding checks, in order: the key parses; sha256 matches `h16` (error `hash`); the magic (error
  `magic`); the version byte (error `version`); the zlib stream and header shape (error `version`); the
  header agrees with the key on `kind`, `deviceId` and, for segments, `seq` (error `hash`).
- Stored bytes are never re-encoded: a verified object is kept and uploaded byte for byte.

A hash mismatch is treated as transient (another duplicate or another destination may hold a good copy);
an object that is undecodable or too new is kept with state `needs-upgrade` and re-applied after an update
of the app.

### Checkpoints

A checkpoint is built in a fresh `Y.Doc` from persisted segments only (never from the live document), in
arrival order, stopping before the first `needs-upgrade` segment. Its update is the full state
(`Y.encodeStateAsUpdateV2`) and `covers` lists exactly the segments applied. A new device downloads
checkpoints first, then only the segments not covered by them.

## Files (blobs)

A file is split into chunks of 4 MiB (4 194 304 bytes; the last one shorter; an empty file has no
chunk). Each chunk is stored at `blob/<h2>/<h64>` with `h64` = sha256 of the chunk. The manifest is the
UTF-8 JSON, in this exact field order:

```json
{"v":1,"mime":"image/png","size":123456,"chunks":["<h64>","<h64>"]}
```

Its sha256 is the blob id, stored at `bman/<id>`. Documents refer to a file with the string
`cursus-blob:<id>`. Readers reject a manifest that is not `v: 1` with a string `mime`, a number `size` and
an array of 64-hex `chunks`.

## Sealed (encrypted) destinations

A destination is sealed when it holds at least one `keys/*.json`. On a sealed destination every object is
sealed except `fmt/v1` and `keys/*.json`, which stay in clear. The `ws/` marker is sealed too (an empty,
clear `ws/` marker proves a plaintext root).

### Sealed object

```
"CRSE" (0x43 0x52 0x53 0x45)
u8        keyId length n (1..255)
n bytes   keyId (UTF-8)
12 bytes  AES-GCM IV (random)
rest      AES-256-GCM ciphertext of the plaintext object, 16-byte tag appended
```

- AAD: the UTF-8 string `cursus/1|` followed by the object's relative key, for example
  `cursus/1|seg/dev/0000000003-0123456789abcdef.seg`. An object moved to another key does not authenticate.
- Content addresses (`h16`, `h64`) are always computed over the **plaintext**; a reader opens, then verifies.
- New uploads use the smallest unlocked `keyId`, so devices converge on one key.

### Key envelope (`keys/<sha256>.json`)

The data key (DEK, 32 random bytes, AES-256-GCM) is wrapped by a key-encryption key (KEK) derived from
the passphrase. The file body is `JSON.stringify` of:

```json
{
  "v": 1,
  "keyId": "<16 lowercase hex, 8 random bytes>",
  "kdf": { "alg": "PBKDF2-SHA256", "iterations": 600000, "salt": "<base64, 16 bytes>" },
  "wrap": { "alg": "AES-GCM", "iv": "<base64, 12 bytes>", "data": "<base64, wrapped raw DEK + tag>" }
}
```

- KEK: PBKDF2 with HMAC-SHA-256 over the NFC-normalised passphrase, `iterations` from the file (600 000 when
  written by the app; tests use 1 000), output AES-256-GCM, usable only for wrap/unwrap.
- Wrap: AES-GCM `wrapKey('raw')` with AAD `cursus/1|key|<keyId>`.
- The file name is `keys/` + sha256 (hex) of the exact body bytes + `.json`; a file whose name does not
  match its body is ignored.
- Key files form a union: changing the passphrase adds a new file for the same `keyId`; old files stay.
- Base64 is standard (RFC 4648, with padding).

### Sealing an existing destination

Sealing writes to a **new** prefix (a new destination identity): first the key file, confirmed by a
listing, then `fmt/v1`, then a sealed copy of every object (chunks, manifests, then segments and
checkpoints, each only after what it needs), then every copy is read back and verified. The old
plaintext root is left untouched until the user removes it explicitly.

## Upload order and confirmation

Per destination, a sync round lists, downloads what is missing, uploads what is missing, then confirms.

- Upload order: on a sealed destination, key envelopes first (confirmed), then `fmt/v1` (confirmed);
  then `ws/<workspaceId>`; then chunks; then a manifest only once all its chunks are confirmed there; then a
  segment or checkpoint only once every manifest it references, and their chunks, are confirmed there.
  Missing files are fetched from another destination first. Without an unlocked key nothing is uploaded
  to a sealed destination.
- A key is **confirmed** on a destination only once it has been seen in a listing or read back. After a
  PUT it is `awaiting`; if still unconfirmed after 10 minutes it is sent again (PUT is idempotent per key).
- A full listing (at start-up, every 30 minutes, and on "Verify") is the truth: a key confirmed earlier but
  absent from a full listing becomes unconfirmed again. Incremental listings use the provider's mechanism
  (S3 `start-after`, Drive `createdTime` after the last listing minus 15 minutes, Dropbox cursors, CloudKit
  `BEGINS_WITH`); `keys/` and `ws/` are always listed.
- A library is shown as protected only when every local key is confirmed on at least one destination. A
  red banner appears when some local key has been confirmed nowhere for 24 hours.

## Identity and guards

- A destination's identity is a hash of (type, endpoint, bucket or folder, prefix). Changing any of them
  creates a new destination.
- A `ws/` marker that differs from a non-empty local library asks for confirmation before merging (a CRDT
  merge cannot be undone).
- An unknown object under the device's own `deviceId` means the device was cloned: it takes a new
  `deviceId`.
