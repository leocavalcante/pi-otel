# Design references

The supported baseline is Pi **v1.5.0**. Native Durable telemetry already emits phase/admission spans, events and metrics; the adapter implements its public contract rather than observing conversation storage or wrapping another agent loop.

- [Pi telemetry contract and conformance](https://github.com/earendil-works/pi/tree/v1.5.0/packages/telemetry)
- [Durable public API and specification](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable)
- [Pi AI telemetry](https://github.com/earendil-works/pi/tree/v1.5.0/packages/ai)
- [Coding-agent extension lifecycle](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/extensions.md)
- [Coding-agent SDK](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/sdk.md)
- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry JS](https://github.com/open-telemetry/opentelemetry-js)
- [GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)

## Compatibility

The dependency lock uses OpenTelemetry API 1.10.0, stable SDK 3.1.0 and HTTP exporters 0.301.0. The trace package for that family is `@opentelemetry/sdk-trace`, not the older incompatible `sdk-trace-base` family. Node 22 satisfies both Pi's and the SDK's requirements.

OTLP traces, metrics and logs are interoperable wire protocols. GenAI naming conventions are still evolving; this project preserves Pi names and units instead of claiming a stable semantic mapping.

## Important distinctions

- Callback admission is synchronous and exactly once, but tool effects are not exactly once.
- Explicit callback context, not a global current-span singleton, determines parentage.
- Last explicit status wins; recording calls after settlement are inert.
- Native error text can contain user/provider data even if truncated. Export must drop it.
- Durable local usage accounting is stronger than best-effort exported counters.
- Coding hooks expose a message lifecycle, not all native provider request internals.
- SDK ModelRuntime 1.5.0 directly calls provider streams, bypassing the native `Models` AI observer. A real SDK-Harness regression produced zero AI spans for two faux requests before the explicit compatibility facade; with it, two spans and two duration observations are recorded. This is a distinction between request paths on the same release, not evidence of a regression between releases.
- Conversation watching is UI state, not a replay-safe usage ledger.
- A collector protocol fixture alone does not establish real Pi integration. The test suite also runs the actual Durable and coding-agent runtimes with faux providers and harmless tools.

No deployment topology, private environment, credentials or operational state is required by the public implementation.
