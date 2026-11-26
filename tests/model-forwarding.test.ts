import { test } from "bun:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  fauxProvider,
  fauxAssistantMessage,
  type Models,
} from "@earendil-works/pi-ai";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { withModelRuntimeTelemetry } from "../src/model-runtime.ts";
import { createPiOtel } from "../src/index.ts";
import { labels, receiver, spans, metrics } from "./receiver.ts";
const PRIVATE = "SYNTHETIC_PRIVATE_FORWARDING_MARKER";
function completed(message: ReturnType<typeof fauxAssistantMessage>) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push(
      message.stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: message.stopReason as "stop", message },
    );
    stream.end(message);
  });
  return stream;
}

test("runtime facade preserves argument/result identity, cancellation, method receiver and one underlying call", async () => {
  const sink = await receiver();
  const model = fauxProvider().getModel(),
    context = { messages: [] },
    options = { signal: new AbortController().signal, apiKey: PRIVATE };
  const responseModel = "fixture/Model-A";
  const otel = createPiOtel({
    endpoint: sink.endpoint,
    responseModels: {
      provider: model.provider,
      model: model.id,
      allowedIds: [responseModel],
    },
  });
  const answer = {
    ...fauxAssistantMessage(PRIVATE, {
      stopReason: "error",
      errorMessage: PRIVATE,
      responseId: PRIVATE,
    }),
    responseModel,
    usage: {
      input: 11,
      output: 7,
      cacheRead: 5,
      cacheWrite: 3,
      totalTokens: 26,
      cost: { input: 1, output: 2, cacheRead: 4, cacheWrite: 8, total: 15 },
    },
  };
  let calls = 0;
  const runtime = {
    getModel() {
      assert.equal(this, runtime);
      return model;
    },
    streamSimple(m: unknown, c: unknown, o: unknown) {
      calls++;
      assert.equal(this, runtime);
      assert.equal(m, model);
      assert.equal(c, context);
      assert.equal(o, options);
      return completed(answer);
    },
  } as unknown as Models;
  try {
    const observed = otel.modelRuntime(runtime);
    assert.equal(observed.getModel("fixture", "fixture"), model);
    assert.equal(
      await observed.completeSimple(model, context, options),
      answer,
    );
    assert.equal(calls, 1);
    // Pi lazyStream resolves its result before its forwarding observer settles.
    await setImmediate();
    assert(await otel.forceFlush());
    const requests = spans(sink.requests).filter(
      (span) => span.name === "pi.ai.request",
    );
    assert.equal(requests.length, 1);
    assert.equal(labels(requests[0])["gen_ai.response.model"], responseModel);
    const points = (name: string) =>
      metrics(sink.requests).find((metric) => metric.name === name)?.sum
        .dataPoints as any[];
    const tokens = points("pi.ai.tokens");
    assert.deepEqual(
      Object.fromEntries(
        tokens.map((point) => [labels(point).kind, Number(point.asDouble)]),
      ),
      {
        input: 11,
        output: 7,
        cache_read: 5,
        cache_write: 3,
      },
    );
    const cost = points("pi.ai.cost");
    assert.equal(cost.length, 1);
    assert.equal(Number(cost[0].asDouble), 15);
    assert(
      [...tokens, ...cost].every(
        (point) => labels(point)["gen_ai.response.model"] === responseModel,
      ),
    );
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  } finally {
    await otel.shutdown();
    await sink.close();
  }
});

test("pending deferred polls record timing but not token/cost consumption", async () => {
  const sink = await receiver();
  const model = fauxProvider().getModel();
  const responseModel = "fixture/Model-A";
  const otel = createPiOtel({
    endpoint: sink.endpoint,
    responseModels: {
      provider: model.provider,
      model: model.id,
      allowedIds: [responseModel],
    },
  });
  const handle = {
    provider: model.provider,
    modelId: model.id,
    api: model.api,
    id: PRIVATE,
  };
  const answer = {
    ...fauxAssistantMessage("", { stopReason: "pending" }),
    responseModel,
  };
  let calls = 0;
  const runtime = {
    streamDeferred(m: unknown, h: unknown) {
      calls++;
      assert.equal(m, model);
      assert.equal(h, handle);
      return completed(answer);
    },
  } as unknown as Models;
  try {
    assert.equal(
      await otel.modelRuntime(runtime).fetchDeferred(model, handle),
      answer,
    );
    assert.equal(calls, 1);
    await setImmediate();
    assert(await otel.forceFlush());
    const polls = spans(sink.requests).filter(
      (span) => span.name === "pi.ai.poll",
    );
    assert.equal(polls.length, 1);
    assert.equal(labels(polls[0])["gen_ai.response.model"], responseModel);
    const duration = metrics(sink.requests).find(
      (metric) => metric.name === "pi.ai.request.duration",
    );
    assert.equal(
      labels(duration.histogram.dataPoints[0])["gen_ai.response.model"],
      responseModel,
    );
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
    assert(
      !metrics(sink.requests).some(
        (metric) =>
          metric.name === "pi.ai.tokens" || metric.name === "pi.ai.cost",
      ),
    );
  } finally {
    await otel.shutdown();
    await sink.close();
  }
});

test("recording failure does not replace results or repeat a runtime operation", async () => {
  const model = fauxProvider().getModel(),
    answer = fauxAssistantMessage("Synthetic answer");
  let calls = 0;
  const runtime = {
    streamSimple() {
      calls++;
      return completed(answer);
    },
  } as unknown as Models;
  const broken = {
    startSpan() {
      throw new Error(PRIVATE);
    },
    metrics: {
      counter() {
        throw new Error(PRIVATE);
      },
    },
  } as unknown as TelemetryContext;
  const observed = withModelRuntimeTelemetry(runtime, broken);
  assert.equal(await observed.completeSimple(model, { messages: [] }), answer);
  assert.equal(calls, 1);
});
