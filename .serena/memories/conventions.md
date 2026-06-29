# Conventions

- Follow existing component style: React function components, local `useState`/`useRef` state, async handlers inside components, small utility modules under `src/components/ocr-studio/`.
- Use `lucide-react` icons for visible controls.
- Keep OCR/video/audio helpers separate when behavior is modality-specific; share generic subtitle formatting through utility functions.
- Localized UI text must be added to every `messages/*.json` file; `src/i18n.ts` exposes `m` as a loose record, so missing keys are caught by generation/build behavior rather than TS.
- File/object URLs are revoked on reset/unmount and when superseded.
- Browser capability gates should disable only the affected mode when possible; image/video compatibility checks are separate from audio WebGPU gating.
- Use `rtk` prefix for shell commands per repo AGENTS.md.