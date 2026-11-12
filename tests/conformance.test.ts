import { test } from "bun:test";
import {
  TracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import {
  trace,
  type Meter,
  type SpanContext,
  type Attributes,
} from "@opentelemetry/api";
import { createTelemetryAdapterConformance } from "@earendil-works/pi-telemetry/testing";
import type {
  RecordedTelemetrySpan,
  RecordedTelemetryMeasurement,
} from "@earendil-works/pi-telemetry";
import { OtelAdapter } from "../src/adapter.ts";

const carrier = (context: SpanContext | undefined) =>
  context
    ? {
        traceparent: `00-${context.traceId}-${context.spanId}-${(context.traceFlags & 255).toString(16).padStart(2, "0")}`,
        ...(context.traceState?.serialize()
          ? { tracestate: context.traceState.serialize() }
          : {}),
      }
    : null;
const detached = <T>(value: T): T => structuredClone(value);
const cases = createTelemetryAdapterConformance(async () => {
  const spans: ReadableSpan[] = [];
  const ended = new Map<ReadableSpan, number>();
  const processor: SpanProcessor = {
    onStart: (span) => {
      spans.push(span);
    },
    onEnd: (span) => {
      ended.set(span, ended.size + 1);
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = new TracerProvider({ spanProcessors: [processor] });
  const measurements: RecordedTelemetryMeasurement[] = [];
  const instrument = (
    kind: RecordedTelemetryMeasurement["kind"],
    name: string,
    options: Record<string, any> = {},
  ) => {
    const metadata = detached(options);
    const record = (
      value: number,
      attributes: Attributes = {},
      context?: any,
    ) =>
      measurements.push({
        kind,
        name,
        value,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.unit ? { unit: metadata.unit } : {}),
        ...(metadata.advice?.explicitBucketBoundaries
          ? { boundaries: metadata.advice.explicitBucketBoundaries }
          : {}),
        attributes: detached(attributes) as any,
        context: carrier(context && trace.getSpanContext(context)),
      });
    return { add: record, record };
  };
  const meter = {
    createCounter: (name: string, options: any) =>
      instrument("counter", name, options),
    createUpDownCounter: (name: string, options: any) =>
      instrument("upDownCounter", name, options),
    createHistogram: (name: string, options: any) =>
      instrument("histogram", name, options),
  } as unknown as Meter;
  const adapter = new OtelAdapter({
    tracer: provider.getTracer("conformance"),
    meter,
  });
  return {
    context: adapter,
    metrics: adapter.metrics,
    propagation: adapter.propagation,
    getMetrics: async () => detached(measurements),
    getSpans: async (): Promise<RecordedTelemetrySpan[]> =>
      spans.map((span, index) => {
        const parent = span.parentSpanContext;
        const local = parent
          ? spans.findIndex(
              (candidate) =>
                candidate.spanContext().spanId === parent.spanId &&
                candidate.spanContext().traceId === parent.traceId,
            )
          : -1;
        return {
          id: index + 1,
          parentId: local < 0 ? null : local + 1,
          name: span.name,
          context: carrier(span.spanContext())!,
          parentContext: carrier(parent),
          attributes: detached(span.attributes) as any,
          events: span.events.map((event) => ({
            name: event.name,
            attributes: detached(event.attributes ?? {}) as any,
          })),
          links: span.links.map((link) => ({
            context: carrier(link.context)!,
            attributes: detached(link.attributes ?? {}) as any,
          })),
          status: adapter.statuses.get(span) ?? { status: "ok" },
          settled: ended.has(span),
          endSequence: ended.get(span),
        };
      }),
    async [Symbol.asyncDispose]() {
      await provider.shutdown();
    },
  };
});
for (const current of cases)
  test(`Pi contract: ${current.group}: ${current.name}`, () => current.run());
