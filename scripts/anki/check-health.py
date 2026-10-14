"""Smoke check: the official Anki engine can create a collection and add a note."""

import sys
import tempfile
from pathlib import Path

from anki.collection import Collection


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        col = Collection(str(Path(tmp) / "health.anki2"))
        try:
            note = col.new_note(col.models.by_name("Basic"))
            note["Front"] = "front"
            note["Back"] = "back"
            col.add_note(note, col.decks.id("Default"))
            if col.note_count() != 1:
                print("expected one note", file=sys.stderr)
                return 1
        finally:
            col.close()
    print("anki ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
