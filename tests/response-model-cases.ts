import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createModels,
  createProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelsSimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import {
  createPiOtel,
  type PiOtel,
  type ResponseModelAttribution,
} from "../src/index.ts";
import { labels, metrics, receiver, spans } from "./receiver.ts";

const PRIVATE = "SYNTHETIC_PRIVATE_ROUTED_RESPONSE";
const A = "Fixture/Model.A-1";
const B = "fixture/Model-B:2";
const rejectedId = `sk-${PRIVATE}`;
const config = {
  provider: "test-gateway",
  model: "router",
  allowedIds: [A, B, rejectedId],
} as const;
const responseLabel = "gen_ai.response.model";
const model: Model<"openai-completions"> = {
  id: config.model,
  name: "Synthetic router",
  provider: config.provider,
  api: "openai-completions",
  baseUrl: "https://gateway.example.invalid/test",
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 4000,
  cost: { input: 1e6, output: 2e6, cacheRead: 4e6, cacheWrite: 8e6 },
};
const transcript = {
  messages: [
    { role: "user" as const, content: `${PRIVATE}_PROMPT`, timestamp: 0 },
  ],
};

function mockFetch(
  run: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  // Bun types include a preconnect helper. No fixture should use it.
  return Object.assign(run, {
    preconnect: () => assert.fail("fixture attempted a preconnect"),
  });
}

// Stand-in for a headless provider. Compose the real Chat adapter's parsed
// event hook; like Pi, consider only the first nonempty distinct top-level ID.
function gateway(report: ResponseModelAttribution["report"]) {
  const api = openAICompletionsApi();
  const relay = <T extends StreamOptions>(options?: T) => {
    if (!options) return options;
    let reported = false;
    const caller = options.onProviderStreamEvent;
    return {
      ...options,
      async onProviderStreamEvent(data, requested) {
        await caller?.call(options, data, requested);
        if (
          !reported &&
          data &&
          typeof data === "object" &&
          "model" in data &&
          typeof data.model === "string" &&
          data.model &&
          data.model !== requested.id
        ) {
          reported = true;
          report(options.telemetry, data.model);
        }
      },
    } satisfies StreamOptions;
  };
  return createProvider({
    id: model.provider,
    models: [model, { ...model, id: "fixed-model" }],
    auth: {
      apiKey: {
        name: "Test key",
        async resolve({ credential }) {
          return { auth: { apiKey: credential?.key ?? `${PRIVATE}_AUTH` } };
        },
      },
    },
    api: {
      stream: (requested, input, options) =>
        api.stream(requested, input, relay(options)),
      streamSimple: (requested, input, options) =>
        api.streamSimple(requested, input, relay(options)),
    },
  });
}

const usageA = { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, cost: 69 };
const usageB = { input: 17, output: 13, cacheRead: 9, cacheWrite: 1, cost: 87 };
function sse(
  id?: string,
  usage = usageA,
  tool = false,
  requested: string = config.model,
) {
  const chunks = [
    { model: requested, choices: [] },
    { model: "", choices: [] },
    {
      model: id,
      choices: [
        {
          delta: tool
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `${PRIVATE}_CALL`,
                    type: "function",
                    function: {
                      name: "test_tool",
                      arguments: JSON.stringify({ text: `${PRIVATE}_ARGS` }),
                    },
                  },
                ],
              }
            : {
                content: `${PRIVATE}_ANSWER`,
                reasoning_content: `${PRIVATE}_THINKING`,
              },
        },
      ],
    },
    { choices: [{ finish_reason: tool ? "tool_calls" : "stop" }] },
    {
      choices: [],
      usage: {
        prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
        completion_tokens: usage.output,
        prompt_tokens_details: {
          cached_tokens: usage.cacheRead,
          cache_write_tokens: usage.cacheWrite,
        },
      },
    },
  ];
  return new Response(
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({ id: `${PRIVATE}_RESPONSE_ID`, ...chunk })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    {
      headers: {
        "content-type": "text/event-stream",
        "x-response": `${PRIVATE}_HEADER`,
      },
    },
  );
}

async function consume(stream: AssistantMessageEventStream) {
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { message: await stream.result(), events };
}
function assertResult(
  message: AssistantMessage,
  id: string,
  usage: typeof usageA,
) {
  const { input, output, cacheRead, cacheWrite, cost } = message.usage;
  assert.equal(message.model, model.id);
  assert.equal(message.provider, model.provider);
  assert.equal(message.responseModel, id);
  assert.deepEqual(
    { input, output, cacheRead, cacheWrite, cost: cost.total },
    usage,
  );
}

type Requests = Awaited<ReturnType<typeof receiver>>["requests"];
function aiRequests(requests: Requests) {
  return spans(requests).filter((span) => span.name === "pi.ai.request");
}
function measurement(requests: Requests, name: string) {
  const matching = metrics(requests).filter((metric) => metric.name === name);
  assert.equal(matching.length, 1, name);
  return matching[0];
}

export async function nativeAttribution() {
  const sink = await receiver();
  const allowedIds = [...config.allowedIds];
  const otel = createPiOtel({
    endpoint: sink.endpoint,
    responseModels: { ...config, allowedIds },
  });
  const { report, nativeModels } = otel.responseModel;
  const native = createModels();
  const models = nativeModels(native);
  const scopes: StreamOptions["telemetry"][] = [];
  models.setProvider(
    gateway((scope, id) => {
      scopes.push(scope);
      report(scope, id);
    }),
  );
  assert.equal(
    native.getProvider(model.provider),
    models.getProvider(model.provider),
  );
  assert.equal(nativeModels(models), models);
  allowedIds.length = 0; // The exporter takes a snapshot of the reviewed IDs.
  let calls = 0;
  let a: AssistantMessage | undefined;
  let b: AssistantMessage | undefined;
  try {
    await otel.telemetry.startSpan(
      { name: "pi.durable.phase" },
      async (parent) => {
        const seenA = Promise.withResolvers<undefined>();
        const releaseA = Promise.withResolvers<undefined>();
        const options = Object.freeze<ModelsSimpleStreamOptions>({
          telemetry: parent,
          maxRetries: 0,
          maxTokens: 48,
          headers: { "x-override": `${PRIVATE}_REQUEST_HEADER` },
          transformHeaders: (headers) => ({
            ...headers,
            "x-transformed": "yes",
          }),
          onPayload: (payload) => ({
            ...(payload as object),
            marker: `${PRIVATE}_PAYLOAD`,
          }),
          onResponse(response) {
            assert.equal(response.headers["x-response"], `${PRIVATE}_HEADER`);
          },
          async onProviderStreamEvent(data: any) {
            if (calls === 1 && data.choices[0]?.finish_reason) {
              // A has reported its ID; let B record usage before A finishes.
              seenA.resolve(undefined);
              await releaseA.promise;
            }
          },
          fetch: mockFetch(async (input, init) => {
            calls++;
            assert(typeof input === "string");
            const request = new Request(input, init);
            assert.equal(
              request.url,
              "https://gateway.example.invalid/test/chat/completions",
            );
            assert.equal(
              request.headers.get("authorization"),
              `Bearer ${PRIVATE}_AUTH`,
            );
            assert.equal(
              request.headers.get("x-override"),
              `${PRIVATE}_REQUEST_HEADER`,
            );
            assert.equal(request.headers.get("x-transformed"), "yes");
            const payload: any = await request.json();
            assert.equal(payload.model, model.id);
            assert.equal(payload.max_completion_tokens, 48);
            assert.equal(payload.marker, `${PRIVATE}_PAYLOAD`);
            assert(!JSON.stringify(payload).includes("telemetry"));
            return calls === 1 ? sse(A, usageA, true) : sse(B, usageB);
          }),
        });
        const stream = models.stream(model, transcript, options);
        const streamed = consume(stream);
        try {
          await Promise.race([
            seenA.promise,
            streamed.then(({ message }) =>
              assert.fail(message.errorMessage ?? "A did not reach the relay"),
            ),
          ]);
          b = await models.completeSimple(model, transcript, options);
          assert.equal(b.stopReason, "stop", b.errorMessage);
          assertResult(b, B, usageB);
        } finally {
          releaseA.resolve(undefined);
        }
        const { message, events } = await streamed;
        a = message;
        assert.equal(await stream.result(), a);
        assert.equal(a.stopReason, "toolUse", a.errorMessage);
        assert(events.includes("toolcall_end"));
        assertResult(a, A, usageA);
        assert.equal(options.telemetry, parent);
        assert.equal(scopes.length, 2);
        assert.notEqual(scopes[0], scopes[1]);
        for (const scope of scopes) {
          assert(scope && scope !== parent);
          assert.deepEqual(
            scope.propagation?.inject(scope),
            parent.propagation?.inject(parent),
          );
        }
        report(parent, B); // A parent or expired scope cannot change a request.
        report(scopes[0], B);
        report(scopes[1], A);
        parent.setAttributes({ [responseLabel]: A }); // Never export on a phase.
      },
    );
    assert.equal(calls, 2);
    assert(a && b);
    // Let Pi settle its native observer and adapter callbacks after .result().
    await setImmediate();
    const usage = {
      input: a.usage.input + b.usage.input,
      output: a.usage.output + b.usage.output,
      cacheRead: a.usage.cacheRead + b.usage.cacheRead,
      cacheWrite: a.usage.cacheWrite + b.usage.cacheWrite,
      cost: { total: a.usage.cost.total + b.usage.cost.total },
    };
    await otel.observeDurable(
      {
        async usage() {
          return { models: { [`${model.provider}/${model.id}`]: usage } };
        },
      },
      undefined,
    );
    assert(await otel.forceFlush());
    const requests = sink.requests;
    const modelSpans = aiRequests(requests);
    const parent = spans(requests).find(
      (span) => span.name === "pi.durable.phase",
    );
    assert(parent);
    assert.equal(labels(parent)[responseLabel], undefined);
    assert.equal(modelSpans.length, 2);
    assert(
      modelSpans.every(
        (span) =>
          span.parentSpanId === parent.spanId &&
          span.traceId === parent.traceId,
      ),
    );
    const durations = measurement(requests, "pi.ai.request.duration");
    const tokens = measurement(requests, "pi.ai.tokens");
    const cost = measurement(requests, "pi.ai.cost");
    assert.equal(durations.unit, "ms");
    assert.equal(tokens.unit, "token");
    assert.equal(cost.unit, "USD");
    assert.equal(durations.histogram.dataPoints.length, 2);
    assert.equal(tokens.sum.dataPoints.length, 8);
    assert.equal(cost.sum.dataPoints.length, 2);
    for (const [id, stop, expected] of [
      [A, "toolUse", usageA],
      [B, "stop", usageB],
    ] as const) {
      const requested = {
        provider: model.provider,
        model: model.id,
        [responseLabel]: id,
      };
      const point = durations.histogram.dataPoints.find(
        (value: any) => labels(value)[responseLabel] === id,
      );
      assert(point);
      assert.equal(Number(point.count), 1);
      assert(point.explicitBounds.includes(5000));
      assert.deepEqual(labels(point), { ...requested, stop });
      const result = modelSpans.find(
        (span) => labels(span)[responseLabel] === id,
      );
      assert(result);
      assert.equal(labels(result).model, model.id);
      assert.equal(labels(result).stop, stop);
      const kinds = {
        input: expected.input,
        output: expected.output,
        cache_read: expected.cacheRead,
        cache_write: expected.cacheWrite,
      };
      for (const [kind, value] of Object.entries(kinds)) {
        const tokenPoint = tokens.sum.dataPoints.find(
          (point: any) =>
            labels(point)[responseLabel] === id && labels(point).kind === kind,
        );
        assert(tokenPoint);
        assert.deepEqual(labels(tokenPoint), { ...requested, kind });
        assert.equal(Number(tokenPoint.asDouble), value);
      }
      const costPoint = cost.sum.dataPoints.find(
        (point: any) => labels(point)[responseLabel] === id,
      );
      assert(costPoint);
      assert.deepEqual(labels(costPoint), requested);
      assert.equal(Number(costPoint.asDouble), expected.cost);
    }
    for (const name of [
      "pi.ai.first_chunk.duration",
      "pi.otel.usage.tokens",
      "pi.otel.usage.cost",
    ]) {
      const unchanged = measurement(requests, name);
      assert(!JSON.stringify(unchanged).includes(responseLabel));
    }
    assert(requests.some((request) => request.path === "/v1/logs"));
    assert(!JSON.stringify(requests).includes(PRIVATE));
  } finally {
    await otel.shutdown();
    await sink.close();
  }
}

export async function nativeMissingAbortedAndFailed() {
  const sink = await receiver();
  const otel = createPiOtel({
    endpoint: sink.endpoint,
    responseModels: config,
  });
  const native = createModels();
  native.setProvider(gateway(otel.responseModel.report));
  const models = otel.responseModel.nativeModels(native);
  try {
    await otel.telemetry.startSpan(
      { name: "pi.durable.phase" },
      async (parent) => {
        const base = { telemetry: parent, maxRetries: 0 };
        const fixture = (
          id?: string,
          requested?: string,
        ): ModelsSimpleStreamOptions => ({
          ...base,
          fetch: mockFetch(async () => sse(id, usageA, false, requested)),
        });
        assert.equal(
          (await models.complete(model, transcript, fixture())).responseModel,
          undefined,
        );
        assert.equal(
          (await models.completeSimple(model, transcript, fixture(rejectedId)))
            .responseModel,
          rejectedId,
        );
        const fixed = { ...model, id: "fixed-model" };
        assert.equal(
          (await models.complete(fixed, transcript, fixture(A, fixed.id)))
            .responseModel,
          A,
        );
        const before = new AbortController();
        const pre = await models.completeSimple(model, transcript, {
          ...fixture(),
          signal: before.signal,
          onResponse() {
            before.abort(new Error(PRIVATE));
          },
        });
        assert.equal(pre.stopReason, "aborted");
        assert.equal(pre.responseModel, undefined);
        const controller = new AbortController();
        const post = await models.completeSimple(model, transcript, {
          ...fixture(A),
          signal: controller.signal,
          onProviderStreamEvent(data: any) {
            if (data.choices[0]?.finish_reason)
              controller.abort(new Error(PRIVATE));
          },
        });
        assert.equal(post.stopReason, "aborted");
        assert.equal(post.responseModel, A);
        const failed = await models.completeSimple(model, transcript, {
          ...fixture(B),
          onProviderStreamEvent(data: any) {
            if (data.choices[0]?.finish_reason) throw new Error(PRIVATE);
          },
        });
        assert.equal(failed.stopReason, "error");
        assert.equal(failed.responseModel, B);
      },
    );
    const noParent = await models.completeSimple(model, transcript, {
      maxRetries: 0,
      fetch: mockFetch(async () => sse(A)),
    });
    assertResult(noParent, A, usageA);
    await setImmediate();
    assert(await otel.forceFlush());
    const traces = aiRequests(sink.requests).map(labels);
    assert.equal(traces.length, 6);
    assert.deepEqual(
      traces
        .filter((attrs) => attrs[responseLabel])
        .map((attrs) => [attrs[responseLabel], attrs.stop]),
      [
        [A, "aborted"],
        [B, "error"],
      ],
    );
    const points = measurement(sink.requests, "pi.ai.request.duration")
      .histogram.dataPoints;
    assert.equal(
      points.reduce((sum: number, point: any) => sum + Number(point.count), 0),
      6,
    );
    assert.equal(
      labels(points.find((point: any) => labels(point)[responseLabel] === A))
        .stop,
      "aborted",
    );
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  } finally {
    await otel.shutdown();
    await sink.close();
  }
}

export async function nativeOptOutAndExporterFailure() {
  const sink = await receiver(400);
  const native = createModels();
  async function run(otel: PiOtel) {
    native.setProvider(gateway(otel.responseModel.report));
    assert.equal(otel.responseModel.nativeModels(native), native);
    try {
      await otel.telemetry.startSpan(
        { name: "pi.durable.phase" },
        async (parent) => {
          const result = await native.completeSimple(model, transcript, {
            telemetry: parent,
            maxRetries: 0,
            fetch: mockFetch(async () => sse(A)),
          });
          assert.equal(result.stopReason, "stop", result.errorMessage);
          assertResult(result, A, usageA);
        },
      );
      await setImmediate();
      assert.equal(await otel.forceFlush(), false);
    } finally {
      await otel.shutdown();
    }
  }
  try {
    await run(createPiOtel({ endpoint: sink.endpoint }));
    await run(
      createPiOtel({
        endpoint: sink.endpoint,
        responseModels: { ...config, allowedIds: Array<string>(129).fill(A) },
      }),
    );
    assert.equal(aiRequests(sink.requests).length, 2);
    assert(!JSON.stringify(sink.requests).includes(responseLabel));
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  } finally {
    await sink.close();
  }
}
