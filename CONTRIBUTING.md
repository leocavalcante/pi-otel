# Contributing

## Development

Use Bun 1.4.4 and Node.js 22.19.0 or newer. Pi loads extensions on Node.js, so code in `src/` uses Node.js APIs, not Bun APIs.

```sh
bun install --frozen-lockfile
bun run verify
```

`verify` checks source, tests, and examples; runs the Bun and Node.js test lanes; builds and validates the package in an isolated consumer; and audits dependencies. Audits block high and critical vulnerabilities. Run `bun audit` to review all severities, including moderate advisories in development tooling. Formatting and ESLint gates are separate steps in the [standardization plan](docs/standardization-plan.md).

```sh
bun run test:bun
bun run test:node
pi -e ./src/extension.ts
```

Both test lanes clear inherited OpenTelemetry settings before running. Integration tests use local HTTP receivers and faux models. They make no paid model calls and export no real session content.

When changing workflows, run the same checks as CI on Linux:

```sh
bash .github/scripts/check-workflows.sh
uvx --from zizmor==1.32.0 zizmor --offline .github
```

## Commits and pull requests

Use Conventional Commits and sign off commits with `git commit -s`. Never add a `Co-Authored-By` trailer. PR titles become squash commit subjects and release notes. Keep them user-facing, at most 72 characters, without a final period.

## Automatic releases

Do not edit the development version, create release tags, or publish from your machine. `.github/workflows/cd.yaml` runs CI on pushes to `main`, then semantic-release publishes releasable changes through npm Trusted Publishing with provenance.

- `feat` releases a minor version; `fix`, `perf`, and `revert` release a patch.
- `docs(readme)` releases a patch so npm and the Pi gallery receive README changes.
- Breaking changes release a minor while the package is below 1.0. Remove that override when releasing 1.0.
- CI, toolchain, and maintainer-documentation changes do not release.

The version in `package.json` stays `0.0.0-development`. semantic-release updates only its temporary workspace; it never commits back to `main`. git-cliff generates both the GitHub release notes and the `CHANGELOG.md` shipped in the package. Run `bun run changelog` to preview the history locally.

The release job uses Node.js 24 and the OIDC-capable npm CLI installed with `@semantic-release/npm`. Lifecycle scripts are disabled during publishing. The build runs explicitly before publication.

### One-time publisher setup

The package already exists on npm. Do not bootstrap or republish any existing version.

1. Ensure the workflow is named `cd.yaml`, with a release job in the GitHub environment `npm`.
2. Log into npm interactively and configure the trusted publisher (npm 12 shown because older global CLIs may not support `trust`):

   ```sh
   npm login
   npx --yes npm@12 trust github @leocavalcante/pi-otel \
     --file cd.yaml --repo leocavalcante/pi-otel --env npm --allow-publish
   npx --yes npm@12 trust list @leocavalcante/pi-otel
   ```

3. Set npm publishing access to require 2FA and disallow tokens. Do not create an `NPM_TOKEN` secret.
4. The GitHub `npm` environment permits deployment from `main` only.
5. After the first release, verify the package version, provenance, and update notes:

   ```sh
   npm view @leocavalcante/pi-otel version dist.attestations
   ```

### Recovering a partial release

Check npm before retrying a failed release. semantic-release pushes the tag before publishing, so a normal re-run may consider that version released already.

- **The version is absent from npm:** investigate the failure. An administrator may delete only the failed release tag and re-run CD on `main` once publishing is fixed.
- **The version exists on npm:** do not delete its tag or try to republish it. npm versions are immutable. Verify provenance, restore any missing GitHub release from that tag, and release a new version for package fixes.
- **Publication succeeded but provenance is missing:** treat this as a release failure. Investigate OIDC and publish a new attested version; existing npm versions cannot be repaired by republishing.

The package was originally published from a maintainer machine without provenance. `v0.1.2` exists on GitHub but is not published to npm; its telemetry-runtime dependency fix ships in the next automated patch release.
