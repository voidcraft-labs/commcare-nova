/**
 * Bridge Better Auth's internal logger into Nova's logger so auth errors reach
 * Sentry.
 *
 * Better Auth handles every `/api/auth/*` request inside its own router: it
 * catches failures, logs them through its built-in logger, and returns an HTTP
 * response rather than re-throwing. Two consequences for observability:
 *   - Next.js / Sentry auto-instrumentation never sees a thrown error (the
 *     handler returned a response), so it captures nothing; and
 *   - Nova's Sentry mirror fires only through `log.error` / `log.critical`
 *     (`lib/logger.ts`), which Better Auth's own logger never calls.
 * Without a bridge the entire auth surface — including 5xx server errors like a
 * crashing adapter — is invisible in Sentry. Wiring this as Better Auth's
 * `logger.log` routes its entries through Nova's logger: `error` reaches Sentry,
 * `warn` / `info` stay Cloud-Logging-only, matching every other server module.
 *
 * Expected client errors (4xx such as `invalid_grant`) are returned by Better
 * Auth without logging, so they never arrive here — they stay out of Sentry by
 * design, which is correct: a user mistyping a flow is not a bug to alert on.
 */
import { log } from "./logger";

/** The Better Auth log levels passed to a custom `logger.log` (excludes `success`). */
export type BetterAuthLogLevel = "debug" | "info" | "warn" | "error";

/**
 * The slice of Nova's `log` this bridge calls. Declared as an interface so tests
 * can inject a fake sink instead of asserting against Cloud Logging / Sentry.
 */
export interface AuthLogSink {
	error: (
		message: string,
		error?: unknown,
		context?: Record<string, unknown>,
	) => void;
	warn: (message: string, context?: Record<string, unknown>) => void;
	info: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Forward one Better Auth log entry into `sink`. The first `Error` among `args`
 * is passed as the error argument so `log.error` fingerprints Sentry issues on
 * its stack; any remaining args ride along as context. `debug` maps to `info`
 * (Better Auth emits no `debug` at its default level, so this is only a
 * safety net). `sink` defaults to the real logger; tests pass a fake.
 */
export function forwardBetterAuthLog(
	level: BetterAuthLogLevel,
	message: string,
	args: unknown[],
	sink: AuthLogSink = log,
): void {
	const text = `[better-auth] ${message}`;
	const error = args.find((arg) => arg instanceof Error);
	const rest = args.filter((arg) => !(arg instanceof Error));
	const context = rest.length > 0 ? { args: rest } : undefined;
	if (level === "error") sink.error(text, error, context);
	else if (level === "warn") sink.warn(text, context);
	else sink.info(text, context);
}
