"""Our `.apkg` export, imported by the official Anki engine: cards, fields, decks, media and history must match."""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from anki.collection import Collection, ImportAnkiPackageOptions, ImportAnkiPackageRequest

ROOT = Path(__file__).resolve().parents[2]
DAY = 86_400_000

# Builds a small workspace with the real core modules and writes OUR export to argv[1].
EXPORTER = """
import * as Y from 'yjs'
const core = (p) => import(`${process.cwd()}/src/core/${p}`)
const { blobStore } = await core('log/blobs.ts')
const { createWorkspace } = await core('model/workspace.ts')
const { virtualClock } = await core('ports/clock.ts')
const { seededRng } = await core('ports/rng.ts')
const { memoryStore } = await core('storage/memoryStore.ts')
const { createScheduler } = await core('srs/fsrs.ts')
const { exportApkg } = await core('anki/apkgWrite.ts')
const T0 = 1_750_000_000_000, DAY = 86_400_000
const clock = virtualClock(T0)
const ws = createWorkspace(new Y.Doc(), { rng: seededRng(1, clock), clock, deviceId: 'dev' })
const blobs = blobStore(memoryStore())
const png = await blobs.put(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), 'image/png')
const mp3 = await blobs.put(new Uint8Array([73, 68, 51, 9]), 'audio/mpeg')
const course = ws.courses.create({ title: 'Physics' })
const other = ws.courses.create({ title: 'Maths' })
const basic = ws.cards.create({ courseId: course, kind: 'basic', tags: ['phys'] })
ws.text({ id: basic, field: 'front' }).insert(0, `**Energy** $E = mc^2$\\n\\n![](cursus-blob:${png})`)
ws.text({ id: basic, field: 'back' }).insert(0, 'Einstein')
const cloze = ws.cards.create({ courseId: other, kind: 'cloze' })
ws.text({ id: cloze, field: 'front' }).insert(0, `Pi is {{c1::3.14}} <audio controls src="cursus-blob:${mp3}"></audio>`)
ws.text({ id: cloze, field: 'back' }).insert(0, 'circle')
// Nested subsets of Maths: Algebra (1 card) > Groups (2 cards), plus an empty Geometry.
const algebra = ws.sections.create({ courseId: other, name: 'Algebra' })
const groups = ws.sections.create({ courseId: other, parentId: algebra, name: 'Groups' })
ws.sections.create({ courseId: other, name: 'Geometry' })
for (const [front, sectionId] of [['Ring', algebra], ['Group', groups], ['Abelian', groups]]) {
  const id = ws.cards.create({ courseId: other, kind: 'basic', sectionId })
  ws.text({ id, field: 'front' }).insert(0, front)
  ws.text({ id, field: 'back' }).insert(0, `${front} def`)
}
ws.reviews.record({ cardId: basic, rating: 3, at: T0, ms: 5_000 })
ws.reviews.record({ cardId: basic, rating: 3, at: T0 + 600_000, ms: 4_000 })
ws.reviews.record({ cardId: basic, rating: 4, at: T0 + DAY, ms: 2_000 })
const now = T0 + 2 * DAY
await Bun.write(process.argv[1], await exportApkg(ws, blobs, { now }))
const state = createScheduler().replay(basic, ws.reviews.forCard(basic))
console.log(JSON.stringify({ due: state.due, stability: state.stability }))
"""


def fail(msg: str) -> int:
    print(f"check-export: {msg}", file=sys.stderr)
    return 1


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        apkg = Path(tmp) / "cursus.apkg"
        proc = subprocess.run(
            ["bun", "-e", EXPORTER, str(apkg)], cwd=ROOT, capture_output=True, text=True, check=False
        )
        if proc.returncode != 0:
            return fail(f"exporter failed:\n{proc.stdout}\n{proc.stderr}")
        expected = json.loads(proc.stdout.strip().splitlines()[-1])

        col = Collection(str(Path(tmp) / "target.anki2"))
        try:
            req = ImportAnkiPackageRequest(
                package_path=str(apkg),
                options=ImportAnkiPackageOptions(with_scheduling=True, with_deck_configs=False),
            )
            col.import_anki_package(req)

            decks = sorted(d.name for d in col.decks.all_names_and_ids())
            # Anki imports only the decks that hold cards (and their parents): empty Geometry stays behind.
            want = [
                "Cursus",
                "Cursus::Maths",
                "Cursus::Maths::Algebra",
                "Cursus::Maths::Algebra::Groups",
                "Cursus::Physics",
                "Default",
            ]
            if decks != want:
                return fail(f"decks {decks}")
            # The deck tree: every subset deck sits under its parent's deck.
            for name in want[1:-1]:
                parent = col.decks.parents(col.decks.id_for_name(name))
                if [p["name"] for p in parent] != ["::".join(name.split("::")[:i]) for i in range(1, name.count("::") + 1)]:
                    return fail(f"parents of {name}: {[p['name'] for p in parent]}")
            if col.card_count() != 5 or col.note_count() != 5:
                return fail(f"{col.card_count()} cards, {col.note_count()} notes")
            per_deck = {}
            for did in col.db.list("select did from cards"):
                per_deck[col.decks.name(did)] = per_deck.get(col.decks.name(did), 0) + 1
            if per_deck != {
                "Cursus::Physics": 1,
                "Cursus::Maths": 1,
                "Cursus::Maths::Algebra": 1,
                "Cursus::Maths::Algebra::Groups": 2,
            }:
                return fail(f"cards per deck {per_deck}")
            for front, deck in (("Ring", "Algebra"), ("Group", "Algebra::Groups"), ("Abelian", "Algebra::Groups")):
                nids = col.find_notes(f'"deck:Cursus::Maths::{deck}" -"deck:Cursus::Maths::{deck}::*" "Front:{front}"')
                if len(nids) != 1 or col.get_note(nids[0])["Back"] != f"{front} def":
                    return fail(f"{front} not found with its fields in {deck}")

            basic_nid = col.find_notes('"note:Cursus Basic" "deck:Cursus::Physics"')
            cloze_nid = col.find_notes('"note:Cursus Cloze"')
            if len(basic_nid) != 1 or len(cloze_nid) != 1:
                return fail("notetypes Cursus Basic / Cursus Cloze not found")
            basic = col.get_note(basic_nid[0])
            cloze = col.get_note(cloze_nid[0])
            front = basic["Front"]
            if not front.startswith("<p><strong>Energy</strong> \\(E = mc^2\\)</p>") or "<img src=" not in front:
                return fail(f"basic front {front!r}")
            if basic["Back"] != "Einstein" or basic.tags != ["phys"]:
                return fail(f"basic back/tags {basic['Back']!r} {basic.tags}")
            if not cloze["Text"].startswith("Pi is {{c1::3.14}} [sound:") or cloze["Back Extra"] != "circle":
                return fail(f"cloze fields {cloze['Text']!r} {cloze['Back Extra']!r}")
            for card in col.get_note(cloze.id).cards():
                if col.decks.name(card.did) != "Cursus::Maths":
                    return fail("cloze card in wrong deck")
                q = card.question()
                if "[...]" not in q:
                    return fail(f"cloze question {q!r}")

            # Media: every referenced file arrived with its bytes.
            media_dir = Path(col.media.dir())
            refs = col.media.files_in_str(basic.mid, front) + col.media.files_in_str(cloze.mid, cloze["Text"])
            if len(refs) != 2:
                return fail(f"media refs {refs}")
            for name in refs:
                data = (media_dir / name).read_bytes() if (media_dir / name).exists() else None
                if data not in (bytes([137, 80, 78, 71, 1, 2, 3]), bytes([73, 68, 51, 9])):
                    return fail(f"media {name} missing or wrong")

            # History and FSRS due date.
            card = basic.cards()[0]
            if col.decks.name(card.did) != "Cursus::Physics":
                return fail("basic card in wrong deck")
            revlog = col.db.all("select ease, type, time from revlog where cid = ? order by id", card.id)
            if revlog != [[3, 0, 5000], [3, 0, 4000], [4, 1, 2000]]:
                return fail(f"revlog {revlog}")
            if card.type != 2 or card.queue != 2:
                return fail(f"basic card type/queue {card.type}/{card.queue}")
            due_ms = (col.crt + card.due * 86_400) * 1000
            if abs(due_ms - expected["due"]) > DAY:
                return fail(f"due {due_ms} vs {expected['due']}")
            if card.memory_state is None or abs(card.memory_state.stability - expected["stability"]) > 0.01:
                return fail(f"memory state {card.memory_state} vs {expected['stability']}")
        finally:
            col.close()
    print("check-export: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
