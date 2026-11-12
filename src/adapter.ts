import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  isSpanContextValid,
  defaultTextMapGetter,
  defaultTextMapSetter,
  type Context,
  type Attributes,
  type Tracer,
  type Meter,
  type Span as NativeSpan,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import type {
  TelemetryContext,
  TelemetrySpan,
  TelemetryMetrics,
  TelemetryCarrier,
  SpanOptions,
  SpanAttributes,
  SpanStatus,
  SpanLink,
  HistogramOptions,
  InstrumentOptions,
  AttributeValue,
} from "@earendil-works/pi-telemetry";

export interface Completion {
  name: string;
  attributes: SpanAttributes;
  status: SpanStatus;
  duration: number;
  context: Context;
  native: NativeSpan;
}
export interface AdapterOptions {
  tracer: Tracer;
  meter: Meter;
  onEnd?: (value: Completion) => void;
  onEvent?: (
    name: string,
    attributes: SpanAttributes,
    context: Context,
  ) => void;
  metricAttributes?: (
    name: string,
    attributes: SpanAttributes,
  ) => SpanAttributes | undefined;
}
function isAttributeArray(
  value: AttributeValue,
): value is readonly string[] | readonly number[] | readonly boolean[] {
  return Array.isArray(value);
}
const copy = (attributes: SpanAttributes = {}): Attributes =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(
        (entry): entry is [string, AttributeValue] => entry[1] !== undefined,
      )
      .map(([key, value]) => [
        key,
        isAttributeArray(value) ? [...value] : value,
      ]),
  );
const quiet = (work: () => void) => {
  try {
    work();
  } catch {
    /* Recording must never alter the operation. */
  }
};
function failure(value: unknown): SpanStatus {
  try {
    return {
      status: "error",
      error: {
        name: value instanceof Error ? value.name : "Error",
        message: value instanceof Error ? value.message : String(value),
      },
    };
  } catch {
    return { status: "error" };
  }
}

/** Internal generic contract adapter. The public factory applies export privacy separately. */
export class OtelAdapter implements TelemetryContext {
  readonly metrics: TelemetryMetrics;
  readonly propagation;
  readonly contexts = new WeakMap<object, Context>();
  readonly statuses = new WeakMap<object, SpanStatus>();
  readonly options: AdapterOptions;
  readonly codec = new W3CTraceContextPropagator();
  constructor(options: AdapterOptions) {
    this.options = options;
    this.contexts.set(this, ROOT_CONTEXT);
    this.propagation = {
      inject: (context: TelemetryContext): TelemetryCarrier | undefined => {
        const native = this.contexts.get(context);
        const id = native && trace.getSpanContext(native);
        if (!native || !id || !isSpanContextValid(id)) return undefined;
        const carrier: TelemetryCarrier = {};
        this.codec.inject(native, carrier, defaultTextMapSetter);
        return carrier;
      },
      extract: (carrier: TelemetryCarrier | undefined): TelemetryContext => {
        if (!carrier || typeof carrier.traceparent !== "string") return this;
        // Deliberately no baggage propagator, global propagator or ambient context.
        const context = this.codec.extract(
          ROOT_CONTEXT,
          carrier,
          defaultTextMapGetter,
        );
        if (
          !isSpanContextValid(
            trace.getSpanContext(context) ?? {
              traceId: "",
              spanId: "",
              traceFlags: 0,
            },
          )
        )
          return this;
        return this.parent(context);
      },
    };
    const attributes = (name: string, values: SpanAttributes = {}) =>
      options.metricAttributes
        ? options.metricAttributes(name, values)
        : values;
    const instrument = (
      kind: "counter" | "upDownCounter" | "histogram",
      name: string,
      config: HistogramOptions = {},
    ) => {
      try {
        const native =
          kind === "counter"
            ? options.meter.createCounter(name, config)
            : kind === "upDownCounter"
              ? options.meter.createUpDownCounter(name, config)
              : options.meter.createHistogram(name, {
                  ...config,
                  advice: {
                    explicitBucketBoundaries: config.boundaries
                      ? [...config.boundaries]
                      : config.unit === "ms"
                        ? [
                            1, 10, 50, 100, 500, 1000, 5000, 10000, 30000,
                            60000, 120000, 300000, 900000,
                          ]
                        : undefined,
                  },
                });
        const record = (
          value: number,
          values?: SpanAttributes,
          context?: TelemetryContext,
        ): void => {
          quiet(() => {
            const filtered = attributes(name, values);
            if (filtered === undefined) return;
            if ("record" in native)
              native.record(
                value,
                copy(filtered),
                context
                  ? (this.contexts.get(context) ?? ROOT_CONTEXT)
                  : ROOT_CONTEXT,
              );
            else native.add(value, copy(filtered));
          });
        };
        return kind === "histogram" ? { record } : { add: record };
      } catch {
        return { add: () => undefined, record: () => undefined };
      }
    };
    this.metrics = {
      counter: (name: string, config?: InstrumentOptions) =>
        instrument("counter", name, config) as ReturnType<
          TelemetryMetrics["counter"]
        >,
      upDownCounter: (name: string, config?: InstrumentOptions) =>
        instrument("upDownCounter", name, config) as ReturnType<
          TelemetryMetrics["upDownCounter"]
        >,
      histogram: (name: string, config?: HistogramOptions) =>
        instrument("histogram", name, config) as ReturnType<
          TelemetryMetrics["histogram"]
        >,
    };
  }
  parent(context: Context): TelemetryContext {
    const parent: TelemetryContext = {
      metrics: this.metrics,
      propagation: this.propagation,
      startSpan: (options, callback) => this.start(context, options, callback),
    };
    this.contexts.set(parent, context);
    return parent;
  }
  startSpan<T>(
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    return this.start(ROOT_CONTEXT, options, callback);
  }
  inert<T>(callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
    const span: TelemetrySpan = {
      metrics: this.metrics,
      propagation: this.propagation,
      startSpan: (_options, work) => this.inert(work),
      setAttributes: () => undefined,
      setStatus: () => undefined,
      addEvent: () => undefined,
      addLink: () => undefined,
    };
    this.contexts.set(span, ROOT_CONTEXT);
    try {
      return Promise.resolve(callback(span));
    } catch (error) {
      // Preserve the callback's rejection value, including non-Error reasons.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the caller's original rejection value and identity.
      return Promise.reject(error);
    }
  }
  start<T>(
    parent: Context,
    options: SpanOptions,
    callback: (span: TelemetrySpan) => T | Promise<T>,
  ): Promise<T> {
    const links = (options.links ?? []).flatMap((link) => {
      const context = this.contexts.get(link.context);
      const target = context && trace.getSpanContext(context);
      return target && isSpanContextValid(target)
        ? [{ context: target, attributes: copy(link.attributes) }]
        : [];
    });
    let native: NativeSpan;
    try {
      native = this.options.tracer.startSpan(
        options.name,
        { attributes: copy(options.attributes), links },
        parent,
      );
    } catch {
      native = trace.wrapSpanContext({
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        traceFlags: 0,
      });
    }
    const context = trace.setSpan(parent, native);
    const attributes = copy(options.attributes) as SpanAttributes;
    let settled = false;
    let explicit: SpanStatus | undefined;
    const span: TelemetrySpan = {
      metrics: this.metrics,
      propagation: this.propagation,
      startSpan: (next, work) =>
        settled ? this.inert(work) : this.start(context, next, work),
      setAttributes: (values) => {
        if (settled) return;
        const detached = copy(values);
        Object.assign(attributes, detached);
        quiet(() => native.setAttributes(detached));
      },
      setStatus: (value) => {
        if (!settled)
          explicit =
            value.status === "ok"
              ? { status: "ok" }
              : {
                  status: "error",
                  ...(value.error ? { error: { ...value.error } } : {}),
                };
      },
      addEvent: (name, values = {}) => {
        if (settled) return;
        quiet(() => native.addEvent(name, copy(values)));
        quiet(() => this.options.onEvent?.(name, values, context));
      },
      addLink: (link: SpanLink) => {
        if (settled) return;
        const targetContext = this.contexts.get(link.context);
        const target = targetContext && trace.getSpanContext(targetContext);
        if (target && isSpanContextValid(target))
          quiet(() =>
            native.addLink({
              context: target,
              attributes: copy(link.attributes),
            }),
          );
      },
    };
    this.contexts.set(span, context);
    const started = performance.now();
    const end = (thrown: boolean, value?: unknown) => {
      if (settled) return;
      settled = true;
      const status = explicit ?? (thrown ? failure(value) : { status: "ok" });
      this.statuses.set(native, status);
      // Delay native status until settlement: Pi is last-write-wins; OTel has status precedence.
      quiet(() =>
        native.setStatus({
          code:
            status.status === "error"
              ? SpanStatusCode.ERROR
              : SpanStatusCode.OK,
          ...(status.status === "error" && status.error
            ? { message: status.error.message }
            : {}),
        }),
      );
      quiet(() =>
        this.options.onEnd?.({
          name: options.name,
          attributes,
          status,
          duration: performance.now() - started,
          context,
          native,
        }),
      );
      quiet(() => {
        native.end();
      });
    };
    // Invoke immediately and exactly once. Never retry a callback after recording fails.
    let returned: T | Promise<T>;
    try {
      returned = callback(span);
    } catch (error) {
      end(true, error);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Preserve the caller's original rejection value and identity.
      return Promise.reject(error);
    }
    return Promise.resolve(returned).then(
      (value) => {
        end(false);
        return value;
      },
      (error: unknown) => {
        end(true, error);
        throw error;
      },
    );
  }
}
