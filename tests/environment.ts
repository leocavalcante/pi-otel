// Keep fixtures local even when the developer normally exports telemetry remotely.
// No inherited telemetry endpoint, header, identity or certificate is used by tests.
for (const name of [
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "OTEL_SDK_DISABLED",
  "OTEL_METRIC_EXPORT_INTERVAL",
])
  delete process.env[name];
for (const signal of ["", "_TRACES", "_METRICS", "_LOGS"]) {
  for (const option of [
    "ENDPOINT",
    "HEADERS",
    "CERTIFICATE",
    "CLIENT_CERTIFICATE",
    "CLIENT_KEY",
    "COMPRESSION",
    "PROTOCOL",
  ]) {
    delete process.env[`OTEL_EXPORTER_OTLP${signal}_${option}`];
  }
}
