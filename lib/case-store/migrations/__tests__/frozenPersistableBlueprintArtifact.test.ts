import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";
import {
	type FrozenLookupValidationContext,
	replayFrozenCanonicalAppChangeSuffix,
	validateFrozenPersistableBlueprintCandidate,
} from "../20260728000000_canonical_identity_foundation/frozenPersistableBlueprintValidator.generated.mjs";

const FROZEN_VALIDATOR_SHA256 =
	"bdb2dd07a9f3b70704dc46f4c933cbb68e9615fc880646a1704e75e53bff085d";
const FROZEN_TIMESTAMP = "20260728000000_canonical_identity_foundation";
const FROZEN_DIRECTORY_URL = new URL(
	`../${FROZEN_TIMESTAMP}/`,
	import.meta.url,
);
const FROZEN_DIRECTORY = fileURLToPath(FROZEN_DIRECTORY_URL);
const MIGRATION_WRAPPER = fileURLToPath(
	new URL(`../${FROZEN_TIMESTAMP}.ts`, import.meta.url),
);
const REPO_ROOT = resolve(FROZEN_DIRECTORY, "../../../..");
const MODULE_UUID = "56b316b8-c90b-473c-9ce1-6683597541ad";
const FORM_UUID = "ef1a9365-9c60-46b5-b4d2-64c3d76c12d7";
const FIELD_UUID = "b99518ff-e3c3-4e5b-a111-cb6fe5c51b3c";
const LOOKUP_TABLE = "00000000-0000-7000-8000-0000000000a1";
const LOOKUP_VALUE_COLUMN = "10000000-0000-7000-8000-0000000000a1";
const LOOKUP_LABEL_COLUMN = "10000000-0000-7000-8000-0000000000a2";

function lookupContext(
	patch: {
		readonly tableId?: string;
		readonly projectId?: string;
		readonly includeLabel?: boolean;
		readonly labelType?:
			| "text"
			| "int"
			| "decimal"
			| "date"
			| "time"
			| "datetime";
	} = {},
): FrozenLookupValidationContext {
	return {
		kind: "available",
		projectId: patch.projectId ?? "fixture-project",
		projectRevision: "7",
		definitions: [
			{
				id: patch.tableId ?? LOOKUP_TABLE,
				name: "Facilities",
				tag: "facilities",
				definitionRevision: "3",
				columns: [
					{
						id: LOOKUP_VALUE_COLUMN,
						wireName: "value",
						label: "Value",
						dataType: "text",
					},
					...(patch.includeLabel === false
						? []
						: [
								{
									id: LOOKUP_LABEL_COLUMN,
									wireName: "label",
									label: "Label",
									dataType: patch.labelType ?? "int",
								},
							]),
				],
			},
		],
	};
}

function frozenFixture(): Record<string, unknown> {
	return {
		appId: "fixture-app",
		appName: "Canonical",
		connectType: null,
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "survey",
				name: "Survey",
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "survey",
				name: "Survey",
				type: "survey",
			},
		},
		fields: {
			[FIELD_UUID]: {
				kind: "text",
				uuid: FIELD_UUID,
				id: "question_1",
				label: { parts: [{ kind: "text", text: "Question 1" }] },
			},
		},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
	};
}

function withNumericLiteral(
	baseline: Record<string, unknown>,
	value: number,
): Record<string, unknown> {
	const forms = baseline.forms as Record<string, Record<string, unknown>>;
	const form = forms[FORM_UUID] as Record<string, unknown>;
	return {
		...baseline,
		forms: {
			...forms,
			[FORM_UUID]: {
				...form,
				displayCondition: {
					kind: "eq",
					left: { kind: "term", term: { kind: "literal", value } },
					right: { kind: "term", term: { kind: "literal", value } },
				},
			},
		},
	};
}

function lookupFixture(): Record<string, unknown> {
	const baseline = frozenFixture();
	return {
		...baseline,
		fields: {
			[FIELD_UUID]: {
				kind: "single_select",
				uuid: FIELD_UUID,
				id: "question_1",
				label: { parts: [{ kind: "text", text: "Question 1" }] },
				optionsSource: {
					kind: "lookup",
					tableId: LOOKUP_TABLE,
					valueColumnId: LOOKUP_VALUE_COLUMN,
					labelColumnId: LOOKUP_LABEL_COLUMN,
					filter: {
						kind: "gt",
						left: {
							kind: "term",
							term: {
								kind: "table-column",
								tableId: LOOKUP_TABLE,
								columnId: LOOKUP_LABEL_COLUMN,
							},
						},
						right: {
							kind: "term",
							term: { kind: "literal", value: 1 },
						},
					},
				},
			},
		},
	};
}

async function listFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files.sort();
}

async function moduleSpecifiers(source: string): Promise<readonly string[]> {
	await init;
	return parse(source)[0].flatMap((entry) =>
		entry.n === undefined ? [] : [entry.n],
	);
}

function resolvesInsideFrozenTree(
	sourcePath: string,
	specifier: string,
	allFiles: ReadonlySet<string>,
): boolean {
	const unresolved = specifier.startsWith("@/")
		? resolve(REPO_ROOT, specifier.slice(2))
		: resolve(dirname(sourcePath), specifier);
	if (
		relative(FROZEN_DIRECTORY, unresolved).startsWith("..") ||
		resolve(unresolved) === resolve(FROZEN_DIRECTORY, "..")
	) {
		return false;
	}
	return [
		unresolved,
		`${unresolved}.ts`,
		`${unresolved}.mts`,
		`${unresolved}.mjs`,
		`${unresolved}.js`,
		`${unresolved}.grammar`,
		resolve(unresolved, "index.ts"),
	].some((candidate) => allFiles.has(candidate));
}

describe("frozen persisted-Blueprint validator artifact", () => {
	it("retains the reviewed immutable bytes", async () => {
		const source = await readFile(
			resolve(
				FROZEN_DIRECTORY,
				"frozenPersistableBlueprintValidator.generated.mjs",
			),
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(
			FROZEN_VALIDATOR_SHA256,
		);
		const imports = await moduleSpecifiers(source.toString("utf8"));
		expect(imports).toEqual(["node:crypto"]);
	});

	it("keeps the complete timestamp tree and wrapper import graph self-contained", async () => {
		const frozenFiles = await listFiles(FROZEN_DIRECTORY);
		const allFiles = new Set([...frozenFiles, MIGRATION_WRAPPER]);
		const sourceFiles = [...frozenFiles, MIGRATION_WRAPPER].filter((path) =>
			/\.(?:[cm]?[jt]s)$/.test(path),
		);
		const allowedPackages = new Set([
			"@lezer/common",
			"@lezer/lr",
			"kysely",
			"node:crypto",
		]);
		for (const sourcePath of sourceFiles) {
			const source = await readFile(sourcePath, "utf8");
			expect(
				source,
				`${relative(REPO_ROOT, sourcePath)} uses CommonJS require`,
			).not.toMatch(/\brequire\s*\(/);
			for (const specifier of await moduleSpecifiers(source)) {
				if (allowedPackages.has(specifier)) continue;
				expect(
					resolvesInsideFrozenTree(sourcePath, specifier, allFiles),
					`${relative(REPO_ROOT, sourcePath)} imports ${specifier}`,
				).toBe(true);
			}
		}
	});

	it("retains the exact numeric and lookup-aware validation corpus", () => {
		const baseline = frozenFixture();
		expect(
			validateFrozenPersistableBlueprintCandidate(baseline, lookupContext()).ok,
		).toBe(true);
		expect(
			validateFrozenPersistableBlueprintCandidate(
				{ ...baseline, appName: "" },
				lookupContext(),
			).ok,
		).toBe(false);
		for (const value of [0.1, 5e-324]) {
			expect(
				validateFrozenPersistableBlueprintCandidate(
					withNumericLiteral(baseline, value),
					lookupContext(),
				).ok,
			).toBe(true);
		}
		expect(
			validateFrozenPersistableBlueprintCandidate(
				withNumericLiteral(baseline, 9_007_199_254_740_992),
				lookupContext(),
			).ok,
		).toBe(false);

		const lookup = lookupFixture();
		expect(
			validateFrozenPersistableBlueprintCandidate(lookup, lookupContext()).ok,
		).toBe(true);
		const lookupFailures = [
			[
				lookupContext({
					tableId: "00000000-0000-7000-8000-0000000000b1",
				}),
				"LOOKUP_TABLE_NOT_AVAILABLE",
			],
			[lookupContext({ includeLabel: false }), "LOOKUP_COLUMN_NOT_AVAILABLE"],
			[lookupContext({ labelType: "text" }), "LOOKUP_SELECT_FILTER_TYPE_ERROR"],
		] as const;
		for (const [context, code] of lookupFailures) {
			const result = validateFrozenPersistableBlueprintCandidate(
				lookup,
				context,
			);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.codes).toContain(code);
		}
	});

	it("retains contiguous app-change replay with a final-only absolute gate", () => {
		const baseline = frozenFixture();
		const replayed = replayFrozenCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(baseline),
			baselineSeq: "4",
			baselineProjectId: "fixture-project",
			expectedHeadSeq: "5",
			expectedFinalProjectId: "fixture-project",
			suffix: [
				{
					seq: "5",
					batch_id: "fixture:5",
					run_id: null,
					actor_id: "fixture-user",
					kind: "autosave",
					from_project_id: null,
					to_project_id: null,
					mutationsText: JSON.stringify([
						{ kind: "setAppName", name: "After replay" },
					]),
				},
			],
			finalLookupContext: lookupContext(),
		});
		expect(replayed).toMatchObject({
			headSeq: "5",
			batches: 1,
			mutations: 1,
			snapshot: { appName: "After replay" },
		});
		expect(
			createHash("sha256")
				.update(JSON.stringify(replayed.snapshot))
				.digest("hex"),
		).toBe("4d4e7c1b75b7a071a67881601c1feeee89151c3bcf5f9b2221f6d1f6cd0e294c");

		const recovered = replayFrozenCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(baseline),
			baselineSeq: "4",
			baselineProjectId: "fixture-project",
			expectedHeadSeq: "6",
			expectedFinalProjectId: "fixture-project",
			suffix: [
				{
					seq: "5",
					batch_id: "fixture:5",
					run_id: null,
					actor_id: "fixture-user",
					kind: "autosave",
					from_project_id: null,
					to_project_id: null,
					mutationsText: JSON.stringify([{ kind: "setAppName", name: "" }]),
				},
				{
					seq: "6",
					batch_id: "fixture:6",
					run_id: null,
					actor_id: "fixture-user",
					kind: "autosave",
					from_project_id: null,
					to_project_id: null,
					mutationsText: JSON.stringify([
						{ kind: "setAppName", name: "Recovered" },
					]),
				},
			],
			finalLookupContext: lookupContext(),
		});
		expect(recovered.snapshot).toMatchObject({ appName: "Recovered" });

		expect(() =>
			replayFrozenCanonicalAppChangeSuffix({
				baselineSnapshotText: JSON.stringify(baseline),
				baselineSeq: "4",
				baselineProjectId: "fixture-project",
				expectedHeadSeq: "6",
				expectedFinalProjectId: "fixture-project",
				suffix: [
					{
						seq: "6",
						batch_id: "fixture:6",
						run_id: null,
						actor_id: "fixture-user",
						kind: "autosave",
						from_project_id: null,
						to_project_id: null,
						mutationsText: "[]",
					},
				],
				finalLookupContext: lookupContext(),
			}),
		).toThrow(/autosave must carry mutations/);
	});

	it("retains Project scope through empty project-move app changes", () => {
		const replayed = replayFrozenCanonicalAppChangeSuffix({
			baselineSnapshotText: JSON.stringify(frozenFixture()),
			baselineSeq: "4",
			baselineProjectId: "project-before",
			expectedHeadSeq: "5",
			expectedFinalProjectId: "project-after",
			suffix: [
				{
					seq: "5",
					batch_id: "project-move:5",
					run_id: "run-5",
					actor_id: "fixture-user",
					kind: "project-move",
					from_project_id: "project-before",
					to_project_id: "project-after",
					mutationsText: "[]",
				},
			],
			finalLookupContext: lookupContext({ projectId: "project-after" }),
		});
		expect(replayed).toMatchObject({
			projectId: "project-after",
			headSeq: "5",
			batches: 1,
			mutations: 0,
		});

		expect(() =>
			replayFrozenCanonicalAppChangeSuffix({
				baselineSnapshotText: JSON.stringify(frozenFixture()),
				baselineSeq: "4",
				baselineProjectId: "project-before",
				expectedHeadSeq: "5",
				expectedFinalProjectId: "project-after",
				suffix: [
					{
						seq: "5",
						batch_id: "project-move:5",
						run_id: "run-5",
						actor_id: "fixture-user",
						kind: "project-move",
						from_project_id: "wrong-source",
						to_project_id: "project-after",
						mutationsText: "[]",
					},
				],
				finalLookupContext: lookupContext({ projectId: "project-after" }),
			}),
		).toThrow(/does not start in the folded Project/);
	});
});
