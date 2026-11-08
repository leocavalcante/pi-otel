// Run from a built source checkout with:
// OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node --experimental-strip-types examples/durable.ts
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { createPiOtel } from '../src/index.ts';

const faux = fauxProvider({ tokensPerSecond: 100000 });
faux.setResponses([fauxAssistantMessage('A synthetic answer, never a telemetry body.')]);
const models = createModels(); models.setProvider(faux.provider);
const otel = createPiOtel({ serviceName: 'example-agent' });
const context = BACKGROUND_CONTEXT;
const model = faux.getModel();
const harness = await Harness.open(new MemoryStorage(), {
  models, registry: createRegistry(), telemetry: otel.telemetry,
}, context);
try {
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const submission = await root.submit({ type: 'input', content: [{ type: 'text', text: 'Synthetic input, never exported.' }] }, context);
  await submission.wait(context);
  await otel.observeDurable(harness, context);
  console.log('Synthetic Durable request completed. No remote model was used.');
  await otel.forceFlush();
} finally {
  await harness.close(context);
  await otel.shutdown();
}
