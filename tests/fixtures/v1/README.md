# Format v1 fixtures

Frozen envelopes in format v1. Tests in `src/core/log/codec.test.ts` decode them; nothing ever rewrites them.
If a test fails against these files, the codec broke backward compatibility: fix the codec, not the fixtures.

| File | Key | Content |
|---|---|---|
| `segment.bin` | `seg/fixturedev/0000000000-64ab7664d527cb46.seg` | header `{v:1, kind:'seg', deviceId:'fixturedev', seq:0, createdAt:1700000000000, blobRefs:['ab'×32]}`; Yjs V2 update (clientID 1) setting `courses['course-1']` to a map `{id:'course-1', title:'Fixture course', cover:'cursus-blob:' + 'ab'×32}` |
| `checkpoint.bin` | `ckpt/fixturedev/ebbbb1beb296bed1.ckpt` | header `{v:1, kind:'ckpt', deviceId:'fixturedev', seq:1, createdAt:1700000001000, blobRefs:['ab'×32], covers:[<segment key>]}`; full state of the same doc |

Layout: `"CRSY"` | version byte `1` | zlib(`u32be headerLen` | header JSON | Yjs update V2). The key's 16 hex chars are the start of sha256 over the whole file.
