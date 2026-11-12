import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { once } from "node:events";

export async function receiver(status = 200) {
  const requests: {
    path: string;
    body: any;
    headers: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let bytes = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip")
      bytes = gunzipSync(bytes);
    requests.push({
      path: request.url!,
      body: JSON.parse(bytes.toString()),
      headers: { ...request.headers },
    });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      status === 200 ? "{}" : '{"message":"Synthetic backend unavailable"}',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture listener unavailable");
  return {
    requests,
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export function spans(
  requests: Awaited<ReturnType<typeof receiver>>["requests"],
): any[] {
  return requests
    .flatMap((request) => request.body.resourceSpans ?? [])
    .flatMap((resource) => resource.scopeSpans ?? [])
    .flatMap((scope) => scope.spans ?? []);
}
export function metrics(
  requests: Awaited<ReturnType<typeof receiver>>["requests"],
): any[] {
  return requests
    .flatMap((request) => request.body.resourceMetrics ?? [])
    .flatMap((resource) => resource.scopeMetrics ?? [])
    .flatMap((scope) => scope.metrics ?? []);
}
