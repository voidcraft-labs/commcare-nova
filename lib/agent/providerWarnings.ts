import type { LogWarningsFunction } from "ai";
import { log } from "@/lib/logger";

/**
 * The AI SDK reports provider warnings (a setting or schema keyword the
 * provider dropped or rewrote) for every model call through one process-wide
 * hook. Left unset, it prints them to stderr as unstructured text. This routes
 * them into Nova's structured log, once per call, for every role.
 */
export function logProviderWarnings(): void {
	const report: LogWarningsFunction = ({ warnings, provider, model }) =>
		log.warn("[ai-sdk] provider warning", { provider, model, warnings });
	globalThis.AI_SDK_LOG_WARNINGS = report;
}
