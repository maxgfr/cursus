---
name: Cursus
description: Calm, offline-first study app for iPhone, iPad and Mac.
colors:
  accent: "#2563eb"
  accent-hover: "#1d55d6"
  accent-soft: "#e8efff"
  accent-ink: "#1a4fc9"
  ground: "#f2f4f7"
  sidebar: "#e9edf2"
  surface: "#ffffff"
  surface-pressed: "#eef1f5"
  surface-raised: "#ffffff"
  ink: "#101828"
  ink-secondary: "#475467"
  ink-tertiary: "#5b6578"
  hairline: "#e1e5eb"
  danger: "#c0362c"
  warning: "#9a4a06"
  success: "#12704a"
  dark-ground: "#0b0d12"
  dark-surface: "#171a21"
  dark-surface-raised: "#353b47"
  dark-ink: "#f2f4f7"
  dark-accent: "#7aa2ff"
  dark-on-accent: "#08132e"
  course-blue: "#4f46e5"
  dark-course-blue: "#6c70ff"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
  title:
    fontSize: "1.25rem"
    fontWeight: 700
  body:
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  footnote:
    fontSize: "0.9375rem"
    fontWeight: 600
  caption:
    fontSize: "0.8125rem"
    fontWeight: 600
rounded:
  small: "4px"
  control: "10px"
  surface: "12px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
  list-group:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.surface}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
  sync-chip:
    rounded: "{rounded.pill}"
    typography: "{typography.caption}"
  segmented-selected:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
  answer-hidden:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
  answer-shown:
    backgroundColor: "{colors.surface-pressed}"
    rounded: "{rounded.control}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.surface}"
    typography: "{typography.footnote}"
  keycap:
    rounded: "{rounded.small}"
    typography: "{typography.caption}"
---

# Design System: Cursus

## Overview

**Creative North Star: "The Quiet Desk"**

Cursus plays the flashcard-app category straight, at Things 3 finish: one calm screen that answers "what do I do now?". Grouped inset lists on a cool near-white ground, white surfaces, deep ink, one blue accent. Dark mode is designed on its own: near-black ground, lifted surfaces, a lighter blue carrying dark ink.

Density is moderate and native-feeling; the system font stack and tabular figures keep numbers (due counts, durations) steady. No dashboards, mascots, streak pressure or gradient chrome.

**Key Characteristics:**
- One accent, reserved for the primary action, selection, focus and inline links; course dots stay off its hue.
- Grouped inset lists (12px surfaces, hairline separators inset past the leading icon).
- Large title + context line per screen; content capped at 720px. Headings carry structure on their own: no labels stacked above them.
- Bottom tab bar under 1000px wide, sidebar from 1000px (iPad landscape, Mac).

## Colors

A restrained cool-neutral palette with a single blue voice; light and dark are separate token sets in `src/ui/tokens.css` (system preference, overridable by `data-theme`).

### Primary
- **Study Blue** (accent): Start, primary buttons, focus ring, caret, active navigation. In dark mode it becomes the lighter Study Blue Night (dark-accent) with dark ink on it, keeping AA contrast.

### Neutral
- **Cool Paper** (ground) and **Sidebar Mist** (sidebar): the two neutral layers; the sidebar is one step cooler.
- **Surface** / **Surface Pressed**: list groups, cards, hover and pressed rows; Surface Pressed also fills the shown answer.
- **Surface Raised**: the one thing that sits on top of a pressed track, the selected segment. White in light (same as Surface); in dark it is a distinctly lighter slate (dark-surface-raised) so the selected segment still lifts out of a dark track.
- **Deep Ink**, **Slate** (ink-secondary), **Muted Slate** (ink-tertiary, still ≥ 4.5:1 on every ground): text hierarchy.
- **Hairline**: separators and field borders.

### Status
- Danger, warning and success each pair a strong tone with a soft background, used only in chips and banners.

### Course identity
Eight hues (`--course-blue … --course-graphite`), each tuned per theme, shown only as a 12px dot next to the course name. The token named `course-blue` is an indigo (course-blue / dark-course-blue), deliberately off the accent's hue so a course dot never reads as "act here".

### Named Rules
**The One Voice Rule.** Blue means "act here" or "you are here". Never decoration.
**The Off-Accent Dot Rule.** No course hue may sit on the accent's hue; a dot is identity, never a call to action.
**The Truthful Chip Rule.** The sync chip's colour follows verified state only: green only when every local object is confirmed on a destination.

## Typography

**Font:** system stack (-apple-system, SF Pro, Segoe UI, system-ui). One family carries everything.

**Character:** native and quiet; weight steps do the work, not faces.

### Hierarchy
- **Large Title** (700, 2.125rem, -0.02em): one per screen; also Today's due sentence ("12 cards due today") in the hero and the Review summary title.
- **Headline** (700, 1.5rem): Today's caught-up and coming-back-later sentences, AI result headings, `h1` inside rendered card prose.
- **Title** (700, 1.25rem): group headings, empty-state titles, sheet titles, the sidebar app name.
- **Body** (400, 1.0625rem, 1.45): rows and prose (prose capped at 70ch).
- **Footnote** (0.9375rem): context lines, sidebar rows, segment labels, small sentence-case panel headings (600).
- **Caption** (0.8125rem): bottom tab labels (600), chips, keycaps, grade intervals, sidebar due counts.

### Named Rules
**The Tabular Rule.** All figures are tabular (`font-variant-numeric: tabular-nums` on body).
**The 16px Floor.** Inputs never go below 16px so iOS never zooms.
**The Sentence-Case Rule.** Every label is sentence case at its natural tracking. Small headings are Footnote 600 in Slate; nothing is uppercased or letter-spaced to look like a label.

## Layout

Fixed rem scale on a 4px rhythm. Screens are a single column capped at 720px, centred, with a gutter of max(16px, safe-area insets). Under 1000px: content plus a fixed bottom tab bar of four items (Today, Courses, Understand, Settings) padded by the bottom safe area, hidden while the on-screen keyboard is open (`--kb-inset` from `visualViewport`). From 1000px: a 260px sidebar (app name, the four destinations, then the course list with dots and due counts) beside the content. The sidebar ends with a quiet Search row carrying its ⌘K / Ctrl K hint. Review and onboarding are focus routes with no navigation chrome. Heights use `100dvh`.

## Elevation & Depth

Flat and tonal. Surfaces separate from the ground by colour plus a single 1px lift (`0 1px 2px rgb(16 24 40 / 0.06)` in light, `0 1px 0 rgb(0 0 0 / 0.4)` in dark). Sheets add a scrim, not a bigger shadow.

### Named Rules
**The One-Pixel Rule.** No shadow beyond the 1px lift, anywhere.

## Shapes

Four radii, each with one job: small (4px) only for marks inside text or charts (inline code, keycaps, the top of a chart bar); control (10px) for buttons, fields, rows and answer faces; surface (12px) for groups, cards, sheets and toasts; pill only for chips and count badges. Separators are 1px hairlines inset past the leading element. Icons are Lucide at 1.75 stroke (2.25 for the active tab).

## Components

### Buttons
- **Shape:** control radius (10px), min height 44px (50px large).
- **Primary:** Study Blue with white (dark: light blue with dark ink).
- **Secondary:** soft blue with blue ink. **Plain:** text-only blue. **Danger:** soft red.
- **States:** hover darkens, press scales to 0.98, disabled at 45% opacity, loading shows a spinner and `aria-busy`.
- **Keyboard hint:** a primary button may carry its key as a caption-size keycap (e.g. Start + S), shown only on `(hover: hover) and (pointer: fine)`.

### Lists
- Grouped inset list: title (Title style) above a white 12px group; rows have optional leading icon or course dot, title + subtitle, trailing count pill and chevron; hover uses Surface Pressed.

### Inputs / Fields
- 1px Hairline Strong border, 10px radius, 44px tall; focus turns the border and a 2px ring blue; errors turn the border red with a message below.

### Segmented control
- Native radios in a pressed-tone track; the selected segment lifts to Surface Raised with the 1px lift and Deep Ink text, unselected labels in Slate.

### Navigation
- Tab bar: translucent surface with backdrop blur, Caption-size labels (600) in Muted Slate, the current item in accent ink with a heavier icon stroke.
- Sidebar, one voice: Sidebar Mist, 10px rows in Deep Ink with Slate icons. Only the current row speaks blue: soft-blue fill, accent-ink text, and the only accent-coloured icon. A section that merely contains the current page stays plain.

### Sync chip (signature)
- Pill at the top right of Today, icon + verified status (only on this device / syncing / protected on N / offline / needs attention / not saved), toned neutral, blue, green, amber or red.

### Review card (signature)
- One raised surface holding two faces with the same rhythm. The question is plain text; the answer is the card's back face: a filled 10px block (min 7.5rem tall). Hidden, the back face is the "Show answer" button in soft blue; shown, it becomes Surface Pressed at the same footprint, so nothing jumps. No dashed outlines, no labels over the faces; faces are named for assistive tech only (`aria-label`).
- One progress readout per session: the remaining count above the card, Footnote 600 Muted Slate, announced as a status. The bar holds only close and the title.
- Grades: four equal 10px tiles on Surface with the 1px lift; the AI-suggested grade takes soft blue with an accent border. Key hints (Space, 1–4) are inline keycaps shown only with a fine pointer that can hover.

### Card editor
- Editing works on a draft kept on this device; nothing touches the card until an explicit Save (also ⌘S / Ctrl S) or Save & new. A footnote status line reports unsaved / saved; Save sits top right on iPad and Mac and in the thumb zone on iPhone.

### Sheet, Toast, Empty state
- Sheet: native modal `<dialog>`, bottom sheet under 600px, centred panel above.
- Toast: an ink-on-ground 12px block (Footnote) above the tab bar and keyboard, with optional text actions. A reversible delete never asks first: it acts and offers Undo in the toast.
- Empty state: a surface with a soft-blue icon tile, title, one teaching sentence and the next action. Where the screen's own content is the next action (Sync's destination list, Search's field), the empty state stops at the sentence.
- Nudge lines are a single footnote sentence plus one link, e.g. "No backup yet · Add a backup" under Today's hero.

### Motion
- 200ms with an exponential ease-out; the Today hero morphs into the review surface through a view transition (`review-focus`). With reduced motion the names are dropped and only a crossfade remains.

## Do's and Don'ts

### Do:
- **Do** use the accent only for the primary action, selection and focus.
- **Do** route every visible string through i18n and let German wrap; never fix text widths.
- **Do** keep figures tabular and inputs at 16px or more.
- **Do** design both themes when adding a token.
- **Do** show keyboard hints only under `(hover: hover) and (pointer: fine)`.
- **Do** offer Undo after a reversible action instead of a confirmation dialog.

### Don't:
- **Don't** add shadows beyond the 1px lift, gradient text, or glass as decoration.
- **Don't** add streaks, confetti or stats dashboards to Today.
- **Don't** let the sync chip claim more than the engine has verified.
- **Don't** put an eyebrow, kicker or uppercase tracked label above a heading or a card face.
- **Don't** show the same progress figure twice on one screen.
- **Don't** use the 4px radius on buttons, fields, rows or surfaces.
