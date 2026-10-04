/**
 * How the emission starts its child processes (the Vitest writers, the
 * document writers, HQ's self-check emitter), so what each writes depends
 * on its inputs and not on the machine or the shell it was started from:
 *
 * - each starts with the entropy preload (`./entropy.mts`) loaded first, so
 *   no module takes a reference to a generator before it is seeded;
 * - each runs with a whitelisted environment: the clock's zone and the
 *   locale fixed (`TZ=UTC`, `LANG=C.UTF-8`), `PATH` and `HOME` from the
 *   caller, and the entropy switches (`PROOF_ENTROPY`,
 *   `PROOF_ENTROPY_TRACE`) passed through, plus what the caller adds.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKTREE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

/** The entropy preload, by absolute path (`node --import`). */
export const ENTROPY_PRELOAD = join(WORKTREE, "proof", "corpus", "entropy.mts");

/** Node's options for a child that runs the corpus's TypeScript: the preload first, then tsx. */
export const NODE_EMISSION_ARGS: readonly string[] = [
	"--conditions=react-server",
	"--import",
	ENTROPY_PRELOAD,
	"--import",
	"tsx",
];

/** The environment variables a child inherits from the caller as they are. */
const PASSED_THROUGH = [
	"PATH",
	"HOME",
	"PROOF_ENTROPY",
	"PROOF_ENTROPY_TRACE",
] as const;

/** A child's whole environment: the whitelist, then `extra`. */
export function emissionEnv(
	extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
	const env: Record<string, string> = { TZ: "UTC", LANG: "C.UTF-8" };
	for (const name of PASSED_THROUGH) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	// Next's types declare NODE_ENV on every environment; a child's leaves it unset.
	return { ...env, ...extra } as NodeJS.ProcessEnv;
}
