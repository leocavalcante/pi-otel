# Changelog

## 0.1.2

Declare `@earendil-works/pi-telemetry` 1.5.0 as a runtime dependency instead of a peer/dev dependency so Pi installs load without manual symlinks. Add a regression test for the package and lockfile declarations.

## 0.1.1

Add explicit `otel.modelRuntime(runtime)` compatibility for SDK ModelRuntime 1.5.0, whose direct provider dispatch bypasses Pi AI's native request observer. Preserve the runtime's auth/configuration and request arguments while recording native-schema AI timing/tokens exactly once. Add real SDK-Harness and forwarding/privacy/pending-poll regression tests. Do not wrap an already-instrumented `createModels()` collection.

## 0.1.0

Initial source release: explicit Pi telemetry adapter, metadata-only OTLP/HTTP exports, coding-agent extension/SDK observer, optional existing-owner Durable usage snapshots, generic examples and privacy/conformance/integration tests.

Repository availability does not imply an npm registry publication or deployment to any environment.
