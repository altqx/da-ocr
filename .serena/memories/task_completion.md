# Task Completion

- Run targeted Biome on touched files: `rtk bunx biome check --write <files>`.
- Run TypeScript: `rtk bunx tsc --noEmit`.
- Run tests when runtime supports Vite config loading: `rtk bun --bun run test`.
- Run production build when runtime supports Vite config loading: `rtk bun --bun run build`.
- If `bun run check` is used, note existing Biome config/schema and unrelated lint findings rather than modifying unrelated files.
- Before final response, inspect `rtk git status --short` and summarize any verification commands that could not run.