import {
  lazyStream,
  AI_TELEMETRY_SCHEMA,
  type AssistantMessageEventStream,
  type Models,
  type Model,
  type Api,
  type LazyStreamObserver,
} from "@earendil-works/pi-ai";
import {
  createTypedMetrics,
  defineTelemetrySchema,
  NOOP_TELEMETRY_METRICS,
  type TelemetryContext,
  type TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { modelsFacade } from "./models-facade.ts";
import {
  RESPONSE_MODEL,
  responseModelAttributes,
  type ResponseModelPolicy,
} from "./privacy.ts";

const responseModel = {
  type: "string",
  description: "Allowlisted provider-reported model identifier.",
  required: false,
} as const;
const piMetrics = AI_TELEMETRY_SCHEMA.metrics;
const {
  "pi.ai.request.duration": duration,
  "pi.ai.tokens": tokens,
  "pi.ai.cost": cost,
} = piMetrics;
const COMPLETION_SCHEMA = defineTelemetrySchema({
  ...AI_TELEMETRY_SCHEMA,
  metrics: {
    ...piMetrics,
    "pi.ai.request.duration": {
      ...duration,
      attributes: { ...duration.attributes, [RESPONSE_MODEL]: responseModel },
    },
    "pi.ai.tokens": {
      ...tokens,
      attributes: { ...tokens.attributes, [RESPONSE_MODEL]: responseModel },
    },
    "pi.ai.cost": {
      ...cost,
      attributes: { ...cost.attributes, [RESPONSE_MODEL]: responseModel },
    },
  },
});

/** Pi 1.5.0 ModelRuntime dispatches directly to providers, bypassing Models' native AI observer. */
function observer(
  model: Model<Api>,
  context: TelemetryContext,
  reasoning: unknown,
  poll: boolean,
  policy?: ResponseModelPolicy,
): LazyStreamObserver {
  const started = performance.now();
  const labels = { provider: model.provider, model: model.id };
  const metrics = createTypedMetrics(
    context.metrics ?? NOOP_TELEMETRY_METRICS,
    [COMPLETION_SCHEMA],
  );
  const duration = metrics.histogram("pi.ai.request.duration");
  const firstDuration = metrics.histogram("pi.ai.first_chunk.duration");
  const tokens = metrics.counter("pi.ai.tokens");
  const cost = metrics.counter("pi.ai.cost");
  let span: TelemetrySpan | undefined;
  let finish!: () => void;
  let first = true;
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const toolChars = new Map<number, number>();
  try {
    void context
      .startSpan(
        {
          name: poll ? "pi.ai.poll" : "pi.ai.request",
          attributes: {
            ...labels,
            api: model.api,
            ...(typeof reasoning === "string" ? { reasoning } : {}),
          },
        },
        (active) => {
          span = active;
          return completed;
        },
      )
      .catch(() => undefined);
  } catch {
    /* Recording must not prevent request admission. */
  }
  return {
    onEvent(event) {
      try {
        if (first) {
          first = false;
          span?.addEvent("pi.ai.first_chunk");
          firstDuration.record(performance.now() - started, labels, span);
        }
        if (event.type === "toolcall_delta")
          toolChars.set(
            event.contentIndex,
            (toolChars.get(event.contentIndex) ?? 0) + event.delta.length,
          );
        else if (event.type === "text_end" || event.type === "thinking_end")
          span?.addEvent("pi.ai.block", {
            type: event.type === "text_end" ? "text" : "thinking",
            index: event.contentIndex,
            chars: event.content.length,
          });
        else if (event.type === "toolcall_end") {
          span?.addEvent("pi.ai.block", {
            type: "tool_call",
            index: event.contentIndex,
            chars: toolChars.get(event.contentIndex) ?? 0,
            tool: event.toolCall.name,
          });
          toolChars.delete(event.contentIndex);
        }
      } catch {
        /* Native lazyStream observers must never throw into forwarding. */
      }
    },
    onResult(message) {
      try {
        if (!message) return;
        const response = responseModelAttributes(
          policy,
          labels.provider,
          labels.model,
          message.responseModel,
        );
        const completedLabels = { ...labels, ...response };
        span?.setAttributes({
          ...response,
          stop: message.stopReason,
          "usage.input": message.usage.input,
          "usage.output": message.usage.output,
          "usage.cache_read": message.usage.cacheRead,
          "usage.cache_write": message.usage.cacheWrite,
          "cost.total": message.usage.cost.total,
        });
        if (message.stopReason === "error")
          span?.setStatus({
            status: "error",
            error: { name: "provider_error", message: "" },
          });
        duration.record(
          performance.now() - started,
          { ...completedLabels, stop: message.stopReason },
          span,
        );
        if (
          !poll ||
          (message.stopReason !== "pending" &&
            message.stopReason !== "deferred")
        ) {
          for (const [kind, key] of [
            ["input", "input"],
            ["output", "output"],
            ["cache_read", "cacheRead"],
            ["cache_write", "cacheWrite"],
          ] as const)
            tokens.add(message.usage[key], { ...completedLabels, kind });
          cost.add(message.usage.cost.total, completedLabels);
        }
      } catch {
        /* Usage observation is not the durable accounting ledger. */
      } finally {
        toolChars.clear();
        finish();
      }
    },
  };
}

/**
 * Explicit compatibility opt-in for SDK ModelRuntime 1.5.0 only.
 * All auth/catalog/configuration and request arguments remain with that same runtime.
 * Do not wrap createModels(), which already emits native request telemetry.
 */
export function withModelRuntimeTelemetry<T extends Models>(
  runtime: T,
  telemetry: TelemetryContext,
  policy?: ResponseModelPolicy,
): T {
  // Forward each call exactly as received: every argument, the runtime as the
  // receiver, and one lazy underlying call. Telemetry setup can never block it.
  const forward = (
    model: Model<Api>,
    options: { readonly telemetry?: TelemetrySpan } | undefined,
    poll: boolean,
    setup: () => AssistantMessageEventStream,
  ) => {
    let observation: LazyStreamObserver | undefined;
    try {
      observation = observer(
        model,
        options?.telemetry ?? telemetry,
        options && "reasoning" in options ? options.reasoning : undefined,
        poll,
        policy,
      );
    } catch {
      /* Observer setup must never affect request forwarding. */
    }
    return lazyStream(
      model,
      () =>
        new Promise<AssistantMessageEventStream>((resolve) => {
          resolve(setup());
        }),
      observation,
    );
  };
  const stream: Models["stream"] = (...args) =>
    forward(args[0], args[2], false, () => runtime.stream(...args));
  const streamSimple: Models["streamSimple"] = (...args) =>
    forward(args[0], args[2], false, () => runtime.streamSimple(...args));
  const streamDeferred: Models["streamDeferred"] = (...args) =>
    forward(args[0], args[2], true, () => runtime.streamDeferred(...args));
  const complete: Models["complete"] = (...args) => stream(...args).result();
  const completeSimple: Models["completeSimple"] = (...args) =>
    streamSimple(...args).result();
  const fetchDeferred: Models["fetchDeferred"] = (...args) =>
    streamDeferred(...args).result();
  return modelsFacade(runtime, {
    stream,
    streamSimple,
    streamDeferred,
    complete,
    completeSimple,
    fetchDeferred,
  });
}
