import { test } from "bun:test";
import {
  nativeAttribution,
  nativeMissingAbortedAndFailed,
  nativeOptOutAndExporterFailure,
} from "./response-model-cases.ts";

test(
  "native Chat calls attribute exact usage on a shared parent",
  nativeAttribution,
);
test(
  "native Chat calls preserve missing, rejected, aborted and failed results",
  nativeMissingAbortedAndFailed,
);
test(
  "native Chat opt-out and exporter failure do not change the response",
  nativeOptOutAndExporterFailure,
);
