import type { Attributes } from "@opentelemetry/api";
import type { SpanAttributes } from "@earendil-works/pi-telemetry";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

const commonModel = [
  "provider",
  "model",
  "api",
  "reasoning",
  "stop",
  "usage.input",
  "usage.output",
  "usage.cache_read",
  "usage.cache_write",
  "cost.total",
];
const phase = [
  "task.id",
  "task.name",
  "phase",
  "kind",
  "attempt",
  "resumed",
  "outcome",
  "tool.name",
  "tool.call_id",
];
const coding = [
  "tool.name",
  "tool.call_id",
  "outcome",
  "duration_ms",
  "executed",
  "aborted",
  "provider",
  "model",
  "stop",
];
export const SPANS: Record<string, readonly string[]> = {
  "pi.otel.lifecycle": ["event"],
  "pi.durable.submit": [
    "submission.type",
    "conversation.id",
    "submission.id",
    "result",
  ],
  "pi.durable.phase": phase,
  "pi.ai.request": commonModel,
  "pi.ai.poll": commonModel,
  "pi.coding.run": coding,
  "pi.coding.model": [...commonModel, ...coding],
  "pi.coding.tool": coding,
};
const EVENTS: Record<string, readonly string[]> = {
  "pi.durable.entry": ["entry.id", "entry.kind"],
  "pi.durable.submission": ["submission.id", "status", "answer.entry_id"],
  "pi.durable.report": ["type", "reason", "extension", "task.id"],
  "pi.durable.checkpoint": ["phase"],
  "pi.durable.replay": ["tool.name"],
  "pi.ai.first_chunk": [],
  "pi.ai.block": ["type", "index", "chars", "tool"],
  "pi.coding.first_event": [],
};
const METRICS: Record<string, readonly string[]> = {
  "pi.ai.tokens": ["provider", "model", "kind"],
  "pi.ai.cost": ["provider", "model"],
  "pi.ai.request.duration": ["provider", "model", "stop"],
  "pi.ai.first_chunk.duration": ["provider", "model"],
  "pi.durable.phase.duration": ["task", "phase", "outcome"],
  "pi.durable.tasks.active": ["task"],
  "pi.durable.reports": ["type"],
  "pi.otel.tool.attempts": ["tool", "phase", "outcome"],
  "pi.otel.tool.duration": ["tool", "phase", "outcome"],
  "pi.otel.recovered.phases": ["task"],
  "pi.otel.export.errors": ["signal"],
  "pi.otel.usage.read.errors": [],
  "pi.coding.model.duration": ["provider", "model", "stop"],
  "pi.coding.tool.results": ["tool", "outcome", "executed"],
  "pi.coding.run.duration": ["outcome"],
};
function valueSafe(value: unknown): value is string | number | boolean {
  return (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= 128 &&
      /^[\w.:/@+\-=]+$/.test(value) &&
      !/^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|tskey-|eyJ)/.test(value))
  );
}
export type Metadata = Record<string, string | number | boolean>;
export function pick(
  attributes: Record<string, unknown> = {},
  allowed: readonly string[],
): Metadata {
  return Object.fromEntries(
    allowed.flatMap((key) =>
      valueSafe(attributes[key]) ? [[key, attributes[key]]] : [],
    ),
  ) as Metadata;
}
export function metricAttributes(
  name: string,
  attributes: SpanAttributes,
): SpanAttributes | undefined {
  return METRICS[name] ? pick(attributes, METRICS[name]) : undefined;
}
export function eventAttributes(
  name: string,
  attributes: Record<string, unknown>,
): Attributes | undefined {
  return EVENTS[name] ? pick(attributes, EVENTS[name]) : undefined;
}
export function errorCategory(name?: string): string {
  return [
    "provider_error",
    "task_faulted",
    "task_failed",
    "task_orphaned",
    "tool_error",
  ].includes(name ?? "")
    ? name!
    : "operation_error";
}
export function safeSpan(span: ReadableSpan): ReadableSpan {
  const allowed = SPANS[span.name];
  const category =
    typeof span.attributes["error.type"] === "string"
      ? errorCategory(span.attributes["error.type"])
      : undefined;
  return {
    ...span,
    name: allowed ? span.name : "pi.operation",
    spanContext: () => span.spanContext(),
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    kind: span.kind,
    attributes: {
      ...pick(span.attributes, allowed ?? []),
      ...(category ? { "error.type": category } : {}),
    },
    status: { code: span.status.code }, // Never export the description, exception message or stack.
    events: span.events.flatMap((event) => {
      const attributes = eventAttributes(event.name, event.attributes ?? {});
      return attributes ? [{ ...event, attributes }] : [];
    }),
    links: span.links.map((link) => ({ ...link, attributes: {} })),
  };
}
