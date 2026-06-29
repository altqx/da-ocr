# Suggested Commands

- Install: `rtk bun install`
- Dev server: `rtk bun --bun run dev`
- Type check: `rtk bunx tsc --noEmit`
- Unit tests: `rtk bun --bun run test`
- Production build: `rtk bun --bun run build`
- Biome project check: `rtk bun run check`
- Targeted Biome write for touched files: `rtk bunx biome check --write <files>`
- Git status/diff should follow repo instruction prefix: `rtk git status --short`, `rtk git diff`.

Note: test/build can fail at Vite config startup if the active runtime lacks `node:module.registerHooks`; verify runtime before treating that as an app-code regression.