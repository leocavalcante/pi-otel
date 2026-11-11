import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

test("the extension loads on Node.js and registers observation-only hooks", async () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = {
    on(name: string, handler: (event: unknown) => unknown) {
      assert(!handlers.has(name), `Duplicate hook: ${name}`);
      handlers.set(name, handler);
    },
  };

  // Only on() is supplied: registering tools, commands, or controls fails here.
  extension(pi as unknown as ExtensionAPI);
  assert.deepEqual([...handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "message_end",
    "message_start",
    "message_update",
    "session_shutdown",
    "session_start",
    "tool_execution_end",
    "tool_execution_start",
  ]);

  // The test preload clears inherited OTLP settings. With no collector configured,
  // startup, observation, shutdown, and a reload are harmless and network-free.
  assert.equal(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  for (let cycle = 0; cycle < 2; cycle++) {
    await handlers.get("session_start")?.({ type: "session_start" });
    await handlers.get("agent_start")?.({ type: "agent_start" });
    await handlers.get("agent_settled")?.({ type: "agent_settled" });
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" });
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" });
  }
});
