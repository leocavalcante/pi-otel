import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createPiOtel, type PiOtel, type CodingEvent } from './index.ts';

/** Pi package entrypoint. Observation only: no tools, prompt changes or control hooks. */
export default function extension(pi: ExtensionAPI): void {
  let otel: PiOtel | undefined;
  let observer: ReturnType<PiOtel['codingObserver']> | undefined;
  pi.on('session_start', () => {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_SDK_DISABLED === 'true') return;
    try {
      otel = createPiOtel({ serviceName: process.env.OTEL_SERVICE_NAME ?? 'pi-coding-agent' });
      observer = otel.codingObserver();
    } catch { console.error('pi-otel: invalid configuration; telemetry is disabled.'); }
  });
  const observe = (value: unknown) => { observer?.handle(value as CodingEvent); };
  pi.on('agent_start', observe);
  pi.on('agent_settled', observe);
  pi.on('message_start', observe);
  pi.on('message_update', observe);
  pi.on('message_end', observe);
  pi.on('tool_execution_start', observe);
  pi.on('tool_execution_end', observe);
  pi.on('session_shutdown', async () => {
    observer?.close(); observer = undefined;
    const current = otel; otel = undefined;
    await current?.shutdown();
  });
}
