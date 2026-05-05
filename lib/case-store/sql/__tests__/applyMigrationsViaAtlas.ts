// lib/case-store/sql/__tests__/applyMigrationsViaAtlas.ts
//
// Shared atlas shell-out helper. Two test surfaces consume it:
//
//   - `globalSetup.ts` — applies the migrations once per
//     `vitest run` against the testcontainer's shared database.
//   - `postgres/__tests__/store.test.ts` — applies the migrations
//     into each per-test database (fresh databases that the
//     `setupPerTestDatabase` helper provisions).
//
// Both call `atlas migrate apply --env testcontainer --url <uri>
// --allow-dirty`. The `--allow-dirty` rationale lives in
// `lib/case-store/CLAUDE.md` § Production: Cloud Run startup CMD.

import { spawnSync } from "node:child_process";

/**
 * Apply pending migrations via atlas against the supplied
 * connection URI. Throws on any failure — atlas binary missing
 * (ENOENT), non-zero exit status, or a child-process spawn error.
 *
 * `stdio` defaults to `"inherit"` so atlas's progress + error
 * output flows straight into the test runner's stderr (the
 * `globalSetup.ts` shape). Pass `"pipe"` to capture stdout/stderr
 * inside the failure message instead — useful in `beforeEach` hooks
 * where atlas's per-test output would otherwise drown the test run
 * (`store.test.ts` shape).
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
				"atlas: command not found. Install Atlas via " +
					"`brew install ariga/tap/atlas` or " +
					"`curl -sSf https://atlasgo.sh | sh` and re-run.",
			);
		}
		throw result.error;
	}

	if (result.status !== 0) {
		// `pipe` mode captured atlas's output strings; surface them in
		// the error message so the failure is self-contained. `inherit`
		// mode wrote them straight to stderr already.
		const captured =
			stdio === "pipe"
				? `\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
				: "";
		throw new Error(
			`atlas migrate apply failed with exit status ${result.status ?? "(null)"}${captured}`,
		);
	}
}
