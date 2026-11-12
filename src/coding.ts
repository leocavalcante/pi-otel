import type { Meter } from "@opentelemetry/api";
import type {
  TelemetryContext,
  TelemetrySpan,
  SpanAttributes,
} from "@earendil-works/pi-telemetry";
import type { UsageValue } from "./index.ts";
import { pick } from "./privacy.ts";

/** Only fields read by the observer. Message content, args, results and errors are deliberately absent. */
export interface CodingEvent {
  type: string;
  message?: {
    role: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    usage?: UsageValue;
  };
  toolName?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  isError?: boolean;
  durationMs?: number;
  aborted?: boolean;
}
export interface CodingSource {
  subscribe(listener: (event: CodingEvent) => void): () => void;
}
type TelemetryContextWithMetrics = TelemetryContext & {
  readonly metrics: NonNullable<TelemetryContext["metrics"]>;
};

function active(
  parent: TelemetryContext,
  name: string,
  attributes: SpanAttributes = {},
) {
  let span!: TelemetrySpan;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  void parent
    .startSpan({ name, attributes }, (value) => {
      span = value;
      return completed;
    })
    .catch(() => undefined);
  let ended = false;
  return {
    span,
    started: performance.now(),
    end(attributes: SpanAttributes = {}) {
      if (ended) return;
      ended = true;
      span.setAttributes(attributes);
      finish();
    },
  };
}
export function codingObserver(
  telemetry: TelemetryContextWithMetrics,
  meter: Meter,
) {
  let run: ReturnType<typeof active> | undefined;
  let model: ReturnType<typeof active> | undefined;
  let first = false;
  const tools = new Map<string, ReturnType<typeof active>>();
  const tokens = telemetry.metrics.counter("pi.ai.tokens", { unit: "token" });
  const cost = telemetry.metrics.counter("pi.ai.cost", { unit: "USD" });
  const modelDuration = telemetry.metrics.histogram(
    "pi.coding.model.duration",
    { unit: "ms" },
  );
  const attempts = telemetry.metrics.counter("pi.otel.tool.attempts");
  const toolDuration = telemetry.metrics.histogram("pi.otel.tool.duration", {
    unit: "ms",
  });
  const outcomes = telemetry.metrics.counter("pi.coding.tool.results");
  const runDuration = telemetry.metrics.histogram("pi.coding.run.duration", {
    unit: "ms",
  });
  const live = meter.createObservableGauge("pi.coding.active");
  const callback = (result: { observe(value: number): void }) => {
    result.observe(run ? 1 : 0);
  };
  live.addCallback(callback);
  const settle = (aborted: boolean) => {
    for (const tool of tools.values()) tool.end({ outcome: "aborted" });
    tools.clear();
    model?.end({ stop: "aborted" });
    model = undefined;
    if (run) {
      const outcome = aborted ? "aborted" : "done";
      runDuration.record(performance.now() - run.started, { outcome });
      run.end({ outcome, aborted });
      run = undefined;
    }
  };
  return {
    handle(event: CodingEvent): void {
      try {
        if (event.type === "agent_start") {
          run ??= active(telemetry, "pi.coding.run");
          return;
        }
        if (event.type === "agent_settled") {
          settle(event.aborted === true);
          return;
        }
        if (
          event.type === "message_start" &&
          event.message?.role === "assistant"
        ) {
          model?.end({ stop: "aborted" });
          first = false;
          model = active(
            run?.span ?? telemetry,
            "pi.coding.model",
            pick(
              { provider: event.message.provider, model: event.message.model },
              ["provider", "model"],
            ),
          );
          return;
        }
        if (event.type === "message_update" && model && !first) {
          first = true;
          model.span.addEvent("pi.coding.first_event");
          return;
        }
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          const message = event.message;
          const labels = pick(
            { provider: message.provider, model: message.model },
            ["provider", "model"],
          );
          const stopReason = message.stopReason ?? "";
          const stop = [
            "stop",
            "length",
            "toolUse",
            "error",
            "aborted",
            "deferred",
            "pending",
          ].includes(stopReason)
            ? stopReason
            : "unknown";
          const usage = message.usage;
          if (usage) {
            for (const [kind, key] of [
              ["input", "input"],
              ["output", "output"],
              ["cache_read", "cacheRead"],
              ["cache_write", "cacheWrite"],
            ] as const) {
              if (Number.isFinite(usage[key]) && usage[key] >= 0)
                tokens.add(usage[key], { ...labels, kind });
            }
            // Events come from the Pi runtime, not from the type: a provider may omit cost.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data can lack the field.
            if (Number.isFinite(usage.cost?.total) && usage.cost.total >= 0)
              cost.add(usage.cost.total, labels);
          }
          if (model) {
            modelDuration.record(performance.now() - model.started, {
              ...labels,
              stop,
            });
            if (stop === "error")
              model.span.setStatus({
                status: "error",
                error: { name: "provider_error", message: "" },
              });
            model.end({ ...labels, stop });
            model = undefined;
          }
          return;
        }
        if (event.type === "tool_execution_start" && event.toolCallId) {
          const parent = event.parentToolCallId
            ? tools.get(event.parentToolCallId)?.span
            : undefined;
          tools.get(event.toolCallId)?.end({ outcome: "aborted" });
          tools.set(
            event.toolCallId,
            active(
              parent ?? run?.span ?? telemetry,
              "pi.coding.tool",
              pick(
                {
                  "tool.name": event.toolName,
                  "tool.call_id": event.toolCallId,
                },
                ["tool.name", "tool.call_id"],
              ),
            ),
          );
          return;
        }
        if (event.type === "tool_execution_end" && event.toolCallId) {
          const current = tools.get(event.toolCallId);
          const outcome = event.isError ? "error" : "done";
          const duration = event.durationMs;
          const executed =
            typeof duration === "number" && Number.isFinite(duration);
          const labels = pick(
            { tool: event.toolName, phase: "execute", outcome },
            ["tool", "phase", "outcome"],
          );
          attempts.add(1, labels);
          outcomes.add(1, {
            tool: labels.tool,
            outcome,
            executed,
          });
          if (executed) toolDuration.record(duration, labels);
          if (event.isError)
            current?.span.setStatus({
              status: "error",
              error: { name: "tool_error", message: "" },
            });
          current?.end({
            outcome,
            executed,
            duration_ms: duration,
          });
          tools.delete(event.toolCallId);
        }
      } catch {
        /* Observation never changes model, tools, prompts or hook decisions. */
      }
    },
    close() {
      settle(true);
      live.removeCallback(callback);
    },
  };
}
