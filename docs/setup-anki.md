# Anki import and export

Cursus reads and writes Anki packages as files. There is no connection to AnkiWeb or to a running Anki:
move the files yourself (Files, AirDrop, a synced folder).

## Import

*Settings > Import & export > Import from Anki*, then choose an `.apkg` (deck package) or `.colpkg` (collection
package). Export it from Anki with *File > Export*; both the current format and the legacy formats work.

1. Cursus reads the package and shows its decks, notes, cards, reviews and media files.
2. Choose whether to keep the review history, then import.

What happens:

- Each deck becomes a course (subdecks keep their `Parent::Child` name; a top-level `Cursus::` prefix,
  as written by Cursus exports, is dropped).
- Each Anki card becomes a Cursus card. Card fields are converted from HTML to Markdown.
  - Cloze notes become cloze cards: the active deletion is kept on the front, the other deletions show
    their answer; the remaining fields go on the back.
  - Other notes use the template's card ordinal to pick the front field; the next field is the back, and
    any further non-empty fields are appended to the back with their field name.
- Media referenced by the notes (images, sounds) are stored as files. Imported sounds can be played; Cursus
  does not record audio.
- With *Keep review history*, the revlog is imported as reviews and FSRS rebuilds each card's schedule from
  it. Without it, cards start as new.
- Importing the same package again skips the cards already imported (matched by note GUID and card
  ordinal), including cards in the trash.

Limits:

- Card templates and styling (CSS, JavaScript, conditional fields, type-in answers) are not rendered; only
  field contents are used.
- Notes whose note type or note is missing in the package are skipped and counted as such.

## Export

Use the Anki button next to a course in *Settings > Import & export* to export that course as an `.apkg`.

- Notetypes *Cursus Basic* and *Cursus Cloze*, one deck `Cursus::<course>` per course.
- Card text is converted from Markdown to Anki HTML, with media files included.
- Review history and the FSRS due dates are exported, so cards keep their schedule in Anki.

A course can also be shared as a `.cursus-course` package, which keeps everything and imports only into
Cursus.

## Not supported

- Sync with AnkiWeb or with Anki desktop and mobile apps.
- Image occlusion, handwriting and audio recording.
