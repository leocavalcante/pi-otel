import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiOtel } from "../src/index.ts";
import { receiver, spans, metrics } from "./receiver.ts";

const PRIVATE = "SYNTHETIC_PRIVATE_CONTENT_NOT_TELEMETRY";
test("real Durable Harness, faux model and harmless tool export native spans and usage without content", async () => {
  const sink = await receiver();
  const otel = createPiOtel({ endpoint: sink.endpoint });
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("example_tool", { text: PRIVATE }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(PRIVATE),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  let calls = 0;
  registry.install(
    defineExtension({
      name: "fixture",
      tools: [
        defineTool({
          name: "example_tool",
          description: "Harmless synthetic tool",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          execute() {
            calls++;
            return Promise.resolve({
              output: [{ type: "text", text: PRIVATE }],
            });
          },
        }),
      ],
    }),
  );
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      telemetry: otel.telemetry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  try {
    const model = faux.getModel();
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const submission = await root.submit(
      { type: "input", content: [{ type: "text", text: PRIVATE }] },
      context,
    );
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(calls, 1);
    assert.equal(faux.state.callCount, 2);
    await otel.observeDurable(harness, context);
    assert(await otel.forceFlush());
    assert(spans(sink.requests).some((span) => span.name === "pi.ai.request"));
    assert(
      spans(sink.requests).some(
        (span) =>
          span.name === "pi.durable.phase" &&
          span.attributes?.some(
            (attribute: any) =>
              attribute.key === "task.name" &&
              attribute.value.stringValue === "pi.tool",
          ),
      ),
    );
    assert(
      metrics(sink.requests).some(
        (metric) => metric.name === "pi.otel.tool.attempts",
      ),
    );
    assert(
      metrics(sink.requests).some(
        (metric) => metric.name === "pi.otel.usage.tokens",
      ),
    );
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  } finally {
    await harness.close(context);
    await otel.shutdown();
    await sink.close();
  }
});

test("actual coding-agent SDK and real extension lifecycle observe a faux tool exchange", async () => {
  const sink = await receiver();
  const directory = await mkdtemp(join(tmpdir(), "pi-otel-fixture-"));
  const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = sink.endpoint;
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models-cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("example_tool", { text: PRIVATE }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(PRIVATE),
  ]);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resources = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Synthetic test fixture.",
    additionalExtensionPaths: [
      fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
    ],
  });
  let session:
    Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let toolCalls = 0;
  try {
    await resources.reload();
    assert.equal(resources.getExtensions().errors.length, 0);
    ({ session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      model: faux.getModel(),
      tools: ["example_tool"],
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      resourceLoader: resources,
      customTools: [
        {
          name: "example_tool",
          label: "Example",
          description: "Harmless fixture",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          execute() {
            toolCalls++;
            return Promise.resolve({
              content: [{ type: "text", text: PRIVATE }],
              details: {},
            });
          },
        },
      ],
    }));
    await session.bindExtensions({});
    await session.prompt(PRIVATE);
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    assert.equal(toolCalls, 1);
    assert.equal(faux.state.callCount, 2);
    const records = spans(sink.requests);
    assert(records.some((span) => span.name === "pi.coding.run"));
    assert(records.some((span) => span.name === "pi.coding.model"));
    assert(records.some((span) => span.name === "pi.coding.tool"));
    assert(
      metrics(sink.requests).some(
        (metric) => metric.name === "pi.coding.tool.results",
      ),
    );
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  } finally {
    session?.dispose();
    await sink.close();
    await rm(directory, { recursive: true });
    if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous;
  }
});
