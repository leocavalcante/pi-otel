# pi-otel

Metadata-only OpenTelemetry for [Pi Durable](https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable) and [Pi coding-agent](https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent).

Export model usage, timing, tool activity and lifecycle traces through OTLP/HTTP to your own collector. No replacement agent loop, tools, global OpenTelemetry registration, automatic HTTP instrumentation, transcript watcher or log scraping.

## Requirements

- Node.js 22.19 or newer.
- Tested against Pi **1.5.0**. Other Pi versions are not verified.
- An OTLP/HTTP receiver, normally an OpenTelemetry Collector.

This is an early **0.1.1** project. The npm package is `@leocavalcante/pi-otel`.

## Pi coding-agent

Install the package through Pi:

```sh
pi install npm:@leocavalcante/pi-otel
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  OTEL_SERVICE_NAME=pi-coding-agent pi
```

To track source instead, use `pi install git:github.com/leocavalcante/pi-otel`.

The extension is inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly set. It observes lifecycle events, never changes prompts or tools, and flushes on `session_shutdown`. Set `OTEL_SDK_DISABLED=true` to disable it.

Coding-agent model spans measure the assistant-message lifecycle. They are named **`pi.coding.model`**, not native `pi.ai.request`, because the extension cannot observe the exact provider-request boundary. First-event timing is not guaranteed to be first visible text.

## Durable and SDK applications

Install the SDK with `npm install @leocavalcante/pi-otel`. To build from source:

```sh
git clone https://github.com/leocavalcante/pi-otel.git
cd pi-otel
npm ci --ignore-scripts
npm run build
```

Another application can install that built directory with `npm install /path/to/pi-otel --ignore-scripts`.

Pass telemetry to your **existing** Harness owner:

```ts
import { createPiOtel } from '@leocavalcante/pi-otel';

const otel = createPiOtel({ serviceName: 'my-agent', serviceNamespace: 'agents' });
const harness = await Harness.open(storage, {
  models,
  registry,
  telemetry: otel.telemetry,
}, context);

// Optional: sample durable totals through this owner. Does not open another Harness.
await otel.observeDurable(harness, context);

// Existing application startup, submission and server lifecycle stay unchanged.
// During shutdown, stop accepting requests before closing the owner:
await harness.close(context);
await otel.shutdown();
```

See a complete [model-free Durable example](examples/durable.ts). For coding-agent SDK sessions, call `otel.observeCodingAgent(session)` instead of installing the extension. Do not enable both for the same session. The returned function unsubscribes. Neither path observes work that happened before attachment.

### SDK ModelRuntime 1.5.0 compatibility

That SDK runtime dispatches directly to providers instead of Pi AI's instrumented `Models` request path. Passing only `HarnessOptions.telemetry` therefore records Durable phases but misses AI request latency/tokens. If your Durable application uses **ModelRuntime 1.5.0**, pass `models: otel.modelRuntime(runtime)` to the same existing Harness. Wrap once. Do **not** wrap `createModels()`, which already emits native AI telemetry, or an unverified newer runtime.

The compatibility facade uses Pi's public `lazyStream` observer and `AI_TELEMETRY_SCHEMA`. Catalog/auth/configuration methods stay bound to the original runtime. Model/context/options (including signal and auth overrides) are forwarded unchanged, one underlying call per request. Events and result objects are not replaced; no request retries or credential handling are added. Deferred pending polls record timing but not token/cost consumption.

The returned object exposes `telemetry`, `modelRuntime`, `observeDurable`, `observeCodingAgent`, `codingObserver`, `forceFlush()` and `shutdown()`. Flush/shutdown resolve to `false` on incomplete export rather than throwing backend failures into agent work. Configuration errors fail immediately with non-sensitive messages. Providers and lifecycle remain owned by the caller; no global API provider or ambient context manager is installed.

## Configuration

OTLP uses JSON over HTTP(S). Each signal has its own exporter. Standard SDK environment variables include:

| Variable | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL; `/v1/traces`, `/v1/metrics`, `/v1/logs` are appended |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Complete per-signal URL; overrides the base |
| `OTEL_EXPORTER_OTLP_HEADERS` | Authentication headers, handled by upstream exporters; never attributes |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS` | Per-signal header override |
| `OTEL_SERVICE_NAME` | Non-sensitive service identifier |
| `OTEL_RESOURCE_ATTRIBUTES` | Only `service.namespace` and `service.version` are retained |
| `OTEL_METRIC_EXPORT_INTERVAL` | Milliseconds; default 15000, minimum 1000 |
| `OTEL_SDK_DISABLED` | `true` disables export |

Factory `endpoint`, `serviceName`, `serviceNamespace` and `serviceVersion` options override their base environment defaults. Per-signal endpoint variables still take precedence. Embedded URL credentials, query parameters and fragments are rejected. For remote receivers use normally verified HTTPS; never disable certificate verification.

Batch queues are bounded to 512 spans/logs. Exports have a five-second deadline. Telemetry can be lost during crashes, queue pressure, network failures or shutdown. Export errors appear in `pi.otel.export.errors` if metrics subsequently reach the receiver; they are not printed with backend/auth details.

## What you get

- Durable's native `pi.ai.*` and `pi.durable.*` spans, events and metric names/units.
- Coding-agent run/model/tool spans, reported token/cost counters and tool-result metadata.
- Heartbeat, Node RSS, Durable tool-phase attempts, phase timing and resumed-phase counts.
- Optional persistent usage gauges from `harness.usage(context)`, separate from live counters. Restarts do not replay old totals as new token consumption.
- Fixed-body completion logs correlated with trace IDs.
- Explicit W3C `traceparent` / `tracestate` propagation, including links. No baggage by default, and no automatic transport or A2A propagation.

See [metric semantics](docs/metrics.md), [privacy boundaries](docs/privacy.md) and [design references](docs/research.md). A [collector example](examples/collector.yaml) prints basic signal summaries; a [Grafana dashboard](examples/grafana/pi-agents.json) expects a Prometheus data source with standard OTLP metric-name translation. Neither installs a backend or opens a public listener.

**Usage is not billing.** Pi's persisted `pi.usage` remains authoritative for Durable accounting. Pi-reported USD is not an invoice; zero may mean an unpriced or subscription model. Task admission is not answer latency; successful tool phases do not imply successful external effects.

## Privacy

Prompts, answers, reasoning, attachments, tool arguments/results, filesystem contents, credentials, headers, exception messages/stacks and free-form error descriptions are not exported. Export uses fixed schema allowlists; unknown span names are replaced and unknown attributes/events/metrics are dropped. There is no content-capture switch.

Service/provider/model/tool identifiers and trace metadata are still metadata. Choose non-sensitive names. This policy is not a general secret scanner or a sanitizer for other applications sending to your collector. Public examples and tests use synthetic data only.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm pack --dry-run
```

Tests include Pi's public adapter conformance suite, actual OTLP payload privacy checks, collector failure isolation, persistent-usage sampling, real Durable Harnesses with both native Models and SDK ModelRuntime faux-model tools, forwarding/result-identity and deferred-poll checks, and an actual coding-agent SDK extension lifecycle. They do not use paid models or production state. No process-crash recovery or arbitrary Pi-version compatibility claim is made.

MIT licensed. npm publication and releases are separate from repository availability.
