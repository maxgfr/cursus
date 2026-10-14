# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated, confirmed in the approved plan: Bun 1.4 (package manager, scripts, `bun test`), Vite 8 + vite-plugin-pwa 2, React 19, TypeScript 7 strict, native CSS (custom-property tokens + CSS Modules), Biome 2. Static hosting on GitHub Pages under `/cursus/`; no server of any kind.

## Users

A university student (bachelor or master), often trilingual French / German / English (e.g. Erasmus). They organise course material by course, use AI to understand a topic, then retain it with spaced-repetition cards. Same person across three devices and moments:
- iPad during lectures (often with a keyboard or Apple Pencil Scribble);
- iPhone on the move, frequently offline (metro, bad lecture-hall Wi-Fi);
- Mac in the evening for longer sessions.

They are under exam pressure and short on time.

## Product Purpose

Cursus lets a student go from raw course material (notes, PDFs, photos) to understanding (AI explanations grounded in their own sources, with citations) to durable memory (cards reviewed with FSRS), on every device, offline, without ever losing anything. Success: the student opens the app, sees exactly what to review today, studies, and trusts that every keystroke is safe everywhere.

## Positioning

Your data belongs to you: no account, no server, several verified backups running in parallel (S3, Google Drive, Dropbox, iCloud, files, nearby device), and your own AI model with your own key. And: understand before you memorise. Comparable apps (Algo, Anki, Nibomo) either own the account and server or do not ground understanding in the student's own material.

## Operating Context

- Daily ritual: open "Today", review due cards, add material after class, ask for an explanation of what was unclear.
- Courses are the organising unit (folders), each possibly in its own language; exam dates per course.
- Sync destinations are configured once per device; status ("protected on N destinations") must always be truthful.
- Interop: Anki `.apkg` import/export with review history; CSV/TSV import.

## Capabilities and Constraints

- Local-first PWA: IndexedDB is the source of truth on each device; works fully offline; installable on iPhone, iPad, Mac.
- Interface languages: English (default), German, French. German strings run long.
- AI is BYOK, called directly from the browser; provider/model from the `llm-models` catalog.
- Never lose data: immutable sync log, nothing remote is ever rewritten or deleted.
- Undecided: custom domain (currently shared origin `maxgfr.github.io`).

## Brand Commitments

- Name: Cursus.
- Voice: calm, focused, encouraging. No noisy gamification (no confetti, no loud streak pressure).
- Standing visual preference (user's choice in the first direction round): the category standard for study/flashcard apps, played straight and executed at full craft. Reference bar: Things 3, for its calm, focus and native-quality finish. In the user's words: "une application clean, pour pouvoir focus". No logo or brand colour imposed.

## Evidence on Hand

None yet: no users, testimonials, metrics or assets. Do not fabricate any.

## Product Principles

1. Trust first: every state the UI claims about saving or syncing is verified, never optimistic.
2. Understand before memorising: AI output is grounded in the student's sources and cites them.
3. One clear next action: the app always says what to do now (review, add, understand).
4. The student owns everything: open formats, exports, no lock-in, no account.
5. Calm under pressure: the interface lowers stress instead of adding urgency.

## Accessibility & Inclusion

- Trilingual UI with long German strings; locale-aware dates, numbers and plurals.
- Usable with keyboard (Mac, iPad keyboard), touch, Apple Pencil Scribble and dictation; respects reduced motion and system dark mode.
- WCAG 2.2 AA as the target.
