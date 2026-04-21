// lib/utils/assertNever.ts
//
// Exhaustiveness helper for discriminated-union switches. A `default`
// case that calls `assertNever(value)` forces TypeScript to verify at
// compile time that every variant of the union was handled — any
// missing case makes the still-live value unassignable to `never` and
// fails `tsc`. At runtime the function throws if reached, so an
// unexpected value (e.g. one that slipped in through a wire-format
// boundary that skipped validation) surfaces loudly instead of
// silently falling through.
//
// Used by every exhaustive switch across the codebase — field-kind
// renderers, mutation reducers, and anywhere else a discriminated
// union is dispatched on. One definition prevents the drift that
// duplicated copies would introduce.

/**
 * Assert that control never reaches this point.
 *
 * `context` is an optional human-readable label identifying the caller;
 * it's prefixed onto the thrown error to make debugging clearer when
 * the assertion fires in production logs.
 */
export function assertNever(x: never, context?: string): never {
	const prefix = context ? `${context}: ` : "";
	throw new Error(
		`${prefix}unreachable: unexpected value ${JSON.stringify(x)}`,
	);
}
