# Manual device tests

Checks that automated tests cannot cover, run on real hardware before a release. Devices: an iPhone and
an iPad on current iOS/iPadOS (Safari), a Mac with Safari and Chrome. Use a throwaway library and test
destinations. Record the date, devices and OS versions with each run.

## Installation and storage

- [ ] **Install on iPhone.** Safari > app URL > Share > *Add to Home Screen*; open from the icon.
  Expected: opens full screen without Safari's toolbar; works with flight mode on after the first load.
- [ ] **Safari tab vs installed app.** Create a course in the installed app, then open the same URL in a
  Safari tab. Expected: the tab does not show the course (separate replica) until both sync through the
  same destination; after a sync in both, both show it.
- [ ] **Persistent storage.** In the installed app, *Settings > Data > Protect storage*. Expected: the
  status reads that protected storage is on. In a plain Safari tab, if refused, the refusal message
  suggests installing.
- [ ] **Data present after 8 days.** Leave the installed app unopened for 8 days on iPhone and iPad.
  Expected: on reopening, the library is intact without restoring from a destination.

## Sign-in and destinations

- [ ] **OAuth in standalone mode.** In the installed app on iPhone, connect Google Drive, then Dropbox, then
  iCloud (CloudKit). Expected: each sign-in returns to the installed app (not to a Safari tab) and the
  destination shows as connected; nothing typed before the redirect is lost.
- [ ] **Google Drive.** Add cards on iPhone, sync; open on the Mac connected to the same Drive.
  Expected: the cards appear; Drive shows a `Cursus` folder with `fmt/`, `ws/`, `seg/` entries; status says
  protected on both devices.
- [ ] **Dropbox.** Same as above. Expected: files under `Apps/<app name>/`; status protected.
- [ ] **CloudKit.** Same as above with the production container. Expected: records of type
  `CursusObject` in the private database; status protected.
- [ ] **Cloudflare R2.** Configure an R2 bucket with the CORS rule from the app; *Test connection*.
  Expected: test passes; after a sync, objects under the chosen prefix; status protected.
- [ ] **Sealed destination.** Seal one destination with a passphrase, then add it on a second device.
  Expected: the second device asks for the passphrase and uploads nothing before it is entered; after
  unlocking, content syncs. In the bucket, objects start with `CRSE` (except `fmt/v1` and `keys/`).

## iCloud Drive folder from Chrome (Mac)

- [ ] **Permission.** Add a *Folder* destination in Chrome pointing to a folder in iCloud Drive; reload
  the tab. Expected: Chrome asks again for permission once; after granting, sync resumes; refusing shows a
  needs-permission state, not an error loop.
- [ ] **Files not downloaded.** With *Optimise Mac Storage* on, let iCloud evict some files, then sync.
  Expected: evicted files are downloaded or reported as pending; nothing is reported as corrupt or lost.
- [ ] **"x 2" copies.** Create a conflicting copy (for example `0000000001-….seg` duplicated by iCloud as
  `… 2.seg`). Expected: the copy is ignored; no error; library unchanged.

## Moving data between devices

- [ ] **Files and AirDrop.** Export a backup file on iPhone, AirDrop it to the Mac and import it there,
  then save one to Files and import it on iPad. Expected: same courses, cards and review history.
- [ ] **QR code camera.** *Pair a device* between iPhone and Mac using the camera to scan the code.
  Expected: the camera opens, the code is read, the destinations (and keys) appear on the receiving
  device.
- [ ] **Wi-Fi Mac to iPad.** Pair the Mac and the iPad on the same Wi-Fi network without internet access to
  a destination. Expected: pairing completes directly between the two devices.

## Interruptions and limits

- [ ] **Switch app during an upload.** Import a large PDF on iPhone, start a sync, switch to another app
  for a minute, come back. Expected: local edits are kept; the sync resumes (or *Verify* completes it);
  status ends protected.
- [ ] **Device almost full.** Fill the iPhone until under ~200 MB free, then add cards and an image.
  Expected: either saved, or a blocking banner says the change is not saved on this device; no silent loss
  once space is freed.
- [ ] **Update while typing.** Deploy a new version while typing in a card on iPad. Expected: an update
  notice appears; the text being typed is kept before and after accepting the update.

## Content and input

- [ ] **HEIC photo.** Add an iPhone camera photo (HEIC) to a fiche. Expected: displayed on iPhone, iPad
  and Mac after sync.
- [ ] **Large PDF on iPhone.** Import a PDF of 100+ pages (~50 MB) as a source. Expected: text extracted,
  no crash, the file syncs in 4 MiB chunks.
- [ ] **Hardware keyboard.** On iPad with a keyboard, study a session with keyboard shortcuts only and
  edit a card. Expected: every action reachable; focus visible.
- [ ] **Scribble.** On iPad with Apple Pencil, write into a card field and the search box. Expected:
  handwriting is converted to text in place.

## AI with real keys

- [ ] **Real keys.** For each provider used (for example OpenAI, Anthropic, Google, OpenRouter), enter a
  key and generate cards from a source. Expected: cards generated from the device without any proxy; usage
  and cost recorded; a wrong key shows a clear error. Repeat on iPhone.
