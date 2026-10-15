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
 * Better Auth also logs expected OAuth state expiry/misses at error level.
 * Only its known state-rejection shapes are reduced to sanitized info events.
 * Unknown state failures, security mismatches and adapter failures still reach
 * Sentry. Native callback tests pin this boundary to the installed provider.
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
	const stateRefusal = expectedOAuthStateRefusal(level, message, args);
	if (stateRefusal) {
		// StateError.details can contain the OAuth state token; never forward
		// that error or callback arguments for an expected rejection.
		sink.info("[better-auth] Sign-in attempt needs restarting", {
			event: "oauth_sign_in_rejected",
			reason: stateRefusal,
		});
		return;
	}
	const rest = args.filter((arg) => !(arg instanceof Error));
	const context = rest.length > 0 ? { args: rest } : undefined;
	if (level === "error") sink.error(text, error, context);
	else if (level === "warn") sink.warn(text, context);
	else sink.info(text, context);
}

/** Fail closed on provider changes: a new shape remains an error until audited. */
function expectedOAuthStateRefusal(
	level: BetterAuthLogLevel,
	message: string,
	args: unknown[],
): string | undefined {
	if (
		level === "error" &&
		message === "State not found" &&
		args.length <= 1 &&
		args.every((arg) => arg === undefined || typeof arg === "string")
	)
		return "state_parameter_missing";
	const errors = args.filter((arg) => arg instanceof Error);
	const error = errors[0];
	if (
		level !== "error" ||
		message !== "Failed to parse state" ||
		errors.length !== 1 ||
		!error ||
		error.name !== "BetterAuthError" ||
		error.cause !== undefined ||
		!("code" in error)
	)
		return undefined;
	if (error.code !== "state_mismatch") return undefined;
	switch (error.message) {
		case "State mismatch: verification not found":
			return "verification_missing";
		case "State mismatch: auth state cookie not found":
			return "state_cookie_missing";
		case "Invalid state: request expired":
			return "state_expired";
		default:
			return undefined;
	}
}
