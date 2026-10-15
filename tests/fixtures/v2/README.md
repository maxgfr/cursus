# Format v2 fixtures

Frozen envelopes in format v2. Tests in `src/core/log/codec.test.ts` decode them; nothing ever rewrites them.
If a test fails against these files, the codec broke backward compatibility: fix the codec, not the fixtures.

Version 2 has the layout of version 1 (see `../v1/README.md`) with version byte `2`. The header is unchanged
(`v: 1`). The byte says the update may hold roots a version-1 reader would silently ignore although they carry
data it relies on (the compact review log `reviewLog`, sessions, plans, drafts): a version-1 reader keeps the
object as `needs-upgrade` instead (proved against `../v1-reader/codec.ts`, the last version-1 codec).

| File | Key | Content |
|---|---|---|
| `segment.bin` | `seg/fixturedev/0000000000-cf7595873c8df2e1.seg` | header `{v:1, kind:'seg', deviceId:'fixturedev', seq:0, createdAt:1700000000000, blobRefs:['ab'×32]}`; Yjs V2 update (clientID 1) setting `courses['course-1']` to a map `{id:'course-1', title:'Fixture course', cover:'cursus-blob:' + 'ab'×32}` and appending `[1,"review-1","card-1",3,1700000000000,4000,"fixturedev"]` to the array `reviewLog` |
| `checkpoint.bin` | `ckpt/fixturedev/935eb772d0667f61.ckpt` | header `{v:1, kind:'ckpt', deviceId:'fixturedev', seq:0, createdAt:1700000001000, blobRefs:['ab'×32], covers:[<segment key>]}`; full state of the same doc |
