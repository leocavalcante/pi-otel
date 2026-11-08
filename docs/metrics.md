# Signal semantics

Native Pi units and names are preserved. Prometheus commonly translates dots to underscores and appends unit/type suffixes. Verify translation against your own receiver before copying queries.

| Signal | Kind/unit | Interpretation |
|---|---|---|
| `pi.ai.tokens` | counter, token | Live reported input/output/cache_read/cache_write |
| `pi.ai.cost` | counter, USD | Live Pi-reported cost, not invoiced spend |
| `pi.ai.request.duration` | histogram, ms | Durable native logical request, including provider/auth setup |
| `pi.ai.first_chunk.duration` | histogram, ms | First normalized event, not necessarily visible text |
| `pi.durable.phase.duration` | histogram, ms | Handler and decision commit, excluding durable waits/downtime |
| `pi.durable.tasks.active` | up/down counter | Native live task count |
| `pi.durable.reports` | counter | Native fixed report categories |
| `pi.otel.heartbeat` | gauge, s | Collection timestamp, not an independent health probe |
| `pi.otel.process.memory.rss` | gauge, By | Node process only, excluding browser/tool children |
| `pi.otel.tool.attempts` | counter | Durable run-mode call/execute phase invocations; coding terminal tool events |
| `pi.otel.tool.duration` | histogram, ms | Durable phase duration; coding actual execution duration when supplied |
| `pi.otel.recovered.phases` | counter | Native `resumed:true` invocations, not crash count |
| `pi.otel.export.errors` | counter | Fixed signal label: traces/metrics/logs |
| `pi.otel.usage.tokens` | gauge, token | Persisted model totals sampled through the existing Harness owner |
| `pi.otel.usage.cost` | gauge, USD | Persisted model cost sampled through that owner |
| `pi.coding.active` | gauge | Observer currently has a live run |
| `pi.coding.run.duration` | histogram, ms | Observed agent_start to agent_settled |
| `pi.coding.model.duration` | histogram, ms | Assistant-message lifecycle, not native provider request duration |
| `pi.coding.tool.results` | counter | Tool terminal result; outcome and executed metadata |

## Counters versus durable totals

Live counters start with the exporter process and can lose updates during failures. `observeDurable()` reads `Harness.usage(context)` initially and every 15 seconds, through the supplied owner only. It exports gauges, never adds old totals to new request counters. Failed refresh retains the last successful snapshot, so timestamps can be fresher than the underlying usage read. Removing the observer removes its snapshot.

The native persisted ledger remains authoritative. It can include failed and aborted attempts; forks start at zero. Tool usage is not re-added to model totals. Zero cost can mean unpriced/subscription usage.

To avoid counting old and new process instances simultaneously, use the latest instance or a per-service maximum for monotonically growing persisted totals. Do not sum persisted gauges across rolling restarts. These totals are not a complete historical billing ledger across pruning, resets or deleted conversations.

## Tools and recovery

Normal Durable `pi.tool` work executes the **call** handler and checkpoints into **execute** before returning. Execute is entered on recovery. Counting only execute misses ordinary calls. The addon counts run-mode call and execute attempts separately. They are not exactly-once external effects. A tool can return `isError:true` while its durable phase/task completes normally, so Durable phase outcome is not tool-result success.

Coding tool result events do expose `isError`. Missing `durationMs` means execution timing is unavailable, including pre-execution rejection. Interrupted open tool spans close as aborted and are not fabricated terminal result counts.

## Traces and logs

`pi.otel.lifecycle` records the adapter's actual start/stop, without a model request. Durable native spans: `pi.durable.submit`, `pi.durable.phase`, `pi.ai.request`, `pi.ai.poll`. Coding spans: `pi.coding.run`, `pi.coding.model`, `pi.coding.tool`. Coding's first message update is an event, not native first-token latency.

Submit is admission, not complete answer time. A recovered phase creates a new span with durable correlation; it does not reopen a finished span. W3C propagation is explicit, without baggage or automatic HTTP/A2A propagation. Logs contain fixed completion bodies and safe metadata with native trace IDs.

The adapter does not rename these to evolving GenAI conventions or silently convert milliseconds into seconds.
