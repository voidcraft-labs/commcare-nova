import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	PersistedJsonRejectedError,
	parsePersistedAppChangeEnvelope,
	parsePersistedJsonText,
} from "../persistedJson";
import {
	APP_LIFECYCLE_STATUSES,
	parsePersistedAppLifecycleStatus,
} from "../types";

const expandedTiny = (lastDigit: string) => `0.${"0".repeat(323)}${lastDigit}`;

describe("parsePersistedJsonText", () => {
	it.each([
		["0", 0],
		["0.1", 0.1],
		["1.5", 1.5],
		["9007199254740991", Number.MAX_SAFE_INTEGER],
		["-9007199254740991", Number.MIN_SAFE_INTEGER],
		[expandedTiny("5"), Number.MIN_VALUE],
		[`-${expandedTiny("5")}`, -Number.MIN_VALUE],
	])("admits the canonical persisted token %s", (token, expected) => {
		expect(parsePersistedJsonText(token)).toBe(expected);
	});

	it.each([
		"-0",
		"0.0",
		"1.50",
		"1.230",
		"0.10000000000000001",
		"9007199254740992",
		"-9007199254740992",
		"9007199254740993",
		`1${"0".repeat(309)}`,
		expandedTiny("1"),
		"1e3",
		"10e2",
		"1E+3",
		"1e-7",
		"5e-324",
	])("rejects the aliased or noncanonical persisted token %s", (token) => {
		expect(() => parsePersistedJsonText(token)).toThrow(
			PersistedJsonRejectedError,
		);
	});

	it("preserves prototype-shaped keys as own null-prototype data", () => {
		const parsed = parsePersistedJsonText(
			'{"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
		) as Record<string, unknown>;
		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
		expect(Object.hasOwn(parsed, "constructor")).toBe(true);
		expect(Object.hasOwn(parsed, "prototype")).toBe(true);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it("rejects duplicate object keys instead of choosing one value", () => {
		expect(() =>
			parsePersistedJsonText('{"name":"first","name":"last"}'),
		).toThrow(/duplicate object key/);
	});

	it("does not echo persisted values in rejection messages", () => {
		const secretToken = "0.10000000000000001";
		const secretString = "private-carrier-value";
		for (const [payload, sentinel] of [
			[secretToken, secretToken],
			[`"${secretString}\\uZZZZ"`, secretString],
		]) {
			expect(() =>
				parsePersistedJsonText(payload, "test carrier"),
			).toThrowError(
				expect.objectContaining({
					message: expect.not.stringContaining(sentinel),
				}),
			);
		}
	});
});

describe("persisted sequence protocol", () => {
	it.each([
		["0", 0],
		[0, 0],
		[String(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 1],
		[String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
	])("admits the safe sequence %s", (value, expected) => {
		expect(safePersistedSequence(value)).toBe(expected);
	});

	it.each([
		"-1",
		-1,
		"01",
		String(Number.MAX_SAFE_INTEGER + 1),
		Number.MAX_SAFE_INTEGER + 1,
		1.5,
		-0,
	])("rejects the unsafe sequence %s", (value) => {
		expect(() => safePersistedSequence(value)).toThrow();
	});

	it("refuses to advance the final safe sequence", () => {
		expect(nextPersistedSequence(Number.MAX_SAFE_INTEGER - 1)).toBe(
			Number.MAX_SAFE_INTEGER,
		);
		expect(() => nextPersistedSequence(Number.MAX_SAFE_INTEGER)).toThrow(
			/cannot advance/,
		);
	});
});

describe("durable app-change envelope admission", () => {
	const ordinary = {
		seq: "2",
		batchId: "batch-2",
		runId: null,
		actorId: "actor-1",
		kind: "autosave",
		mutationsText: JSON.stringify([{ kind: "setAppName", name: "Changed" }]),
		fromProjectId: null,
		toProjectId: null,
	};

	it.each(["autosave", "mcp", "chat", "blueprint-migration"] as const)(
		"admits a nonempty %s change",
		(kind) => {
			expect(
				parsePersistedAppChangeEnvelope({ ...ordinary, kind }),
			).toMatchObject({ seq: 2, kind });
		},
	);

	it("admits only the fold-baseline empty non-scope arm", () => {
		expect(
			parsePersistedAppChangeEnvelope({
				...ordinary,
				kind: "fold-baseline",
				mutationsText: "[]",
			}),
		).toMatchObject({ kind: "fold-baseline", mutations: [] });
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				kind: "fold-baseline",
			}),
		).toThrow(/must have no mutations/);
	});

	it("admits empty and nonempty Project moves with exact distinct scope", () => {
		for (const mutationsText of [
			"[]",
			JSON.stringify([{ kind: "setAppName", name: "Moved" }]),
		]) {
			expect(
				parsePersistedAppChangeEnvelope({
					...ordinary,
					kind: "project-move",
					mutationsText,
					fromProjectId: "project-a",
					toProjectId: "project-b",
				}),
			).toMatchObject({
				kind: "project-move",
				fromProjectId: "project-a",
				toProjectId: "project-b",
			});
		}
	});

	it("rejects empty ordinary changes and Project scope on another kind", () => {
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				mutationsText: "[]",
			}),
		).toThrow(/must carry mutations/);
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				fromProjectId: "project-a",
				toProjectId: "project-b",
			}),
		).toThrow(/outside a project move/);
	});

	it.each([
		["blank source", " ", "project-b"],
		["blank destination", "project-a", ""],
		["same scope", "project-a", "project-a"],
	] as const)("rejects a Project move with %s", (_label, from, to) => {
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				kind: "project-move",
				mutationsText: "[]",
				fromProjectId: from,
				toProjectId: to,
			}),
		).toThrow(/distinct nonblank Project identities/);
	});

	it("rejects unknown or extra durable envelope fields", () => {
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				kind: "unknown-kind",
			}),
		).toThrow(/kind is invalid/);
		expect(() =>
			parsePersistedAppChangeEnvelope({
				...ordinary,
				extraKind: "unknown-kind",
			}),
		).toThrow(/invalid durable envelope shape/);
	});
});

describe("final app lifecycle status", () => {
	it("keeps soft deletion out of the lifecycle vocabulary", () => {
		expect(APP_LIFECYCLE_STATUSES).toEqual(["generating", "complete", "error"]);
		expect(() => parsePersistedAppLifecycleStatus("deleted")).toThrow(
			/Persisted app lifecycle status is invalid/,
		);
	});
});

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__tests__")
				return [];
			return sourceFiles(file);
		}
		return /\.(?:ts|tsx|mts)$/.test(entry.name) ? [file] : [];
	});
}

describe("persisted JSON source boundaries", () => {
	const root = process.cwd();

	it("keeps ordinary Blueprint DB assembly behind the exact-text boundary", () => {
		const allowed = new Set([
			path.join(root, "lib/db/blueprintRows.ts"),
			path.join(root, "lib/db/persistedJson.ts"),
		]);
		const offenders = [
			...sourceFiles(path.join(root, "app")),
			...sourceFiles(path.join(root, "components")),
			...sourceFiles(path.join(root, "lib")),
			...sourceFiles(path.join(root, "scripts")),
		]
			.filter(
				(file) =>
					!file.includes(
						`${path.sep}lib${path.sep}case-store${path.sep}migrations${path.sep}`,
					),
			)
			.filter((file) => !allowed.has(file))
			.filter((file) =>
				readFileSync(file, "utf8").includes("assembleBlueprint("),
			)
			.map((file) => path.relative(root, file));
		expect(offenders).toEqual([]);

		for (const relative of [
			"lib/db/canonicalCommitKernel.ts",
			"lib/db/mediaDeletion.ts",
			"scripts/scan-lookup-reference-edges.ts",
		]) {
			const source = readFileSync(path.join(root, relative), "utf8");
			expect(source).toContain("assemblePersistedBlueprintJsonText");
			expect(source).toMatch(/case_types.+::text/s);
			expect(source).toMatch(/localization.+::text/s);
			expect(source).toMatch(/data.+::text/s);
		}
		/* The strict persisted-app admission lives in the canonical commit
		 * kernel; `apps.ts` composes it through the exported projection and
		 * loaders rather than re-growing raw readers. */
		const appsSource = readFileSync(path.join(root, "lib/db/apps.ts"), "utf8");
		const kernelSource = readFileSync(
			path.join(root, "lib/db/canonicalCommitKernel.ts"),
			"utf8",
		);
		expect(
			appsSource.match(/\.select\(PERSISTED_BLUEPRINT_APP_COLUMNS\)/g),
		).toHaveLength(3);
		expect(
			kernelSource.match(/\.select\(PERSISTED_BLUEPRINT_APP_COLUMNS\)/g),
		).toHaveLength(2);
		expect(appsSource).not.toContain("assemblePersistedBlueprintJsonText(");
		expect(
			kernelSource.match(/\bassemblePersistedBlueprintJsonText\(/g),
		).toHaveLength(1);
		expect(appsSource).toMatch(
			/return withAppTx\(\(tx\) => loadAppInTransaction\(tx, appId\)\)/,
		);
		const projection = kernelSource.match(
			/const PERSISTED_BLUEPRINT_APP_COLUMNS = \[([\s\S]*?)\] as const/,
		)?.[1];
		expect(projection).toBeDefined();
		expect(projection).not.toContain('"case_types"');
		expect(projection).not.toContain('"localization"');
	});

	it("forbids parsed all-column app reads in production and operator code", () => {
		const offenders = [
			...sourceFiles(path.join(root, "app")),
			...sourceFiles(path.join(root, "components")),
			...sourceFiles(path.join(root, "lib")),
			...sourceFiles(path.join(root, "scripts")),
		]
			.filter(
				(file) =>
					!file.includes(
						`${path.sep}lib${path.sep}case-store${path.sep}migrations${path.sep}`,
					),
			)
			.filter((file) => {
				const source = readFileSync(file, "utf8");
				return /selectFrom\(["']apps(?:\s+as\s+\w+)?["']\)(?:(?!;)[\s\S])*?\.selectAll\(\)/.test(
					source,
				);
			})
			.map((file) => path.relative(root, file));
		expect(offenders).toEqual([]);

		const inspector = readFileSync(
			path.join(root, "scripts/inspect-app.ts"),
			"utf8",
		);
		expect(inspector).toContain(
			"(to_jsonb(apps) - 'case_types' - 'localization')::text",
		);
		expect(inspector).toMatch(/apps\.case_types.+::text/s);
		expect(inspector).toMatch(/apps\.localization.+::text/s);
		expect(inspector).toContain("parsePersistedJsonText");
	});

	it("keeps live code out of the timestamp-frozen implementation", () => {
		const frozenSegment =
			"lib/case-store/migrations/20260728000000_canonical_identity_foundation/";
		const allowedScripts = new Set([
			// Explicit immutable-image/operator entrypoints for this exact
			// timestamped cutover; none participates in steady-state reads.
			"scripts/audit-canonical-identity-foundation.ts",
			"scripts/repair-canonical-identity-foundation.ts",
			"scripts/scan-canonical-identity-foundation.ts",
		]);
		const importsFrozenAuthority = (source: string) =>
			source
				.split("\n")
				.some(
					(line) =>
						(/\bfrom\s+["']/.test(line) ||
							/^\s*(?:import|export)\s+["']/.test(line)) &&
						line.includes(frozenSegment),
				);
		const offenders = [
			...sourceFiles(path.join(root, "app")),
			...sourceFiles(path.join(root, "components")),
			...sourceFiles(path.join(root, "lib")),
			...sourceFiles(path.join(root, "scripts")),
		]
			.map((file) => [file, readFileSync(file, "utf8")] as const)
			.filter(
				([file, source]) =>
					importsFrozenAuthority(source) &&
					!file.includes(
						`${path.sep}lib${path.sep}case-store${path.sep}migrations${path.sep}`,
					) &&
					!allowedScripts.has(path.relative(root, file)),
			)
			.map(([file]) => path.relative(root, file));
		expect(offenders).toEqual([]);
		expect(
			existsSync(
				path.join(root, "lib/db/canonicalIdentityFoundationRepair.ts"),
			),
		).toBe(false);
		expect(existsSync(path.join(root, "scripts/verify-sequences.ts"))).toBe(
			false,
		);
	});

	it("forbids raw number coercion of every persisted sequence boundary", () => {
		const offenders = [
			...sourceFiles(path.join(root, "app")),
			...sourceFiles(path.join(root, "lib")),
			...sourceFiles(path.join(root, "scripts")),
		]
			.filter(
				(file) =>
					!file.includes(
						`${path.sep}lib${path.sep}case-store${path.sep}migrations${path.sep}`,
					),
			)
			.flatMap((file) => {
				const source = readFileSync(file, "utf8");
				return /Number\([^)]*(?:mutation_seq|synced_seq|index_pending_seq|index_synced_seq|\.seq)\b[^)]*\)/.test(
					source,
				)
					? [path.relative(root, file)]
					: [];
			});
		expect(offenders).toEqual([]);

		for (const relative of [
			"lib/case-store/postgres/store.ts",
			"lib/case-store/postgres/submissionAttachments.ts",
		]) {
			const source = readFileSync(path.join(root, relative), "utf8");
			expect(source).toContain("@/lib/utils/persistedSequence");
			expect(source).not.toContain("@/lib/db/persistedJson");
		}
	});

	it("parses every replayable mutation body and fold baseline from text", () => {
		/* The guarded commit's dedup latch — the one apps-protocol mutation-body
		 * read — lives in the canonical commit kernel. */
		const kernelSource = readFileSync(
			path.join(root, "lib/db/canonicalCommitKernel.ts"),
			"utf8",
		);
		const streamSource = readFileSync(
			path.join(root, "app/api/apps/[id]/stream/route.ts"),
			"utf8",
		);
		const streamQuerySource = readFileSync(
			path.join(root, "lib/db/appChangeStream.ts"),
			"utf8",
		);
		const foldSource = readFileSync(
			path.join(root, "lib/db/canonicalMutationFold.ts"),
			"utf8",
		);
		expect(kernelSource).toContain("parsePersistedMutationBatchText");
		expect(kernelSource).toMatch(/app_changes\.mutations.+::text/s);
		expect(streamSource).toContain("parsePersistedAppChangeEnvelope");
		expect(streamSource).toContain("readAppChangeStreamRowsSince");
		expect(streamQuerySource).toMatch(/app_changes\.mutations.+::text/s);
		expect(streamQuerySource).not.toContain(
			'"app_changes.mutations as mutations"',
		);
		expect(foldSource).toContain("baselineSnapshotText: string");
		expect(foldSource).toContain("mutationsText: string");
		expect(foldSource).not.toContain("baselineSnapshot: unknown");
		expect(foldSource).not.toContain("mutations: unknown");
	});
});
