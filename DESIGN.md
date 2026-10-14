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
  ink: "#101828"
  ink-secondary: "#475467"
  ink-tertiary: "#5b6578"
  hairline: "#e1e5eb"
  danger: "#c0362c"
  warning: "#9a4a06"
  success: "#12704a"
  dark-ground: "#0b0d12"
  dark-surface: "#171a21"
  dark-ink: "#f2f4f7"
  dark-accent: "#7aa2ff"
  dark-on-accent: "#08132e"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  hero:
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.15
    fontFeature: "tnum"
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
  surface: "12px"
  control: "10px"
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
---

# Design System: Cursus

## Overview

**Creative North Star: "The Quiet Desk"**

Cursus plays the flashcard-app category straight, at Things 3 finish: one calm screen that answers "what do I do now?". Grouped inset lists on a cool near-white ground, white surfaces, deep ink, one blue accent. Dark mode is designed on its own: near-black ground, lifted surfaces, a lighter blue carrying dark ink.

Density is moderate and native-feeling; the system font stack and tabular figures keep numbers (due counts, durations) steady. No dashboards, mascots, streak pressure or gradient chrome.

**Key Characteristics:**
- One accent, reserved for the primary action, selection and focus.
- Grouped inset lists (12px surfaces, hairline separators inset past the leading icon).
- Large title + context line per screen; content capped at 720px.
- Bottom tab bar under 1000px wide, sidebar from 1000px (iPad landscape, Mac).

## Colors

A restrained cool-neutral palette with a single blue voice; light and dark are separate token sets in `src/ui/tokens.css` (system preference, overridable by `data-theme`).

### Primary
- **Study Blue** (accent): Start, primary buttons, focus ring, caret, active navigation. In dark mode it becomes the lighter Study Blue Night (dark-accent) with dark ink on it, keeping AA contrast.

### Neutral
- **Cool Paper** (ground) and **Sidebar Mist** (sidebar): the two neutral layers; the sidebar is one step cooler.
- **Surface** / **Surface Pressed**: list groups, cards, hover and pressed rows.
- **Deep Ink**, **Slate** (ink-secondary), **Muted Slate** (ink-tertiary, still ≥ 4.5:1 on every ground): text hierarchy.
- **Hairline**: separators and field borders.

### Status
- Danger, warning and success each pair a strong tone with a soft background, used only in chips and banners.

### Course identity
Eight hues (`--course-blue … --course-graphite`), each tuned per theme, shown only as a 12px dot next to the course name.

### Named Rules
**The One Voice Rule.** Blue means "act here" or "you are here". Never decoration.
**The Truthful Chip Rule.** The sync chip's colour follows verified state only: green only when every local object is confirmed on a destination.

## Typography

**Font:** system stack (-apple-system, SF Pro, Segoe UI, system-ui). One family carries everything.

**Character:** native and quiet; weight steps do the work, not faces.

### Hierarchy
- **Hero** (700, 2.5rem): the due count on Today only.
- **Large Title** (700, 2.125rem, -0.02em): one per screen.
- **Title** (700, 1.25rem): group headings, empty-state titles, sheet titles.
- **Body** (400, 1.0625rem, 1.45): rows and prose (prose capped at 70ch).
- **Footnote / Caption** (600, 0.9375 / 0.8125rem): context lines, chips, tab labels.

### Named Rules
**The Tabular Rule.** All figures are tabular (`font-variant-numeric: tabular-nums` on body).
**The 16px Floor.** Inputs never go below 16px so iOS never zooms.

## Layout

Fixed rem scale on a 4px rhythm. Screens are a single column capped at 720px, centred, with a gutter of max(16px, safe-area insets). Under 1000px: content plus a fixed bottom tab bar of four items (Today, Courses, Understand, Settings) padded by the bottom safe area, hidden while the on-screen keyboard is open (`--kb-inset` from `visualViewport`). From 1000px: a 260px sidebar (app name, the four destinations, then the course list with dots and due counts) beside the content. Review and onboarding are focus routes with no navigation chrome. Heights use `100dvh`.

## Elevation & Depth

Flat and tonal. Surfaces separate from the ground by colour plus a single 1px lift (`0 1px 2px rgb(16 24 40 / 0.06)` in light, `0 1px 0 rgb(0 0 0 / 0.4)` in dark). Sheets add a scrim, not a bigger shadow.

### Named Rules
**The One-Pixel Rule.** No shadow beyond the 1px lift, anywhere.

## Shapes

Surfaces 12px, controls 10px, pills only for chips and count badges. Separators are 1px hairlines inset past the leading element. Icons are Lucide at 1.75 stroke (2.25 for the active tab).

## Components

### Buttons
- **Shape:** control radius (10px), min height 44px (50px large).
- **Primary:** Study Blue with white (dark: light blue with dark ink).
- **Secondary:** soft blue with blue ink. **Plain:** text-only blue. **Danger:** soft red.
- **States:** hover darkens, press scales to 0.98, disabled at 45% opacity, loading shows a spinner and `aria-busy`.

### Lists
- Grouped inset list: title (Title style) above a white 12px group; rows have optional leading icon or course dot, title + subtitle, trailing count pill and chevron; hover uses Surface Pressed.

### Inputs / Fields
- 1px Hairline Strong border, 10px radius, 44px tall; focus turns the border and a 2px ring blue; errors turn the border red with a message below.

### Segmented control
- Native radios in a pressed-tone track; the selected segment lifts to Surface.

### Navigation
- Tab bar: translucent surface with backdrop blur, Muted Slate labels, blue active item. Sidebar: Sidebar Mist, rows with 10px radius, active row in soft blue.

### Sync chip (signature)
- Pill at the top right of Today, icon + verified status (only on this device / syncing / protected on N / offline / needs attention / not saved), toned neutral, blue, green, amber or red.

### Sheet, Toast, Empty state
- Sheet: native modal `<dialog>`, bottom sheet under 600px, centred panel above. Toast: ink-on-ground pill above the tab bar and keyboard. Empty state: a surface with a soft-blue icon tile, title, one teaching sentence and the next action.

### Motion
- 200ms with an exponential ease-out; the Today hero morphs into the review surface through a view transition (`review-focus`). With reduced motion the names are dropped and only a crossfade remains.

## Do's and Don'ts

### Do:
- **Do** use the accent only for the primary action, selection and focus.
- **Do** route every visible string through i18n and let German wrap; never fix text widths.
- **Do** keep figures tabular and inputs at 16px or more.
- **Do** design both themes when adding a token.

### Don't:
- **Don't** add shadows beyond the 1px lift, gradient text, or glass as decoration.
- **Don't** add streaks, confetti or stats dashboards to Today.
- **Don't** let the sync chip claim more than the engine has verified.
- **Don't** put an eyebrow or kicker above a heading.
