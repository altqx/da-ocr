# Deadass OCR

Paste a screenshot, get the text. No upload, no server round-trip — OCR runs entirely in the browser via a WASM engine ([Tesseract.js](https://tesseract.projectnaptha.com/)).

## Features

- **Paste-first workflow** — Ctrl+V anywhere on the page to load an image
- **Drag & drop / file picker** as alternatives to paste
- **Preprocessing** — grayscale, threshold, and contrast controls with a live preview
- **Crop mode** — drag a region on the raw image and run OCR on just that area
- **Bounding box overlay** — click detected word chips to highlight them on the preview
- **Batch OCR** — queue multiple images, process with a pooled worker queue, and export as a `.zip`
- **Batch persistence** — the queue (including file blobs and OCR snapshots) is saved in IndexedDB and restored on reload
- **Export** — `.txt`, `.json`, `.csv`, and word-box formats per image
- **Multi-language OCR** — English, German, Japanese, Thai, and combination presets
- **Localized UI** — English, German, Japanese, Thai (via Paraglide JS)
- **Privacy** — images never leave the device

## Getting Started

```bash
bun install
bun --bun run dev
```

## Building for Production

```bash
bun --bun run build
```

## Testing

```bash
bun --bun run test
```

## Linting & Formatting

This project uses [Biome](https://biomejs.dev/).

```bash
bun --bun run lint
bun --bun run format
bun --bun run check
```

## Stack

- [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router)
- [Tesseract.js](https://tesseract.projectnaptha.com/) — WASM OCR engine
- [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) — i18n
- [Tailwind CSS v4](https://tailwindcss.com/)
- [fflate](https://github.com/101arrowz/fflate) — client-side zip export
- [Biome](https://biomejs.dev/) — linting & formatting
