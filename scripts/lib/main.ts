/**
 * Shared entry-point wrappers for diagnostic scripts.
 *
 * `runMain` is the fatal-error handler every script ends with — exits 1
 * on any uncaught rejection with the error logged prefixed by "Fatal:".
 *
 * `requireArg` tightens commander's loose `program.args: string[]`
 * typing. Commander guarantees a `<required>` positional is populated
 * (it errors at `program.parse()` otherwise), but `args[0]` still widens
 * to `string | undefined`. This helper produces the `string` the call
 * sites actually use; the assertion doubles as a runtime trip-wire if
 * commander's invariant is ever bypassed (e.g. someone calls the
 * script's module programmatically).
 */

export function runMain(fn: () => Promise<void>): void {
	fn().catch((err) => {
		console.error("Fatal:", err);
		process.exit(1);
	});
}

export function requireArg(
	args: string[],
	index: number,
	name: string,
): string {
	const value = args[index];
	if (value === undefined || value === "") {
		throw new Error(
			`missing required argument: ${name} — commander invariant violated`,
		);
	}
	return value;
}
