"""Builds tests/fixtures/anki/*.apkg with the official Anki engine.

Run once, then commit the output (tests never regenerate it):
  uv run --no-project --with anki==26.9.3 python scripts/anki/make-fixtures.py
"""

import sys
import tempfile
from pathlib import Path

from anki.collection import Collection, ExportAnkiPackageOptions
from anki.decks import DeckId
from anki.import_export_pb2 import ExportLimit

OUT = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "anki"
# 1x1 transparent PNG.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
SOUND = b"ID3fake-mp3-bytes"
T0 = 1_700_000_000_000  # revlog ids are epoch ms


def build(col: Collection) -> None:
    col.media.write_data("cell.png", PNG)
    col.media.write_data("hello.mp3", SOUND)
    deck = col.decks.id("Bio::Cells")

    # Basic notetype with an extra field, plus a reversed template.
    basic = col.models.copy(col.models.by_name("Basic (and reversed card)"))
    basic["name"] = "Basic+Notes"
    col.models.add_field(basic, col.models.new_field("Notes"))
    col.models.update_dict(basic)
    n1 = col.new_note(basic)
    n1.guid = "guidBasic01"
    n1["Front"] = 'The <b>powerhouse</b> of the cell<br><img src="cell.png">'
    n1["Back"] = "Mitochondria \\(E = mc^2\\)"
    n1["Notes"] = "Has its own DNA"
    n1.tags = ["bio", "cells"]
    col.add_note(n1, deck)

    cloze = col.new_note(col.models.by_name("Cloze"))
    cloze.guid = "guidCloze01"
    cloze["Text"] = "{{c1::Paris}} is the capital of {{c2::France}} [sound:hello.mp3]"
    cloze["Back Extra"] = "<i>Geography</i>"
    col.add_note(cloze, col.decks.id("Geo"))

    cids = col.db.list("select id from cards order by nid, ord")
    # (card, offset ms, ease, type): ease 0 and type 4 rows must be ignored on import.
    rows = [
        (cids[0], 0, 3, 0),
        (cids[0], 86_400_000, 3, 1),
        (cids[0], 2 * 86_400_000, 0, 4),
        (cids[1], 1_000, 1, 0),
        (cids[1], 61_000, 3, 0),
        (cids[2], 2_000, 4, 0),
        (cids[3], 3_000, 2, 0),
    ]
    for cid, off, ease, typ in rows:
        col.db.execute(
            "insert into revlog (id,cid,usn,ease,ivl,lastIvl,factor,time,type) values (?,?,?,?,?,?,?,?,?)",
            T0 + off,
            cid,
            -1,
            ease,
            1,
            0,
            2500,
            4_000,
            typ,
        )


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        col = Collection(str(Path(tmp) / "fixtures.anki2"))
        try:
            build(col)
            for name, legacy in (("legacy.apkg", True), ("modern.apkg", False)):
                opts = ExportAnkiPackageOptions(
                    with_scheduling=True, with_deck_configs=False, with_media=True, legacy=legacy
                )
                col.export_anki_package(out_path=str(OUT / name), options=opts, limit=ExportLimit(whole_collection={}))
                print(f"wrote {OUT / name}")
        finally:
            col.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
