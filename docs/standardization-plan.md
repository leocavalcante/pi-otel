# Standardization plan: pi-otel

Status: in progress, 2026-11-12. Target: [Pi extension standard v1](pi-extension-standard.md). Delete this file once every step is done.

## Progress

- Step 0 is complete: identity, repository settings, CodeQL, security features, labels, the `npm` environment, branch and tag rulesets, and full-SHA pinning are configured.
- Step 1 merged in [PR #1](https://github.com/leocavalcante/pi-otel/pull/1). Linux, macOS, Windows, Node.js 22.19/22/24/26, minimum Pi 1.5.0, package checks, and security scans passed.
- Step 2 merged in [PR #5](https://github.com/leocavalcante/pi-otel/pull/5). The trusted publisher for `cd.yaml` and environment `npm` is configured. The first CD run exchanged an OIDC token and released nothing, as expected.
- Step 3 merged in [PR #6](https://github.com/leocavalcante/pi-otel/pull/6) and released [0.1.3](https://github.com/leocavalcante/pi-otel/releases/tag/v0.1.3) with SLSA provenance. The package includes a `CHANGELOG.md` that Pi parses, and it ships the 0.1.2 telemetry-runtime fix that npm users never received. The v0.1.2 release notes now say it wasn't published.
- Dependabot's first updates merged. The runtime `pi-telemetry` 1.5.2 update released [0.1.4](https://github.com/leocavalcante/pi-otel/releases/tag/v0.1.4), confirming that trusted publishing works with tokens disallowed. npm took about 3 minutes to expose that version, so the post-publish check now waits up to 15 minutes ([PR #8](https://github.com/leocavalcante/pi-otel/pull/8)).
- Steps 4–6 merged: Prettier ([PR #9](https://github.com/leocavalcante/pi-otel/pull/9)), the blame-ignore file ([PR #10](https://github.com/leocavalcante/pi-otel/pull/10)), and typescript-eslint with `noUncheckedIndexedAccess` ([PR #11](https://github.com/leocavalcante/pi-otel/pull/11)).
- Step 7 is the README rewrite and community files, released as a patch through `docs(readme)`.
- Step 8 is done except for gallery media. `0.0.0-stage` is deprecated, publishing requires 2FA and disallows tokens, and full-SHA pinning is required. Still to do: add `pi.image` and upload the social preview by hand.
- pi-ttyd is archived and deprecated on npm.
- Dependabot uses a 7-day cooldown for Bun and Actions updates to satisfy zizmor, and its long pull request titles are exempt from the 72-character limit.

pi-otel is the pilot. It goes first because npm users are on a broken release, and because it's the smallest repository with no CI to migrate.

## Target identity

| Field                   | Value                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Description             | Export metadata-only OpenTelemetry from Pi coding-agent sessions and Pi Durable agents.                                                     |
| Topics and npm keywords | `pi-extension` `pi-package` `pi-coding-agent` `pi-durable` `opentelemetry` `otlp` `observability` `llm-observability` `tracing` `telemetry` |
| Website                 | https://pi.dev/packages/@leocavalcante/pi-otel                                                                                              |
| Kind                    | Extension and SDK: Pi loads `src/extension.ts`, and Node.js consumers import `dist/`                                                        |
| Pi versions             | Minimum 1.5.0; tested with 1.5.2                                                                                                            |

## Where it stands

- **npm users are on a broken release.** `latest` is 0.1.1, published without provenance. The 0.1.2 fix ("include telemetry runtime in Pi installs") has a tag and a GitHub release, but nothing published it to npm, because there is no publishing workflow.
- **No GitHub automation.** There's no `.github/` directory: no CI, no publishing, no Dependabot, no issue forms.
- **GitHub settings:**
  - The About text differs from npm, and there are no topics or website.
  - Wiki and Projects are on, all three merge methods are allowed, and branches aren't deleted after merge.
  - Dependabot alerts and private vulnerability reporting are off.
  - `main` has no branch protection.
- **`package.json`:**
  - No `publishConfig`.
  - The `@earendil-works/pi-ai` peer is `^1.5.0`; the standard requires `*`.
  - One-line formatting.
  - Ships `docs/`.
- **Toolchain:** npm with `package-lock.json`, TypeScript 5.9.3, tests run with `node --experimental-strip-types`, and no formatter or linter.
- **Docs:**
  - The 125-line README mixes user and maintainer content.
  - `PLAN.md` records the delivered scope.
  - `CHANGELOG.md` is written by hand, with headings like `## 0.1.2`.
- **Measured:**
  - TypeScript 6.0.3 reports no errors; `noUncheckedIndexedAccess` adds 1.
  - `bun test --timeout 30000 --preload ./tests/environment.ts` passes all 26 tests.
- **Release state:** tag `v0.1.2` is on `HEAD`, so semantic-release's next patch will be 0.1.3.

## Steps

Each step is one pull request unless marked otherwise. "Release" is what `cd.yaml` publishes after the merge.

| #   | Change                                                        | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Release   |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0   | _Settings_                                                    | Standard A.11 except rulesets: About, topics, website, merging, features, code security, CodeQL default setup, labels.                                                                                                                                                                                                                                                                                                                                                                                                                            | —         |
| 1   | `build: adopt the Bun and TypeScript 6 toolchain with CI`     | <ul><li>Bun: `bun.lock` replaces `package-lock.json`; add `packageManager` and `bunfig.toml`.</li><li>TypeScript 6.0.3 with the shared `tsconfig.json` and `tests/tsconfig.json`; keep `tsconfig.build.json`.</li><li>Scripts from §4: `test:bun` adds `--preload ./tests/environment.ts`, and `test:node` adds `--import ./tests/environment.ts`.</li><li>Add jiti and `tests/load.node-test.ts`.</li><li>Add `ci.yaml` (`pi-min` 1.5.0, build step), `pr-title.yaml`, and `dependabot.yml`.</li></ul> Then create the `main` and `v*` rulesets. | none      |
| 2   | `ci: release to npm automatically from main`                  | <ul><li>Add `cd.yaml`, `.releaserc.json`, and `cliff.toml`.</li><li>Set the version to `0.0.0-development` and add `publishConfig`.</li><li>Delete the hand-written `CHANGELOG.md` and add it to `.gitignore`.</li><li>Complete the cutover checklist first.</li></ul>                                                                                                                                                                                                                                                                            | none      |
| 3   | `fix: declare Pi host packages as wildcard peer dependencies` | Change `@earendil-works/pi-ai` from `^1.5.0` to `*`. Keep `@earendil-works/pi-telemetry` in `dependencies`.                                                                                                                                                                                                                                                                                                                                                                                                                                       | **0.1.3** |
| 4   | `style: format with Prettier`                                 | Add `.prettierrc.json`, `.editorconfig`, and `.gitattributes`, then reformat. Formatting changes only. CI starts running `prettier --check`.                                                                                                                                                                                                                                                                                                                                                                                                      | none      |
| 5   | `chore: ignore the formatting commit in git blame`            | `.git-blame-ignore-revs` with the squash commit from step 4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | none      |
| 6   | `chore: lint with typescript-eslint`                          | Add `eslint.config.mjs`, apply the fixes that don't change behavior, and fix the one `noUncheckedIndexedAccess` site. Each real bug ESLint finds gets its own `fix:` PR.                                                                                                                                                                                                                                                                                                                                                                          | none      |
| 7   | `docs(readme): adopt the shared structure and voice`          | <ul><li>Rewrite the README per §10.3: user content only, absolute links, and the `docs/privacy.md` boundary summarized under Privacy and security.</li><li>Add CONTRIBUTING (absorbs the README's Development section), SECURITY, AGENTS, the issue forms, the PR template, CODEOWNERS, and `docs/pi-extension-standard.md`.</li><li>Delete `PLAN.md`, moving its Boundaries into the README.</li><li>Remove `docs` from `files`.</li></ul>                                                                                                       | patch     |
| 8   | _After the releases_                                          | <ul><li>Edit the v0.1.2 GitHub release: "Not published to npm. Its fix ships in 0.1.3."</li><li>Deprecate `0.0.0-stage`.</li><li>Add `pi.image` and the social preview.</li><li>Turn on `sha_pinning_required`.</li></ul>                                                                                                                                                                                                                                                                                                                         | —         |

Step 3 comes before formatting and linting so the missing fix reaches npm users after only three pull requests. 0.1.3 is the first automated release, and it carries the 0.1.2 runtime fix.

## Cutover checklist (before merging step 2)

- [x] Run `npm login`, then `npm trust list @leocavalcante/pi-otel`. There may be no trusted publisher yet.
- [x] Run `npm trust github @leocavalcante/pi-otel --file cd.yaml --repo leocavalcante/pi-otel --env npm --allow-publish`.
- [x] The `npm` environment exists, with `main` as its only deployment branch.
- [x] Merge step 2. Nothing is released yet, because there are no releasable commits since `v0.1.2`.
- [x] Merge step 3, then check:
  - [x] Tag `v0.1.3` exists.
  - [x] `npm view @leocavalcante/pi-otel@0.1.3 dist.attestations` shows provenance.
  - [x] The GitHub release has notes.
  - [x] The tarball contains `CHANGELOG.md`.
  - [ ] `pi update` shows "Extension Updates" in Pi.

## Notes and risks

- **Environment variables.** `tests/environment.ts` removes inherited telemetry variables. Both test lanes must load it, or developer settings could leak into tests.
- **Two entry points.** `exports["./extension"]` points to the compiled `dist/extension.js` for SDK consumers, while Pi loads `src/extension.ts`. The package test imports both.
- **The v0.1.2 tag can't be published with provenance**, because the tagged commit has no workflow. Shipping 0.1.3 is the clean fix.
- **CHANGELOG history.** The generated `CHANGELOG.md` rebuilds 0.1.0–0.1.2 from commit messages. The hand-written text for those versions is replaced, and the commit subjects already say the same things.

## Rollout across the extensions

This section is identical in every repository's plan.

**Order:**

1. Retire pi-ttyd.
2. pi-otel, the pilot, which also ships its missing fix.
3. pi-a2a.
4. pi-tmux, which becomes the reference implementation.
5. pi-subagents, which has the largest test migration.

Finish a repository's steps 1–3 before starting the next one, so each migration builds on the last.

**npm account (once, interactive):**

1. Run `npm login`, then `npm trust list <package>` for each package to record today's trusted publishers.
2. At each repository's step 2, run `npm trust github <package> --file cd.yaml --repo leocavalcante/<repo> --env npm --allow-publish`. This replaces any `publish.yml` entry.
3. Set each package's publishing access to "require 2FA and disallow tokens".
4. Run `npm deprecate <package>@0.0.0-stage "Bootstrap placeholder; not a release."`

**Retire pi-ttyd.** It has no open issues or pull requests, and about 17 downloads a week.

1. Merge `docs: mark pi-ttyd as unmaintained`. The README opens with: "**pi-ttyd is no longer maintained.** Published versions stay installable, but they won't get updates or security fixes. Remove it with `pi remove npm:pi-ttyd`."
2. Run `npm deprecate pi-ttyd "pi-ttyd is no longer maintained. Remove it with: pi remove npm:pi-ttyd"`.
3. Run `gh repo edit leocavalcante/pi-ttyd --description "Unmaintained. Set ttyd tab titles, notify you when Pi is ready, and accept dropped images."`.
4. Run `gh repo archive leocavalcante/pi-ttyd --yes`.
