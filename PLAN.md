# Scope and acceptance

## Problem

Pi supplies backend-neutral telemetry and coding lifecycle events, but applications need a reusable exporter without adding another inference owner or exposing conversation content.

## Delivered scope

- Explicit Pi telemetry adapter with OTLP/HTTP providers owned by the host.
- Metadata-only coding-agent extension and SDK observer.
- Native metric semantics, optional existing-owner usage snapshots, bounded export and lifecycle cleanup.
- Export-time allowlists, error-text suppression, conformance and real faux-model integration tests.
- Generic examples and documentation without deployment-specific configuration.

Run `npm run check`, `npm test`, `npm run build` and `npm pack --dry-run` on Node 22 to inspect the observable checks.

## Boundaries

No agent framework, storage migration, credential gateway, shared inference loop, mandatory approval policy, backend installation, account provisioning or npm publication. The project does not read transcripts or deploy agents. Collector availability and application adoption require separate verification by each operator.

## Deferred, not implemented

- Authenticated transport-specific trace propagation.
- Durable tool-result outcomes distinct from phase outcomes.
- Restart-correct end-to-end queue/submission latency.
- Process-crash recovery tests and wider version compatibility.
- Automated OIDC releases (0.1.0 was interactively bootstrapped).
