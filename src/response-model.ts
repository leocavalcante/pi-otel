import type { Api, Model, Models, StreamOptions } from "@earendil-works/pi-ai";
import type {
  HistogramOptions,
  InstrumentOptions,
  SpanAttributes,
  TelemetryContext,
  TelemetryMetrics,
  TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { modelsFacade } from "./models-facade.ts";
import { RESPONSE_MODEL, type ResponseModelPolicy } from "./privacy.ts";

export interface ResponseModelAttribution {
  /** Add request-scoped attributes to createModels()' existing telemetry. */
  nativeModels<T extends Models>(models: T): T;
  /** Pass to a provider to report the first distinct ID for this request scope. */
  report(scope: StreamOptions["telemetry"], modelId: string): void;
}

// Pi 1.5 caches instruments by metrics adapter. Keep reusing the parent's
// instruments across scopes when Pi passes the same instrument definition.
function cacheInstruments<Options extends InstrumentOptions, Instrument>(
  create: (
    metrics: TelemetryMetrics,
    name: string,
    options?: Options,
  ) => Instrument,
) {
  interface Entry {
    options?: Options;
    instrument: Instrument;
  }
  const cache = new WeakMap<TelemetryMetrics, Map<string, Entry>>();
  return (metrics: TelemetryMetrics, name: string, options?: Options) => {
    let instruments = cache.get(metrics);
    if (!instruments)
      cache.set(metrics, (instruments = new Map<string, Entry>()));
    const known = instruments.get(name);
    if (known && known.options === options) return known.instrument;
    const instrument = create(metrics, name, options);
    instruments.set(name, { options, instrument });
    return instrument;
  };
}

function capture<T>(record: () => T): T | undefined {
  try {
    return record();
  } catch {
    // Optional enrichment must never throw into a request or Pi's observer.
    return undefined;
  }
}

export function createResponseModelAttribution(
  policy: ResponseModelPolicy | undefined,
): ResponseModelAttribution {
  if (!policy)
    return { nativeModels: (models) => models, report: () => undefined };
  const { provider, model: routedModel, admits } = policy;

  const requests = new WeakMap<
    TelemetrySpan,
    { span: TelemetrySpan; reported?: true; id?: string }
  >();
  const wrapped = new WeakSet<Models>();
  const counter = cacheInstruments(
    (metrics, name, options: InstrumentOptions | undefined) =>
      metrics.counter(name, options),
  );
  const histogram = cacheInstruments(
    (metrics, name, options: HistogramOptions | undefined) =>
      metrics.histogram(name, options),
  );

  function requestScope(parent: TelemetrySpan) {
    const adapter = parent.metrics;
    const propagation = parent.propagation;
    let started = false;
    const unwrap = (value: TelemetryContext) =>
      value === scope ? parent : value;
    const attributes = (values?: SpanAttributes) => {
      const id = requests.get(scope)?.id;
      return id && values?.provider === provider && values.model === routedModel
        ? { ...values, [RESPONSE_MODEL]: id }
        : values;
    };
    const scope: TelemetrySpan = {
      metrics: adapter && {
        counter(name, options) {
          if (name !== "pi.ai.tokens" && name !== "pi.ai.cost")
            return adapter.counter(name, options);
          const instrument = capture(() => counter(adapter, name, options));
          return {
            add: (value, values) => {
              capture(() => instrument?.add(value, attributes(values)));
            },
          };
        },
        upDownCounter: (name, options) => adapter.upDownCounter(name, options),
        histogram(name, options) {
          const duration = name === "pi.ai.request.duration";
          const instrument =
            duration || name === "pi.ai.first_chunk.duration"
              ? capture(() => histogram(adapter, name, options))
              : adapter.histogram(name, options);
          return {
            record: (value, values, context) => {
              capture(() =>
                instrument?.record(
                  value,
                  duration ? attributes(values) : values,
                  context && unwrap(context),
                ),
              );
            },
          };
        },
      },
      propagation: propagation && {
        inject: (context) => propagation.inject(unwrap(context)),
        extract: (carrier) => propagation.extract(carrier),
      },
      setAttributes: (values) => {
        parent.setAttributes(values);
      },
      setStatus: (status) => {
        parent.setStatus(status);
      },
      addEvent: (name, values) => {
        parent.addEvent(name, values);
      },
      addLink: (link) => {
        parent.addLink({ ...link, context: unwrap(link.context) });
      },
      startSpan(options, callback) {
        if (
          started ||
          (options.name !== "pi.ai.request" && options.name !== "pi.ai.poll")
        )
          return parent.startSpan(options, callback);
        started = true;
        return parent.startSpan(options, async (span) => {
          requests.set(scope, { span });
          try {
            return await callback(span);
          } finally {
            // Native onResult settles this callback after it records usage.
            requests.delete(scope);
          }
        });
      },
    };
    return scope;
  }

  function withScope<
    T extends [Model<Api>, unknown, { telemetry?: TelemetrySpan }?],
  >(args: T): T {
    const [model, , options] = args;
    const parent = options?.telemetry;
    if (parent && model.provider === provider && model.id === routedModel) {
      const scoped = capture(() => ({
        ...options,
        telemetry: requestScope(parent),
      }));
      if (scoped) args[2] = scoped;
    }
    return args;
  }

  return {
    nativeModels(models) {
      if (wrapped.has(models)) return models;
      const facade = modelsFacade(models, {
        stream: (...args) => models.stream(...withScope(args)),
        streamSimple: (...args) => models.streamSimple(...withScope(args)),
        streamDeferred: (...args) => models.streamDeferred(...withScope(args)),
        complete: (...args) => models.complete(...withScope(args)),
        completeSimple: (...args) => models.completeSimple(...withScope(args)),
        fetchDeferred: (...args) => models.fetchDeferred(...withScope(args)),
      });
      wrapped.add(facade);
      return facade;
    },
    report: (scope, id: unknown) => {
      const request = scope && requests.get(scope);
      if (
        !request ||
        request.reported ||
        typeof id !== "string" ||
        !id ||
        id === routedModel
      )
        return;
      // Like the native adapter, keep the first distinct ID, even if it is not
      // exportable. A later ID must not disagree with the assistant result.
      request.reported = true;
      if (!admits(id)) return;
      request.id = id;
      capture(() => {
        request.span.setAttributes({ [RESPONSE_MODEL]: id });
      });
    },
  };
}
