import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../lib/fixtures";
import {
	cleanupReactProfile,
	exportReactProfile,
	profilerCommand,
} from "./profiler";

interface SeedManifest {
	openAppId: string;
}

test("exports React component commits from a Builder interaction", async ({
	page,
}) => {
	const seed = JSON.parse(
		readFileSync(path.join(process.cwd(), "e2e", ".auth", "seed.json"), "utf8"),
	) as SeedManifest;
	await page.goto(`/build/${seed.openAppId}`);
	const collapse = page.getByRole("button", { name: "Collapse chat sidebar" });
	await expect(collapse).toBeVisible({ timeout: 30_000 });

	profilerCommand(["wait", "--connected", "--timeout=30"]);
	const status = profilerCommand(["status"]);
	expect(status).toContain("Apps: 1 connected");
	const count = profilerCommand(["count"]);
	expect(count).toMatch(/[1-9][0-9]* components/);

	profilerCommand(["profile", "start", "builder sidebar smoke"]);
	await collapse.click();
	const expand = page.getByRole("button", { name: "Expand chat sidebar" });
	await expect(expand).toBeVisible();
	await expand.click();
	await expect(collapse).toBeVisible();
	const stopped = profilerCommand(["profile", "stop"]);
	expect(stopped).toMatch(/[1-9][0-9]* commits?/);
	const output = exportReactProfile();

	const profile = JSON.parse(readFileSync(output, "utf8")) as {
		version?: number;
		dataForRoots?: Array<{ commitData?: unknown[] }>;
	};
	expect(profile.version).toBe(5);
	expect(profile.dataForRoots?.length).toBeGreaterThan(0);
	expect(
		profile.dataForRoots?.some((root) => (root.commitData?.length ?? 0) > 0),
	).toBe(true);
});

test.afterEach(() => {
	cleanupReactProfile();
});
