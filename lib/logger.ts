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
 */

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
	 */
	error(message: string, error?: unknown, context?: LogContext): void {
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
