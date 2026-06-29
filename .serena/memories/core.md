# Core

- Single TanStack Start/Vite frontend app; source under `src/`.
- Main user workflow lives in `src/components/OcrStudio.tsx` with focused helpers/components under `src/components/ocr-studio/`.
- OCR uses `runLensOcr` server function wrappers in `src/lib/lens-ocr.ts` / `src/lib/lens-ocr.server.ts`; browser UI posts image blobs through `FormData`.
- Route entry is `src/routes/index.tsx`; root shell/layout is `src/routes/__root.tsx`.
- Localized messages live in `messages/*.json`; app imports generated Paraglide messages through `src/i18n.ts`.
- Read for stack/build details: `mem:tech_stack`. Read for code style and completion checks: `mem:conventions`, `mem:task_completion`.