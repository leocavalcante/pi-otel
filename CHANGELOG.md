# Changelog

## 0.1.1

Add explicit `otel.modelRuntime(runtime)` compatibility for SDK ModelRuntime 1.5.0, whose direct provider dispatch bypasses Pi AI's native request observer. Preserve the runtime's auth/configuration and request arguments while recording native-schema AI timing/tokens exactly once. Add real SDK-Harness and forwarding/privacy/pending-poll regression tests. Do not wrap an already-instrumented `createModels()` collection.

## 0.1.0

Initial source release: explicit Pi telemetry adapter, metadata-only OTLP/HTTP exports, coding-agent extension/SDK observer, optional existing-owner Durable usage snapshots, generic examples and privacy/conformance/integration tests.

Repository availability does not imply an npm registry publication or deployment to any environment.
