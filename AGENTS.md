# AGENTS.md

pi-otel: export metadata-only OpenTelemetry from Pi coding-agent sessions and Pi Durable agents.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs every check CI runs.
- `bun run test:bun` and `bun run test:node` run one test lane.
- `bun run format` applies Prettier and ESLint fixes.
- `pi -e ./src/extension.ts` tries the checkout in Pi.

## Rules

- Follow docs/pi-extension-standard.md.
- Write Conventional Commits. The PR title becomes the release note (standard §10, rule 11).
- Sign off every commit (`git commit -s`). Never add Co-Authored-By.
- Never bump the version, edit CHANGELOG.md, create tags or releases, or publish. cd.yaml does that.
- Code in src/ runs on Node.js inside Pi: use `node:*` APIs, never Bun APIs.
- Keep Pi host packages (`@earendil-works/pi-ai`, `pi-coding-agent`) as `"*"` peer dependencies, never dependencies.
- Tests make no network or paid model calls.
- Update README.md and CONTRIBUTING.md with every behavior change, in the voice from standard §10.

## Project notes

- Privacy is the product. Export only allowlisted metadata (`src/privacy.ts`). Never add a path that exports prompts, answers, tool arguments or results, or error text. Tests inject synthetic private markers and inspect the real OTLP bodies; keep that coverage for new signals.
- `src/extension.ts` is the Pi entry and stays inactive without `OTEL_EXPORTER_OTLP_ENDPOINT`. `src/index.ts` is the SDK entry, compiled to `dist/` for Node.js consumers.
- `src/model-runtime.ts` wraps SDK ModelRuntime 1.5.0. It must forward every call unchanged and make exactly one underlying call per request.
- Both test lanes preload `tests/environment.ts`, which clears inherited OpenTelemetry settings so tests never export to a developer's collector.
