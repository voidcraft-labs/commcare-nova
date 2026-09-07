import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("native Python infrastructure suites discover and pass their policy and transport cases", () => {
	const result = spawnSync(
		"python3",
		["-B", "-m", "unittest", "discover", "-s", "scripts/infra/tests", "-v"],
		{ encoding: "utf8", timeout: 15_000 },
	);
	expect(result.status, result.stdout + result.stderr).toBe(0);
	expect(result.stderr).toMatch(/Ran [1-9][0-9]* tests/);
});
