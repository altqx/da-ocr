# Tech Stack

- TypeScript strict mode with React 19 and TanStack Start/Router.
- Vite 8 build via `vite.config.ts`; Cloudflare plugin and Wrangler are present for preview/deploy.
- Styling uses Tailwind CSS v4 plus substantial app CSS in `src/styles.css`.
- Package manager/runtime is Bun; lockfile is `bun.lock`.
- Biome 2.5.1 is configured for lint/format/check. Current `biome.json` schema still points to 2.4.5, so full `biome check` emits a schema mismatch until migrated.
- i18n uses Paraglide/Inlang with source messages in `messages/en.json`, `messages/de.json`, `messages/jp.json`, `messages/th.json`.
- Client zip export uses `fflate`; icons use `lucide-react`; browser ASR path uses `@huggingface/transformers`.