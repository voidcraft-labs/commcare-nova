// Source structure confines app writes to their database owners. Holder safety,
// locking and rollback are proved by the real Postgres lifecycle/commit suites,
// not by counting calls or finding a predicate in a function's source text.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function productionTypeScriptFiles(dir: string): string[] {
	return readdirSync(join(process.cwd(), dir), {
		recursive: true,
		encoding: "utf8",
	})
		.filter(
			(path) =>
				(path.endsWith(".ts") || path.endsWith(".tsx")) &&
				!path.includes("__tests__") &&
				!path.endsWith(".test.ts") &&
				!path.endsWith(".test.tsx") &&
				!path.includes("migrations/"),
		)
		.map((path) => `${dir}/${path}`);
}

function source(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf8");
}

it("confines app-table DML to database owners and reviewed operator migrations", () => {
	const appDml =
		/\.(?:insertInto|updateTable|deleteFrom|truncateTable)\(\s*["']apps["']\s*\)/;
	const writers = ["lib", "app", "scripts"]
		.flatMap(productionTypeScriptFiles)
		.filter((path) => appDml.test(source(path)))
		.sort();
	expect(writers).toEqual([
		"lib/db/appGenesis.ts",
		"lib/db/apps.ts",
		"lib/db/canonicalCommitKernel.ts",
		"lib/db/credits.ts",
		"scripts/lib/languageIdentityRepair.ts",
		"scripts/lib/repairAuthoringBaselines.ts",
	]);
});
