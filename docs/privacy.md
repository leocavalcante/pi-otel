# Telemetry privacy boundary

The adapter records operational metadata, not model or tool content. No automatic HTTP, filesystem, process or stdout instrumentation is installed.

## Export policy

`src/privacy.ts` enumerates allowed span, event and metric fields. Unknown fields and events are discarded; unknown span names become `pi.operation`. Trace status descriptions, exception events, messages, stacks and link attributes are removed. Only fixed error categories remain. Known credential-like identifier prefixes are rejected as an additional guard, not a complete secret detector.

Lifecycle log bodies are fixed span names with `.completed`. Attributes come from the same allowlist. The coding observer reads only event type, role, requested and reported model identifiers, usage, stop reason, tool identifier, duration, outcome and abort metadata. It never stores or projects message content, tool args/results, deltas or error text.

The explicit SDK ModelRuntime facade observes the existing public lazy-stream forwarding path, reads only timing/usage/block metadata and never retains deltas, message bodies or auth overrides. It does not implement authentication or retry operations.

The generic callback adapter temporarily holds explicit Pi metadata for contract conformance; export-time filtering is the outbound security boundary. Private free-form errors supplied by Pi do not reach OTLP.

Resource attributes are limited to service name/namespace/version, a random process instance ID, and adapter identification. Environment, host name, process arguments, filesystem paths and arbitrary `OTEL_RESOURCE_ATTRIBUTES` are not automatically detected. OTLP authentication headers remain transport configuration, never resource fields or log attributes.

## Response model opt-in

Configure `responseModels` for one exact requested provider/model pair. pi-otel takes a copy of the reviewed allowlist and preserves case and punctuation. It accepts up to 128 entries and disables attribution for larger lists. It skips empty IDs, the requested ID, IDs longer than 128 characters, invalid identifier characters, URLs, and known credential-like prefixes. These checks are not a secret detector. Review each new alias before adding it to your configuration.

The native bridge accepts a scalar ID and the active request's telemetry scope. It does not inspect or retain a provider's response events. The SDK ModelRuntime and coding observers read only the final assistant message's metadata. All three paths use the same policy. The exporter checks it again before sending model completion attributes. Response IDs, first-chunk timing labels, ledger labels, and resource attributes do not gain any response-model data.

## Remaining metadata

Provider/model names, tool/task names, operational IDs and numeric usage/timing remain observable. These can reveal activity. Operators must choose non-sensitive service/tool identifiers, control collector access and configure retention. W3C trace state is caller-owned opaque correlation metadata; do not put secrets there. Trace identity is never authorization.

Metric labels are explicitly bounded to provider and requested model, allowlisted response model on model completions, token kind, stop/outcome, task/phase, tool, fixed report category and fixed export signal as appropriate. Task, submission, response and tool-call IDs are not metric labels. Distinct dynamically generated model/tool names can still create cardinality; the adapter cannot make those identifiers finite.

## Failure behavior

Export failure does not reject business callbacks. SDK diagnostic errors are replaced with a fixed message before entering upstream completion callbacks. Flush/shutdown return a success boolean. Hard termination and exporter queues can lose diagnostics; accounting stays in Durable.

The collector is not a universal sanitizer. Do not forward arbitrary application logs or enable unrelated automatic instrumentation under the assumption that this policy covers it. Configure credentials through a private environment or secret store, never in public source or example URLs.

Tests inject synthetic private markers into prompts, model output, tool arguments/results and errors, then inspect actual HTTP bodies. Passing these tests supports the listed paths, not every possible application configuration.
