import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("deployment infrastructure and cache failure paths", () => {
	expect(() =>
		execFileSync(
			"python3",
			["-B", "-m", "unittest", "discover", "-s", "scripts/infra/tests", "-v"],
			{ encoding: "utf8", stdio: "pipe" },
		),
	).not.toThrow();
});
