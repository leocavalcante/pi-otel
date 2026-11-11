import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createPiOtel } from '../src/index.ts';
import { receiver, spans, metrics } from './receiver.ts';

const PRIVATE = 'PRIVATE_CONTENT_MUST_NOT_LEAVE_PROCESS';
test('real OTLP/HTTP exports all signals, strips content/error details, preserves IDs and low-cardinality metrics', async () => {
  const sink = await receiver();
  const otel = createPiOtel({ serviceName: 'example-agent', endpoint: sink.endpoint });
  try {
    let carrier: Record<string, string> | undefined;
    await otel.telemetry.startSpan({ name: 'pi.durable.phase', attributes: {
      'task.id': 7, 'task.name': 'pi.tool', phase: 'call', kind: 'run', resumed: true, prompt: PRIVATE,
    } }, async parent => {
      carrier = parent.propagation!.inject(parent);
      assert(carrier?.traceparent); assert.equal(carrier?.baggage, undefined);
      parent.addEvent('pi.durable.entry', { 'entry.id': 9, 'entry.kind': 'pi.user', content: PRIVATE });
      parent.addEvent(PRIVATE, { text: PRIVATE });
      await parent.startSpan({ name: 'pi.ai.request', attributes: { provider: 'synthetic', model: 'example-model', payload: PRIVATE } }, span => {
        span.setAttributes({ 'usage.input': 42, answer: PRIVATE, 'response.id': PRIVATE });
        span.setStatus({ status: 'error', error: { name: 'provider_error', message: PRIVATE } });
        span.metrics!.counter('pi.ai.tokens', { unit: 'token' }).add(42, { provider: 'synthetic', model: 'example-model', kind: 'input', 'task.id': 7, prompt: PRIVATE });
        span.metrics!.histogram('pi.ai.request.duration', { unit: 'ms' }).record(123, { provider: 'synthetic', model: 'example-model', stop: 'error', 'request.id': PRIVATE }, span);
      });
      parent.setAttributes({ 'tool.name': 'example_tool', outcome: 'done' });
    });
    const resumed = otel.telemetry.propagation!.extract(carrier);
    await resumed.startSpan({ name: 'pi.durable.phase', attributes: { 'task.name': 'pi.generation', 'task.id': 7, phase: 'request', kind: 'run', resumed: true } }, () => {});
    assert(await otel.forceFlush());
    assert(sink.requests.some(request => request.path === '/v1/traces'));
    assert(sink.requests.some(request => request.path === '/v1/metrics'));
    assert(sink.requests.some(request => request.path === '/v1/logs'));
    const payload = JSON.stringify(sink.requests.map(request => request.body));
    assert(!payload.includes(PRIVATE));
    const records = spans(sink.requests);
    assert(records.some(span => span.name === 'pi.ai.request' && span.status?.code === 2 && !span.status.message));
    assert(records.every(span => span.name !== PRIVATE));
    const resumedSpan = records.find(span => span.attributes?.some((attribute: any) => attribute.key === 'phase' && attribute.value.stringValue === 'request'));
    assert.equal(resumedSpan.traceId, carrier!.traceparent.split('-')[1]);
    const tokens = metrics(sink.requests).find(metric => metric.name === 'pi.ai.tokens');
    assert(tokens.sum.dataPoints.some((point: any) => Number(point.asDouble ?? point.asInt) === 42));
    assert(tokens.sum.dataPoints.every((point: any) => point.attributes.every((attribute: any) => !attribute.key.endsWith('.id'))));
  } finally { await otel.shutdown(); await sink.close(); }
});

test('recording errors preserve callback rejection identity; unknown spans do not leak names or attributes', async () => {
  const sink = await receiver(); const otel = createPiOtel({ endpoint: sink.endpoint });
  try {
    const error = new Error(PRIVATE);
    await assert.rejects(otel.telemetry.startSpan({ name: PRIVATE, attributes: { secret: PRIVATE } }, () => { throw error; }), value => value === error);
    assert(await otel.forceFlush());
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
    assert(spans(sink.requests).some(span => span.name === 'pi.operation'));
  } finally { await otel.shutdown(); await sink.close(); }
});

test('persistent usage is sampled through a supplied owner, not replayed as counter increments', async () => {
  const sink = await receiver(); const otel = createPiOtel({ endpoint: sink.endpoint });
  let reads = 0;
  try {
    await otel.observeDurable({ async usage() { reads++; return { models: { 'synthetic/example': {
      input: 100, output: 20, cacheRead: 30, cacheWrite: 0, cost: { total: 0.01 },
    } } }; } }, undefined);
    assert(await otel.forceFlush()); assert.equal(reads, 1);
    const totals = metrics(sink.requests).find(metric => metric.name === 'pi.otel.usage.tokens');
    assert(totals.gauge.dataPoints.some((point: any) => point.asDouble === 100));
    assert(!metrics(sink.requests).some(metric => metric.name === 'pi.ai.tokens'));
  } finally { await otel.shutdown(); await sink.close(); }
});

test('unavailable collector is nonfatal and shutdown is idempotent', async () => {
  const sink = await receiver(); const endpoint = sink.endpoint; await sink.close();
  const otel = createPiOtel({ endpoint });
  await otel.telemetry.startSpan({ name: 'pi.ai.request', attributes: { provider: 'synthetic', model: 'example' } }, () => 42);
  assert.equal(await otel.forceFlush(), false);
  const closing = otel.shutdown(); assert.equal(otel.shutdown(), closing); await closing;
});

test('unsafe endpoint credentials are rejected without echoing input', () => {
  assert.throws(() => createPiOtel({ endpoint: 'https://user:private-sentinel@example.invalid/' }), error =>
    error instanceof Error && !error.message.includes('private-sentinel'));
});
