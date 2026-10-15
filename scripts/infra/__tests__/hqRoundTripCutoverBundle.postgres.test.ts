/**
 * The HQ round-trip emission cutover's Job bundle, built with the
 * `Dockerfile`'s own `maintenance-build` command, starts as the Job starts
 * it (its stored arguments, the dry run) against a migrated database, prints
 * its content-free report and exits cleanly, with nothing written.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DockerfileParser, Run } from "dockerfile-ast";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import jobs from "@/config/deployment-jobs.json";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	fixtureApp,
	seedFixtureApp,
} from "@/scripts/lib/hqRoundTripCutover/__tests__/fixtures/seed";

const run = promisify(execFile);
const h = setupAppStateTestDb("hq_cutover_bundle_", { authSchema: "migrated" });

/** The `maintenance-build` esbuild arguments that write the cutover bundle. */
function cutoverBundleCommand(): string[] {
	const dockerfile = DockerfileParser.parse(readFileSync("Dockerfile", "utf8"));
	for (const instruction of dockerfile.getInstructions()) {
		if (!(instruction instanceof Run)) continue;
		const args = instruction.getArguments().map((arg) => arg.getValue());
		if (args.includes("--outfile=hq-round-trip-cutover.cjs")) {
			expect(args.slice(0, 2)).toEqual(["npx", "esbuild"]);
			return args.slice(2);
		}
	}
	throw new Error("The Dockerfile builds no hq-round-trip-cutover.cjs.");
}

describe("the cutover Job's bundle", () => {
	it("runs its stored arguments, the dry run, and writes nothing", async () => {
		const job = jobs["commcare-nova-hq-round-trip-cutover"];
		expect(job.args).toEqual(["hq-round-trip-cutover.cjs"]);
		await h.seedProjectMember("owner-bundle", "project-bundle", "owner");
		await seedFixtureApp(
			h.db(),
			fixtureApp("navigation-base", {
				appId: "app-bundle",
				projectId: "project-bundle",
				owner: "owner-bundle",
			}),
		);
		const directory = mkdtempSync(join(tmpdir(), "nova-cutover-bundle-"));
		try {
			const command = cutoverBundleCommand();
			await run(
				resolve("node_modules/.bin/esbuild"),
				command.map((arg) =>
					arg === "--outfile=hq-round-trip-cutover.cjs"
						? `--outfile=${join(directory, "hq-round-trip-cutover.cjs")}`
						: arg,
				),
				{ timeout: 60_000 },
			);
			const image = async () =>
				(
					await sql<{ row: string }>`
						SELECT concat_ws('|', (SELECT string_agg(a::text, ',' ORDER BY a.id) FROM apps a),
							(SELECT string_agg(c::text, ',' ORDER BY c.app_id, c.seq) FROM app_changes c),
							(SELECT count(*)::text FROM app_migration_notices)) AS row
					`.execute(h.db())
				).rows[0]?.row;
			const before = await image();
			const env: Record<string, string> = {
				PATH: process.env.PATH ?? "",
				NOVA_DB_LOCAL_URL: h.uri(),
				NOVA_DB_WORKLOAD: "migration",
			};
			const { stdout } = await run(process.execPath, job.args, {
				cwd: directory,
				timeout: 120_000,
				env: env as NodeJS.ProcessEnv,
			});
			const lines = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(lines[0]).toMatchObject({
				report: "hq-round-trip-emission",
				mode: "dry-run",
				section: "fleet",
				apps: 1,
			});
			expect(lines.at(-1)).toMatchObject({ section: "outcome", outcome: "ok" });
			expect(await image()).toBe(before);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 180_000);
});
