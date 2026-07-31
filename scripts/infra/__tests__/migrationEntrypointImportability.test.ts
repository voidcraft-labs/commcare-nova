import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

describe("migration entrypoint importability", () => {
	test("the repository db:migrate command resolves server-only imports before touching the database", () => {
		const result = spawnSync(
			"npm",
			["run", "db:migrate", "--", "--entrypoint-importability-probe"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					...process.env,
					NOVA_DB_LOCAL_URL: "",
				},
			},
		);
		const output = `${result.stdout}\n${result.stderr}`;
		expect(result.status).toBe(1);
		expect(output).toContain(
			"Unknown migration argument(s): --entrypoint-importability-probe",
		);
		expect(output).not.toContain(
			"This module cannot be imported from a Client Component module",
		);
		expect(output).not.toContain("server-only");
		/* Spawns npm, which spawns tsx, which resolves the whole migration
		 * module graph — seconds of real work, not vitest's default 5s budget
		 * for an in-process assertion. A loaded CI runner exceeds that. */
	}, 60_000);
});
