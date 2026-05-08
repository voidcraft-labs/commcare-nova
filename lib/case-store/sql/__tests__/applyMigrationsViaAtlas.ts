// lib/case-store/sql/__tests__/applyMigrationsViaAtlas.ts
//
// Shared atlas shell-out for `globalSetup.ts` (shared database)
// and per-test databases (`setupPerTestDatabase`). `--allow-dirty`
// suppresses Atlas's empty-database precondition check; the
// testcontainer image has the postgis-managed `tiger` and
// `topology` schemas pre-installed before atlas runs, so the
// "database is non-empty" warning is expected and benign.

import { spawnSync } from "node:child_process";
import { compilerBugMessage } from "@/lib/domain/predicate/errors";

/**
 * Apply pending migrations via atlas. `stdio: "inherit"`
 * (default) flows progress to the test runner's stderr; `"pipe"`
 * captures into the failure message instead — useful for
 * `beforeEach` hooks where per-test atlas output would drown the
 * run.
 */
export function applyMigrationsViaAtlas(
	uri: string,
	options: { stdio?: "inherit" | "pipe" } = {},
): void {
	const stdio = options.stdio ?? "inherit";
	const result = spawnSync(
		"atlas",
		[
			"migrate",
			"apply",
			"--env",
			"testcontainer",
			"--url",
			uri,
			"--allow-dirty",
		],
		stdio === "pipe"
			? { stdio: "pipe", encoding: "utf8" }
			: { stdio: "inherit" },
	);

	if (result.error !== undefined) {
		const code = (result.error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new Error(
				compilerBugMessage({
					where: "case-store.applyMigrationsViaAtlas",
					invariant:
						"`atlas` is not on `PATH`; the testcontainers harness shells out to the atlas binary and cannot proceed without it",
					detail:
						"Install Atlas via `brew install ariga/tap/atlas` (macOS) or `curl -sSf https://atlasgo.sh | sh` (Linux). On macOS systems where the brew tap fails on Command Line Tools incompatibility, download the community binary directly from `https://release.ariga.io/atlas/atlas-community-<os>-<arch>-latest` and place it on `PATH`.\n\nHint: re-run the test command once `atlas --version` works in the same shell.",
				}),
			);
		}
		throw result.error;
	}

	if (result.status !== 0) {
		// `pipe` mode surfaces captured output in the message;
		// `inherit` mode already wrote it to stderr.
		const captured =
			stdio === "pipe"
				? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
				: "";
		throw new Error(
			compilerBugMessage({
				where: "case-store.applyMigrationsViaAtlas",
				invariant: `\`atlas migrate apply\` exited with status ${result.status ?? "(null)"}`,
				detail: `${captured}\n\nHint: inspect the captured output above (or stderr in \`inherit\` mode) for the failing migration's name. The most common causes are an authoring-time SQL syntax error in the new migration file or a destructive change that lint should have rejected upstream.`,
			}),
		);
	}
}
