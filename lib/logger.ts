/**
 * Structured logger for GCP Cloud Logging.
 *
 * Cloud Run captures stdout/stderr and auto-parses JSON lines with known
 * fields. By emitting structured JSON instead of plain `console.error`, we get:
 *
 * - **Severity filtering** — `severity` field maps to Cloud Logging levels
 * - **Error grouping** — `stack_trace` field feeds GCP Error Reporting
 * - **Searchable labels** — `logging.googleapis.com/labels` for filtering
 * - **Single-line entries** — no split log lines from multi-line stack traces
 *
 * In local dev, `NODE_ENV !== 'production'` falls back to `console.*` for
 * readable terminal output. In production (Cloud Run), emits JSON to
 * stdout/stderr for Cloud Logging ingestion.
 *
 * `error()` / `critical()` are TWO-channel: alongside the Cloud Logging
 * line they capture to Sentry (issue grouping, alerting, symbolicated
 * stacks). Sentry cannot see stdout, so this capture is how a
 * caught-and-logged server error becomes a Sentry issue — every server
 * error path already funnels through here (route catch blocks,
 * `handleApiError`, the MCP error serializer, the agent's `emitError`).
 * `info()` / `warn()` stay Cloud Logging-only: `warn` deliberately covers
 * expected external conditions (provider rate limits, overload) that
 * would flood Sentry's issue stream with non-bugs.
 */

import * as Sentry from "@sentry/nextjs";

// ── Types ──────────────────────────────────────────────────────────────

type Severity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";

/** Structured log entry matching Cloud Logging's JSON payload format. */
interface LogPayload {
	severity: Severity;
	message: string;
	time: string;
	/** GCP Error Reporting uses this field to group related errors by stack. */
	stack_trace?: string;
	/** Custom labels — appear as filterable fields in Cloud Logging Explorer. */
	"logging.googleapis.com/labels"?: Record<string, string>;
}

/**
 * Arbitrary context attached to a log entry. Callers pass domain values
 * (uuids, arrays, nested objects, Errors). In local dev these flow
 * through to `console.*` which pretty-prints them; in production each
 * value is coerced to a string so GCP's labels contract
 * (string-only values) is satisfied.
 */
export type LogContext = Record<string, unknown>;

/** Options for `log.error`. */
export interface LogErrorOptions {
	/**
	 * Set false ONLY when the error already reached Sentry at its source
	 * and a second capture here would duplicate the issue. Today that's
	 * just `/api/log/error`, which relays browser errors the Sentry
	 * client SDK captured first-hand.
	 */
	sentry?: boolean;
}

// ── Internal ───────────────────────────────────────────────────────────

const isProduction = process.env.NODE_ENV === "production";

/**
 * Extract a clean stack trace from an error, stripping the first line
 * (which is just the error message repeated) so `stack_trace` contains
 * only the frame information GCP Error Reporting needs for grouping.
 */
function extractStack(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.stack) return undefined;
	return error.stack;
}

/**
 * Emit a structured JSON log entry to the appropriate stream.
 * ERROR/CRITICAL go to stderr, everything else to stdout — matching
 * Cloud Logging's default severity mapping for Cloud Run.
 */
function emit(payload: LogPayload): void {
	const stream =
		payload.severity === "ERROR" || payload.severity === "CRITICAL"
			? process.stderr
			: process.stdout;
	stream.write(`${JSON.stringify(payload)}\n`);
}

/**
 * Mirror an error/critical entry to Sentry. `captureException` when the
 * caller passed a thrown value — Sentry fingerprints on its stack, which
 * groups far better than message text — and `captureMessage` otherwise.
 * The log message + context ride along as `extra` so the Sentry issue
 * carries the same detail as the Cloud Logging line. The SDK never
 * throws and no-ops when uninitialized (e.g. unit tests).
 */
function captureToSentry(
	level: "error" | "fatal",
	message: string,
	error: unknown,
	context: LogContext | undefined,
): void {
	const capture = { level, extra: { log_message: message, ...context } };
	if (error !== undefined) {
		Sentry.captureException(error, capture);
	} else {
		Sentry.captureMessage(message, capture);
	}
}

/**
 * Coerce arbitrary context values into GCP-compatible string labels.
 * Strings pass through; everything else is JSON-serialized so array and
 * object context survives the label boundary in a queryable form.
 */
function stringifyLabels(
	context: LogContext,
): Record<string, string> | undefined {
	const entries = Object.entries(context);
	if (entries.length === 0) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of entries) {
		result[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return result;
}

// ── Public API ─────────────────────────────────────────────────────────

export const log = {
	/**
	 * Log an informational message. Useful for request lifecycle events,
	 * startup diagnostics, or audit trail entries.
	 */
	info(message: string, context?: LogContext): void {
		if (!isProduction) {
			if (context && Object.keys(context).length > 0)
				console.log(message, context);
			else console.log(message);
			return;
		}
		emit({
			severity: "INFO",
			message,
			time: new Date().toISOString(),
			...(context && {
				"logging.googleapis.com/labels": stringifyLabels(context),
			}),
		});
	},

	/**
	 * Log a warning — something unexpected happened but the operation can
	 * continue. Retryable failures, degraded functionality, fallback paths.
	 */
	warn(message: string, context?: LogContext): void {
		if (!isProduction) {
			if (context && Object.keys(context).length > 0)
				console.warn(message, context);
			else console.warn(message);
			return;
		}
		emit({
			severity: "WARNING",
			message,
			time: new Date().toISOString(),
			...(context && {
				"logging.googleapis.com/labels": stringifyLabels(context),
			}),
		});
	},

	/**
	 * Log an error with optional error object for stack trace extraction.
	 * The stack trace is placed in `stack_trace` so GCP Error Reporting
	 * can group related errors by their origin point.
	 *
	 * @param message - Human-readable description of what went wrong
	 * @param error - The caught error/exception (stack extracted automatically)
	 * @param context - Arbitrary labels for Cloud Logging filtering
	 * @param options - `{ sentry: false }` skips the Sentry mirror; see `LogErrorOptions`
	 */
	error(
		message: string,
		error?: unknown,
		context?: LogContext,
		options?: LogErrorOptions,
	): void {
		if (options?.sentry !== false) {
			captureToSentry("error", message, error, context);
		}
		if (!isProduction) {
			if (error !== undefined) {
				if (context && Object.keys(context).length > 0)
					console.error(message, context, error);
				else console.error(message, error);
			} else {
				if (context && Object.keys(context).length > 0)
					console.error(message, context);
				else console.error(message);
			}
			return;
		}
		emit({
			severity: "ERROR",
			message,
			time: new Date().toISOString(),
			stack_trace: extractStack(error),
			...(context && {
				"logging.googleapis.com/labels": stringifyLabels(context),
			}),
		});
	},

	/**
	 * Log a critical/fatal error — the process or request is in an
	 * unrecoverable state. Use sparingly; most errors should use `error()`.
	 */
	critical(message: string, error?: unknown, context?: LogContext): void {
		captureToSentry("fatal", message, error, context);
		if (!isProduction) {
			const prefixed = `[CRITICAL] ${message}`;
			if (error !== undefined) {
				if (context && Object.keys(context).length > 0)
					console.error(prefixed, context, error);
				else console.error(prefixed, error);
			} else {
				if (context && Object.keys(context).length > 0)
					console.error(prefixed, context);
				else console.error(prefixed);
			}
			return;
		}
		emit({
			severity: "CRITICAL",
			message,
			time: new Date().toISOString(),
			stack_trace: extractStack(error),
			...(context && {
				"logging.googleapis.com/labels": stringifyLabels(context),
			}),
		});
	},
};
