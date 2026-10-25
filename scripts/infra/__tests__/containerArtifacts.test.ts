import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DockerfileParser, Run } from "dockerfile-ast";
import { describe, expect, test } from "vitest";
import jobs from "@/config/deployment-jobs.json";

/** The installed tree the platforms cutover's bundle loads sharp from. */
const SHARP_TREE = ["sharp", "@img", "detect-libc"] as const;

const dockerfile = DockerfileParser.parse(readFileSync("Dockerfile", "utf8"));
function stage(name: string) {
	const from = dockerfile
		.getFROMs()
		.find((item) => item.getBuildStage() === name);
	const image = from && dockerfile.getContainingImage(from.getRange().start);
	if (!image) throw new Error(`Missing Docker stage: ${name}`);
	return image;
}

function dependencies(name: string, seen = new Set<string>()): Set<string> {
	if (seen.has(name)) return seen;
	seen.add(name);
	const image = stage(name);
	const referenced = [
		...image.getFROMs().map((from) => from.getImage()),
		...image.getCOPYs().map((copy) =>
			copy
				.getFlags()
				.find((flag) => flag.getName() === "from")
				?.getValue(),
		),
		...image
			.getInstructions()
			.filter((item) => item instanceof Run)
			.flatMap((run) =>
				run
					.getFlags()
					.flatMap((flag) => flag.getOption("from")?.getValue() ?? []),
			),
	];
	for (const ref of referenced) {
		if (
			ref &&
			dockerfile.getFROMs().some((from) => from.getBuildStage() === ref)
		)
			dependencies(ref, seen);
	}
	return seen;
}

describe("container artifact declarations", () => {
	test("cache export has no dependency on compilation and operator repairs stay outside the runner", () => {
		expect(dependencies("next-cache-export")).toEqual(
			new Set(["next-cache-export", "cache-snapshot"]),
		);
		expect(dependencies("runner")).toEqual(
			new Set([
				"runner",
				"builder",
				"sources",
				"deps",
				"build-base",
				"cache-seed",
			]),
		);
		expect(dependencies("migration")).toEqual(
			new Set([
				"migration",
				"migration-build",
				"sources",
				"deps",
				"build-base",
				"job-runtime",
			]),
		);
		expect(dependencies("capture-worker")).toEqual(
			new Set([
				"capture-worker",
				"capture-build",
				"sources",
				"deps",
				"build-base",
				"job-runtime",
			]),
		);
		expect(
			stage("runner")
				.getCOPYs()
				.map((copy) => ({
					from: copy
						.getFlags()
						.find((flag) => flag.getName() === "from")
						?.getValue(),
					paths: copy.getArguments().map((arg) => arg.getValue()),
				})),
		).toEqual([
			{ from: "builder", paths: ["/app/public", "./public"] },
			{ from: "builder", paths: ["/app/.next/standalone", "./"] },
			{ from: "builder", paths: ["/app/.next/static", "./.next/static"] },
			{
				from: "deps",
				paths: ["/app/node_modules/@img", "./node_modules/@img"],
			},
		]);
		expect(
			stage("runner")
				.getCMDs()
				.flatMap((cmd) =>
					cmd.getJSONStrings().map((arg) => arg.getJSONValue()),
				),
		).toEqual(["node", "server.js"]);
	});

	test("private build credentials are ephemeral mounts, never image arguments or environment declarations", () => {
		const secrets = ["SENTRY_AUTH_TOKEN", "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY"];
		const args = dockerfile
			.getARGs()
			.flatMap((arg) => arg.getProperty()?.getName() ?? []);
		const env = dockerfile
			.getENVs()
			.flatMap((item) =>
				item.getProperties().map((property) => property.getName()),
			);
		for (const name of secrets) {
			expect(args).not.toContain(name);
			expect(env).not.toContain(name);
		}
		const builds = stage("builder")
			.getInstructions()
			.filter(
				(item) =>
					item instanceof Run &&
					item.getArguments().some((arg) => arg.getValue() === "build"),
			);
		expect(builds).toHaveLength(1);
		const build = builds[0];
		if (!(build instanceof Run)) throw new Error("Expected RUN");
		const mounts = build
			.getFlags()
			.filter((flag) => flag.getName() === "mount")
			.map((flag) =>
				Object.fromEntries(
					flag
						.getOptions()
						.map((option) => [option.getName(), option.getValue()]),
				),
			);
		expect(mounts).toEqual(
			expect.arrayContaining([
				{ type: "secret", id: "SENTRY_AUTH_TOKEN", env: "SENTRY_AUTH_TOKEN" },
				{
					type: "secret",
					id: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
					env: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
					required: "true",
				},
			]),
		);
	});

	test("the HQ round-trip platforms cutover runs a maintenance bundle of its migrate script on its own Job", () => {
		const bundles = stage("maintenance-build")
			.getInstructions()
			.filter((item) => item instanceof Run)
			.map((run) => run.getArguments().map((arg) => arg.getValue()));
		const cutover = bundles.filter((args) =>
			args.includes("--outfile=hq-round-trip-platforms.cjs"),
		);
		expect(cutover).toHaveLength(1);
		expect(cutover[0]?.slice(0, 3)).toEqual([
			"npx",
			"esbuild",
			"scripts/migrate-hq-round-trip-platforms.ts",
		]);
		expect(cutover[0]).toContain("--external:sharp");
		expect(cutover[0]).toContain("--external:pg-native");
		const copies = stage("maintenance")
			.getCOPYs()
			.filter(
				(copy) =>
					copy
						.getFlags()
						.find((flag) => flag.getName() === "from")
						?.getValue() === "deps",
			)
			.map((copy) => copy.getArguments().map((arg) => arg.getValue()));
		expect(copies).toEqual(
			SHARP_TREE.map((name) => [
				`/app/node_modules/${name}`,
				`./node_modules/${name}`,
			]),
		);
		expect(jobs["commcare-nova-hq-round-trip-platforms"]).toMatchObject({
			serviceAccount: "nova-migrate@commcare-nova.iam.gserviceaccount.com",
			command: ["node"],
			args: ["hq-round-trip-platforms.cjs"],
			maxRetries: 0,
			env: { NOVA_MEDIA_BUCKET: "nova-multimedia-prod" },
		});
		const ignored = readFileSync(".dockerignore", "utf8").split("\n");
		for (const line of [
			"!scripts/migrate-hq-round-trip-platforms.ts",
			"!scripts/lib/hqRoundTripPlatforms/",
			"scripts/lib/hqRoundTripPlatforms/__tests__/",
		]) {
			expect(ignored).toContain(line);
		}
		expect(dependencies("runner").has("maintenance-build")).toBe(false);

		const directory = mkdtempSync(join(tmpdir(), "nova-platforms-bundle-"));
		try {
			const output = join(directory, "hq-round-trip-platforms.cjs");
			const metafile = join(directory, "meta.json");
			const command = (cutover[0] ?? []).slice(2);
			execFileSync(
				resolve("node_modules/.bin/esbuild"),
				[
					...command.map((arg) =>
						arg.startsWith("--outfile=") ? `--outfile=${output}` : arg,
					),
					`--metafile=${metafile}`,
				],
				{ encoding: "utf8", stdio: "pipe", timeout: 20_000 },
			);
			/* Every package the bundle still requires at run time, from
			 * esbuild's own account of its external imports: only the two it
			 * leaves external, whatever Node itself provides aside. */
			const meta = JSON.parse(readFileSync(metafile, "utf8")) as {
				outputs: Record<
					string,
					{ imports: { path: string; external?: boolean }[] }
				>;
			};
			const builtins = new Set(builtinModules);
			const required = new Set(
				Object.values(meta.outputs)
					.flatMap((out) => out.imports)
					.filter((item) => item.external === true)
					.map((item) => item.path)
					.filter(
						(name) =>
							!name.startsWith("node:") &&
							!builtins.has(name.split("/")[0] as string),
					),
			);
			expect([...required].sort()).toEqual(["pg-native", "sharp"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);

	test("the authored job bundle commands produce self-contained operator executables", () => {
		const directory = mkdtempSync(join(tmpdir(), "nova-maintenance-bundles-"));
		try {
			const runs = [
				"migration-build",
				"capture-build",
				"maintenance-build",
			].flatMap((name) =>
				stage(name)
					.getInstructions()
					.filter((item) => item instanceof Run),
			);
			expect(runs.length).toBeGreaterThan(2);
			for (const run of runs) {
				const args = run.getArguments().map((arg) => arg.getValue());
				expect(args.slice(0, 2)).toEqual(["npx", "esbuild"]);
				// Execute the Dockerfile's actual esbuild flags, changing only the
				// output directory. This host check does not prove Docker context
				// filtering; the required production-image CI build owns that.
				const commandEnd = args.indexOf("&&");
				const command = args.slice(2, commandEnd < 0 ? undefined : commandEnd);
				const outputArg = command.find((arg) => arg.startsWith("--outfile="));
				if (!outputArg) throw new Error("Job bundle must name its output");
				const output = join(directory, outputArg.slice("--outfile=".length));
				execFileSync(
					resolve("node_modules/.bin/esbuild"),
					command.map((arg) =>
						arg === outputArg ? `--outfile=${output}` : arg,
					),
					{ encoding: "utf8", stdio: "pipe", timeout: 10_000 },
				);
				if (command[0].startsWith("scripts/migrate-")) {
					/* A bundle that leaves sharp external runs from a directory of
					 * its own whose node_modules holds exactly the tree the
					 * maintenance image copies beside it; every other bundle runs
					 * with no node_modules at all. */
					let cwd = directory;
					if (command.includes("--external:sharp")) {
						cwd = mkdtempSync(join(directory, "sharp-"));
						for (const name of SHARP_TREE) {
							mkdirSync(join(cwd, "node_modules", name, ".."), {
								recursive: true,
							});
							cpSync(
								resolve("node_modules", name),
								join(cwd, "node_modules", name),
								{ recursive: true },
							);
						}
						cpSync(output, join(cwd, "bundle.cjs"));
					}
					expect(
						execFileSync(
							process.execPath,
							[cwd === directory ? output : join(cwd, "bundle.cjs"), "--help"],
							{ cwd, encoding: "utf8", timeout: 10_000 },
						),
					).toContain("Usage:");
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
