import { randomUUID } from 'node:crypto';
import { TracerProvider, BatchSpanProcessor, AlwaysOffSampler, type SpanExporter } from '@opentelemetry/sdk-trace';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { ExportResult } from '@opentelemetry/core';
import type { TelemetryContext } from '@earendil-works/pi-telemetry';
import type { Models } from '@earendil-works/pi-ai';
import { withModelRuntimeTelemetry } from './model-runtime.ts';
import { OtelAdapter } from './adapter.ts';
import { SPANS, pick, safeSpan, metricAttributes, eventAttributes, errorCategory } from './privacy.ts';
import { codingObserver, type CodingEvent, type CodingSource } from './coding.ts';

export interface PiOtelOptions {
  serviceName?: string;
  serviceNamespace?: string;
  serviceVersion?: string;
  /** OTLP/HTTP base URL. Standard signal-specific OTEL environment variables are also supported. */
  endpoint?: string;
}
export interface UsageValue { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } }
export interface UsageState { models: Readonly<Record<string, UsageValue>>; tools?: Readonly<Record<string, UsageValue>> }
export interface PiOtel {
  readonly telemetry: TelemetryContext;
  /** SDK ModelRuntime 1.5.0 compatibility. Do not wrap already-instrumented createModels(). */
  modelRuntime<T extends Models>(runtime: T): T;
  /** Read totals through the existing owner only; never opens storage or another Harness. */
  observeDurable<C>(harness: { usage(context: C): Promise<UsageState> }, context: C): Promise<() => void>;
  observeCodingAgent(source: CodingSource): () => void;
  /** Metadata-only coding lifecycle observer, also used by the Pi extension. */
  codingObserver(): { handle(event: CodingEvent): void; close(): void };
  /** False means export was incomplete. Backend failures never throw into agent work. */
  forceFlush(): Promise<boolean>;
  shutdown(): Promise<boolean>;
}
function endpoint(signal: string, base?: string): string {
  const specific = process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  const value = specific ?? (base ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '') + `/v1/${signal}`;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid OTLP endpoint.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OTLP requires HTTP(S) without embedded credentials, query or fragment; use OTEL headers for authentication.');
  }
  return url.href;
}
function identity(value: string, name: string): string {
  if (!value || !pick({ value }, ['value']).value) throw new Error(`Invalid ${name}. Use a short, non-sensitive identifier.`);
  return value;
}

export function createPiOtel(options: PiOtelOptions = {}): PiOtel {
  const envResource = Object.fromEntries((process.env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',').map(part => {
    const at = part.indexOf('='); return [part.slice(0, at), part.slice(at + 1)];
  }));
  const disabled = process.env.OTEL_SDK_DISABLED === 'true';
  const resource = resourceFromAttributes({
    'service.name': identity(options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? 'pi-agent', 'service name'),
    'service.namespace': identity(options.serviceNamespace ?? envResource['service.namespace'] ?? 'agents', 'service namespace'),
    'service.version': identity(options.serviceVersion ?? envResource['service.version'] ?? 'unknown', 'service version'),
    'service.instance.id': randomUUID(), 'telemetry.sdk.name': 'pi-otel', 'telemetry.sdk.version': '0.1.1',
  });
  const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 15000);
  if (!Number.isFinite(interval) || interval < 1000) throw new Error('OTEL_METRIC_EXPORT_INTERVAL must be at least 1000 milliseconds.');
  let exportFailures = 0;
  let exporterError: ((signal: string) => void) | undefined;
  const checked = (signal: string, callback: (result: ExportResult) => void) => (result: ExportResult) => {
    if (result.code !== 0) {
      exporterError?.(signal);
      // Prevent SDK diagnostics from exposing raw backend/authentication error text.
      callback({ code: result.code, error: new Error('OTLP export failed.') });
    } else callback(result);
  };
  const metricExporter = new OTLPMetricExporter({ url: endpoint('metrics', options.endpoint), timeoutMillis: 5000 });
  const meters = new MeterProvider({ resource, readers: disabled ? [] : [new PeriodicExportingMetricReader({
    exporter: { export: (data, callback) => metricExporter.export(data, checked('metrics', callback)),
      forceFlush: () => metricExporter.forceFlush(), shutdown: () => metricExporter.shutdown(),
      selectAggregationTemporality: kind => metricExporter.selectAggregationTemporality(kind), },
    exportIntervalMillis: interval, exportTimeoutMillis: Math.min(interval, 5000),
  })] });
  const meter = meters.getMeter('@leocavalcante/pi-otel', '0.1.1');
  const exportErrors = meter.createCounter('pi.otel.export.errors');
  exporterError = signal => { exportFailures++; exportErrors.add(1, { signal }); };
  const traceExporter = new OTLPTraceExporter({ url: endpoint('traces', options.endpoint), timeoutMillis: 5000 });
  const safeExporter: SpanExporter = {
    export: (spans, callback) => traceExporter.export(spans.map(safeSpan), checked('traces', callback)),
    shutdown: () => traceExporter.shutdown(), forceFlush: () => traceExporter.forceFlush(),
  };
  const tracers = new TracerProvider({ resource,
    ...(disabled ? { sampler: new AlwaysOffSampler() } : {}),
    spanProcessors: disabled ? [] : [new BatchSpanProcessor({ exporter: safeExporter, maxQueueSize: 512,
      maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 5000 })],
  });
  const logExporter = new OTLPLogExporter({ url: endpoint('logs', options.endpoint), timeoutMillis: 5000 });
  const logs = new LoggerProvider({ resource, processors: disabled ? [] : [new BatchLogRecordProcessor({
    exporter: { export: (records, callback) => logExporter.export(records, checked('logs', callback)),
      shutdown: () => logExporter.shutdown(), forceFlush: () => logExporter.forceFlush() },
    maxQueueSize: 512, maxExportBatchSize: 128, scheduledDelayMillis: 1000, exportTimeoutMillis: 5000,
  })] });
  const logger = logs.getLogger('@leocavalcante/pi-otel', '0.1.1');
  const tools = meter.createCounter('pi.otel.tool.attempts');
  const toolDuration = meter.createHistogram('pi.otel.tool.duration', { unit: 'ms', advice: {
    explicitBucketBoundaries: [1, 10, 50, 100, 500, 1000, 5000, 15000, 60000, 300000, 900000] } });
  const recovered = meter.createCounter('pi.otel.recovered.phases');
  const telemetry = new OtelAdapter({ tracer: tracers.getTracer('@leocavalcante/pi-otel', '0.1.1'), meter, metricAttributes,
    onEvent: (name, attributes, context) => {
      const safe = eventAttributes(name, attributes);
      if (safe) logger.emit({ body: name, severityNumber: 9, attributes: safe, context });
    },
    onEnd: ({ name, attributes, status, duration, context, native }) => {
      if (!SPANS[name]) return;
      const safe = pick(attributes, SPANS[name]);
      if (status.status === 'error') {
        safe['error.type'] = errorCategory(status.error?.name);
        native.setAttribute('error.type', safe['error.type']);
      }
      logger.emit({ body: name + '.completed', severityNumber: status.status === 'error' ? 17 : 9, attributes: safe, context });
      if (name === 'pi.durable.phase' && attributes.resumed === true) recovered.add(1, pick(attributes, ['task.name']));
      if (name === 'pi.durable.phase' && attributes['task.name'] === 'pi.tool' && attributes.kind === 'run') {
        const labels = { tool: attributes['tool.name'], phase: attributes.phase, outcome: attributes.outcome };
        tools.add(1, pick(labels, ['tool', 'phase', 'outcome']));
        toolDuration.record(duration, pick(labels, ['tool', 'phase', 'outcome']), context);
      }
    },
  });
  meter.createObservableGauge('pi.otel.heartbeat', { unit: 's' }).addCallback(result => result.observe(Date.now() / 1000));
  meter.createObservableGauge('pi.otel.process.memory.rss', { unit: 'By' }).addCallback(result => result.observe(process.memoryUsage().rss));
  const usageTokens = meter.createObservableGauge('pi.otel.usage.tokens', { unit: 'token' });
  const usageCost = meter.createObservableGauge('pi.otel.usage.cost', { unit: 'USD' });
  type Row = { provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  const snapshots = new Map<object, Row[]>();
  usageTokens.addCallback(result => { for (const rows of snapshots.values()) for (const row of rows) {
    for (const [kind, key] of [['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'], ['cache_write', 'cacheWrite']] as const) {
      result.observe(row[key], { provider: row.provider, model: row.model, kind });
    }
  } });
  usageCost.addCallback(result => { for (const rows of snapshots.values()) for (const row of rows) {
    result.observe(row.cost, { provider: row.provider, model: row.model });
  } });
  void telemetry.startSpan({ name: 'pi.otel.lifecycle', attributes: { event: 'started' } }, () => {});
  const usageErrors = meter.createCounter('pi.otel.usage.read.errors');
  const cleanup = new Set<() => void>();
  let closing: Promise<boolean> | undefined;
  const api: PiOtel = {
    telemetry,
    modelRuntime: runtime => withModelRuntimeTelemetry(runtime, telemetry),
    async observeDurable(harness, context) {
      if (disabled || closing) return () => {};
      let stopped = false; let reading = false;
      const key = {};
      const update = async () => {
        if (stopped || reading) return;
        reading = true;
        try {
          const usage = await harness.usage(context);
          const rows: Row[] = [];
          for (const [id, value] of Object.entries(usage.models)) {
            const at = id.indexOf('/'); if (at < 1) continue;
            const provider = id.slice(0, at), model = id.slice(at + 1);
            const labels = pick({ provider, model }, ['provider', 'model']);
            if (!labels.provider || !labels.model) continue;
            if (![value.input, value.output, value.cacheRead, value.cacheWrite, value.cost.total].every(Number.isFinite)) continue;
            rows.push({ provider, model, input: value.input, output: value.output, cacheRead: value.cacheRead,
              cacheWrite: value.cacheWrite, cost: value.cost.total });
          }
          if (!stopped) snapshots.set(key, rows);
        } catch { usageErrors.add(1); } finally { reading = false; }
      };
      await update();
      const timer = setInterval(() => { void update(); }, 15000); timer.unref();
      const stop = () => { stopped = true; clearInterval(timer); snapshots.delete(key); cleanup.delete(stop); };
      cleanup.add(stop); return stop;
    },
    codingObserver: () => codingObserver(telemetry, meter),
    observeCodingAgent(source) {
      const observer = api.codingObserver();
      const unsubscribe = source.subscribe(event => observer.handle(event));
      const stop = () => { unsubscribe(); observer.close(); cleanup.delete(stop); };
      cleanup.add(stop); return stop;
    },
    async forceFlush() {
      const before = exportFailures;
      const results = await Promise.allSettled([tracers.forceFlush({ timeoutMillis: 5000 }), meters.forceFlush({ timeoutMillis: 5000 }), logs.forceFlush({ timeoutMillis: 5000 })]);
      return before === exportFailures && results.every(result => result.status === 'fulfilled');
    },
    shutdown() {
      if (closing) return closing;
      for (const stop of cleanup) stop();
      closing = (async () => {
        await telemetry.startSpan({ name: 'pi.otel.lifecycle', attributes: { event: 'stopped' } }, () => {});
        const flushed = await api.forceFlush();
        const results = await Promise.allSettled([tracers.shutdown(), meters.shutdown({ timeoutMillis: 5000 }), logs.shutdown()]);
        return flushed && results.every(result => result.status === 'fulfilled');
      })();
      return closing;
    },
  };
  return api;
}
export type { CodingEvent, CodingSource } from './coding.ts';
