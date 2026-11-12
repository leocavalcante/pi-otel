# pi-otel

Export metadata-only OpenTelemetry from Pi coding-agent sessions and Pi Durable agents.

[![npm](https://img.shields.io/npm/v/@leocavalcante/pi-otel)](https://www.npmjs.com/package/@leocavalcante/pi-otel) [![CD](https://github.com/leocavalcante/pi-otel/actions/workflows/cd.yaml/badge.svg)](https://github.com/leocavalcante/pi-otel/actions/workflows/cd.yaml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/leocavalcante/pi-otel/blob/main/LICENSE)

pi-otel sends traces, metrics, and logs about model calls, timing, and tool activity to your own OpenTelemetry collector. Each agent run becomes a `pi.coding.run` span with `pi.coding.model` and `pi.coding.tool` children, plus token and cost counters per provider and model. pi-otel exports metadata only: it never exports prompts, answers, tool arguments, or tool results.

## Contents

- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Compatibility](#compatibility)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Installation

```sh
pi install npm:@leocavalcante/pi-otel
```

Then run `/reload` in Pi, or start a new session. pi-otel stays inactive until you set an OTLP endpoint, so start Pi with one:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=pi-coding-agent pi
```

You need an OTLP/HTTP receiver, usually an [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/). To try pi-otel once without adding it to your settings, run `pi -e npm:@leocavalcante/pi-otel`.

To follow unreleased changes, install from GitHub instead:

```sh
pi install git:github.com/leocavalcante/pi-otel
```

Git installations track `main` and report version `0.0.0-development`, so Pi doesn't show release notes for them. Remove either installation with `pi remove` and the same source.

## Usage

### In Pi

The extension observes lifecycle events, never changes prompts or tools, and flushes its data when the session shuts down.

| Signal                                       | What it records                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| `pi.coding.run` span                         | One agent run, from `agent_start` to `agent_settled`                    |
| `pi.coding.model` span                       | One assistant message, from `message_start` to `message_end`            |
| `pi.coding.tool` span                        | One tool execution, nested under its parent tool call when there is one |
| `pi.ai.tokens`, `pi.ai.cost` counters        | Reported input, output, and cache tokens, and reported cost             |
| `pi.coding.tool.results` counter             | Each tool result, with its outcome and whether it ran                   |
| `pi.coding.run.duration` and more histograms | Run, model, and tool durations                                          |
| Completion logs                              | One fixed-text log per finished span, correlated with its trace         |

Model spans cover the assistant-message lifecycle, not the provider request, which the extension can't observe. That's why they're named `pi.coding.model` rather than `pi.ai.request`. Their first event isn't necessarily the first visible text.

See [signal semantics](https://github.com/leocavalcante/pi-otel/blob/main/docs/metrics.md) for every signal, unit, and how to interpret it.

### In Pi Durable and SDK applications

```sh
npm install @leocavalcante/pi-otel
```

Pass pi-otel's telemetry to your existing Harness owner:

```ts
import { createPiOtel } from "@leocavalcante/pi-otel";

const otel = createPiOtel({
  serviceName: "my-agent",
  serviceNamespace: "agents",
});
const harness = await Harness.open(
  storage,
  { models, registry, telemetry: otel.telemetry },
  context,
);

// Optional: sample persisted usage totals through this owner.
await otel.observeDurable(harness, context);

// During shutdown, stop accepting requests, then close the owner before pi-otel.
await harness.close(context);
await otel.shutdown();
```

See the [model-free Durable example](https://github.com/leocavalcante/pi-otel/blob/main/examples/durable.ts). For coding-agent SDK sessions, call `otel.observeCodingAgent(session)` instead of installing the extension, never both for the same session. The function it returns unsubscribes. Neither path sees work that happened before you attached it.

`createPiOtel()` returns:

| Member                             | Purpose                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `telemetry`                        | The telemetry context to pass to a Harness                                 |
| `modelRuntime(runtime)`            | Wraps an SDK ModelRuntime 1.5.0 so its requests are measured (see below)   |
| `observeDurable(harness, context)` | Samples `harness.usage(context)` every 15 seconds; returns a stop function |
| `observeCodingAgent(session)`      | Observes a coding-agent SDK session; returns an unsubscribe function       |
| `codingObserver()`                 | The metadata-only event observer that the extension uses                   |
| `forceFlush()`, `shutdown()`       | Resolve to `false` when export was incomplete, instead of throwing         |

Your application keeps owning its providers and lifecycle: pi-otel installs no global OpenTelemetry provider or context manager. Configuration errors fail immediately, with messages that contain no sensitive input.

**SDK ModelRuntime 1.5.0.** That runtime sends requests straight to providers, bypassing the instrumented `Models` path. With only `telemetry` passed, Durable phases are recorded but AI request latency and tokens are not. Pass `models: otel.modelRuntime(runtime)` to the same Harness, and wrap it once. Don't wrap `createModels()`, which already emits AI telemetry, or a newer runtime you haven't verified. The wrapper forwards every call unchanged, makes exactly one underlying call per request, and adds no retries or credential handling. Pending deferred polls record timing but not token or cost usage.

**Usage isn't billing.** Pi's persisted `pi.usage` stays the authoritative record for Durable accounting. Pi-reported cost in USD isn't an invoice, and zero can mean an unpriced or subscription model. Task admission isn't answer latency, and a successful tool phase doesn't mean the tool's external effect succeeded.

### Collector and dashboard examples

- [`examples/collector.yaml`](https://github.com/leocavalcante/pi-otel/blob/main/examples/collector.yaml) prints a summary of the signals it receives.
- [`examples/grafana/pi-agents.json`](https://github.com/leocavalcante/pi-otel/blob/main/examples/grafana/pi-agents.json) is a Grafana dashboard that expects a Prometheus data source with standard OTLP metric-name translation.

Neither example installs a backend or opens a public listener.

## Configuration

pi-otel sends OTLP as JSON over HTTP or HTTPS, with one exporter per signal. It reads the standard OpenTelemetry environment variables:

| Variable                                            | Description                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                       | Base URL. pi-otel appends `/v1/traces`, `/v1/metrics`, and `/v1/logs`. Required in Pi. |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Full URL for one signal. Overrides the base URL.                                       |
| `OTEL_EXPORTER_OTLP_HEADERS`                        | Authentication headers. They stay transport configuration, never attributes.           |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_HEADERS`  | Headers for one signal.                                                                |
| `OTEL_SERVICE_NAME`                                 | Service name. Defaults to `pi-coding-agent` in Pi and `pi-agent` in the SDK.           |
| `OTEL_RESOURCE_ATTRIBUTES`                          | Only `service.namespace` and `service.version` are kept.                               |
| `OTEL_METRIC_EXPORT_INTERVAL`                       | Metric export interval in milliseconds. Default 15000; minimum 1000.                   |
| `OTEL_SDK_DISABLED`                                 | Set to `true` to turn pi-otel off.                                                     |

In the SDK, the `endpoint`, `serviceName`, `serviceNamespace`, and `serviceVersion` options override the base environment variables; per-signal endpoints still win.

- **Endpoints.** URLs with embedded credentials, query strings, or fragments are rejected. Use HTTPS with normal certificate verification for remote receivers.
- **Limits.** Batch queues hold up to 512 spans and 512 logs, and each export has a 5-second deadline. Crashes, queue pressure, network failures, and shutdown can lose telemetry.
- **Export errors.** Failed exports are counted in `pi.otel.export.errors`, which you see once metrics reach the receiver again. pi-otel never prints backend or authentication details.

## Compatibility

Requires Pi 1.5.0 or newer and Node.js 22.19 or newer. Tested with Pi 1.5.2 on Linux, macOS, and Windows; CI also tests Pi 1.5.0 and checks the latest Pi release every week.

- Trace context propagates through explicit W3C `traceparent` and `tracestate` values, including links. pi-otel adds no baggage and doesn't propagate context over transports such as HTTP or A2A on its own.
- Durable tool phases report phase outcomes, not tool-result success.
- Recovery after a process crash isn't covered by tests.

## Privacy and security

pi-otel exports metadata only. It never exports prompts, answers, reasoning, attachments, tool arguments or results, file contents, credentials, headers, exception messages or stack traces, or free-form error text. There's no switch to capture content.

- **Allowlists.** Every span, event, and metric field is checked against a fixed allowlist when exported. Unknown span names become `pi.operation`, and unknown attributes, events, and metrics are dropped.
- **Remaining metadata.** Service, provider, model, and tool names, operational IDs, and usage and timing numbers are still exported, and they can reveal activity. Choose names that aren't sensitive, control who can read your collector, and set its retention.
- **Scope.** This policy covers what pi-otel sends. It doesn't scan for secrets or sanitize other applications that send to your collector.

Tests inject synthetic private markers into prompts, model output, tool arguments and results, and errors, then inspect the actual HTTP bodies. See the full [privacy boundary](https://github.com/leocavalcante/pi-otel/blob/main/docs/privacy.md). To report a vulnerability, see [SECURITY.md](https://github.com/leocavalcante/pi-otel/blob/main/SECURITY.md).

## Troubleshooting

- **Nothing reaches the collector.** Pi must start with `OTEL_EXPORTER_OTLP_ENDPOINT` already set, and `OTEL_SDK_DISABLED` must not be `true`. Run `/reload` after changing either, and check that the receiver accepts OTLP over HTTP.
- **Metrics appear but traces or logs don't.** Check the per-signal endpoint variables: a per-signal URL replaces the base URL and its `/v1/...` suffix.
- **Some exports were lost.** Watch the `pi.otel.export.errors` counter, which is labeled by signal.

## Contributing

See [CONTRIBUTING.md](https://github.com/leocavalcante/pi-otel/blob/main/CONTRIBUTING.md) for development setup, checks, and how releases work. Design notes are in [research.md](https://github.com/leocavalcante/pi-otel/blob/main/docs/research.md).

## License

MIT. See [LICENSE](https://github.com/leocavalcante/pi-otel/blob/main/LICENSE).
