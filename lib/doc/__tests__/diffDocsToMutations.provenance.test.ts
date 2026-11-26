/**
 * The third provenance arm: a delta between two readings of CommCare HQ's
 * app moves no saved case rows, so a rename-shaped difference is diffed as
 * the removed and the added property it is, never as a rename. A rename
 * moves saved rows, so the arm is held to its one caller.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	CasePropertySemanticProvenanceRequiredError,
	diffDocsToMutations,
	HQ_READING_DELTA,
} from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, plainColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const FORM = testUuid("provenance-form");
const NAME = testUuid("provenance-name");
const NOTE = testUuid("provenance-note");

/** A registration whose second question saves to `visit_note`. */
function start(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Visits",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "visit_note", label: proseText("Visit note") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(testUuid("provenance-column"), "case_name", "Name"),
					],
					searchInputs: [],
				},
				forms: [
					{
						uuid: FORM,
						name: "Register",
						type: "registration",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								uuid: NOTE,
								kind: "text",
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "patient", property: "visit_note" },
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}

function apply(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		admitMutationBatch(JSON.parse(JSON.stringify(mutations))),
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}

describe("a delta between two readings of CommCare HQ's app", () => {
	it("replays surviving case properties in their new positions and preserves their declarations", () => {
		const base = start();
		const prev = {
			...base,
			caseTypes: [
				...(base.caseTypes ?? []),
				{
					name: "member",
					properties: ["left", "reborn", "right"].map((name) => ({
						name,
						label: proseText(name),
					})),
				},
			],
		};
		const next = produce(prev, (draft) => {
			const type = draft.caseTypes.find(
				(candidate) => candidate.name === "member",
			);
			if (!type) throw new Error("Expected the member catalog");
			type.properties = [
				"right",
				"first_arrival",
				"left",
				"reborn",
				"last_arrival",
			].map((name) => ({
				name,
				label: proseText(name === "reborn" ? "New declaration" : name),
			}));
		});
		const diff = diffDocsToMutations(prev, next, HQ_READING_DELTA);
		expect(diff.some((m) => m.kind === "moveCaseProperty")).toBe(true);
		expect(
			diff
				.filter((m) => m.kind === "removeCaseProperty")
				.map((m) => m.property),
		).toEqual([]);
		expect(toPersistableDoc(apply(prev, diff))).toEqual(toPersistableDoc(next));
		for (const [property, after] of [
			["absent", null],
			["right", "absent"],
			["right", "right"],
		] as const) {
			expect(
				mutationTargetsInvalid(prev, [
					{ kind: "moveCaseProperty", caseType: "member", property, after },
				]),
			).toBe(true);
		}
	});

	it("emits a removed and an added property, never a rename, and replays to the target", () => {
		const before = start();
		// The endpoint a rename makes is exactly the shape the refusal guards:
		// the question that saved `visit_note` now saves `note_text`.
		const after = apply(before, [
			{
				kind: "renameCaseProperties",
				renames: [{ caseType: "patient", from: "visit_note", to: "note_text" }],
			},
		]);
		expect(() => diffDocsToMutations(before, after)).toThrow(
			CasePropertySemanticProvenanceRequiredError,
		);

		const delta = diffDocsToMutations(before, after, HQ_READING_DELTA);
		expect(delta.map((mutation) => mutation.kind)).not.toContain(
			"renameCaseProperties",
		);
		expect(delta).toContainEqual(
			expect.objectContaining({
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "visit_note",
			}),
		);
		expect(delta).toContainEqual(
			expect.objectContaining({
				kind: "addCaseProperty",
				caseType: "patient",
				property: expect.objectContaining({ name: "note_text" }),
			}),
		);
		expect(toPersistableDoc(apply(before, delta))).toEqual(
			toPersistableDoc(after),
		);
	});

	it("diffs a delta that is no rename exactly as the plain diff does", () => {
		const before = start();
		const after = apply(before, [{ kind: "setAppName", name: "Home visits" }]);
		expect(diffDocsToMutations(before, after, HQ_READING_DELTA)).toEqual(
			diffDocsToMutations(before, after),
		);
	});
});

// ── The arm's one caller ─────────────────────────────────────────────

const ROOT = process.cwd();
const SOURCE_DIRS = ["app", "components", "lib", "scripts", "proof", "e2e"];
const DECLARED_IN = "lib/doc/diffDocsToMutations.ts";
/** The one module that may diff two readings of CommCare HQ's app. */
const CALLERS = new Set(["lib/deployment/hqChanges/plan.ts"]);

function sourceFiles(dir: string): string[] {
	return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(
		(entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory())
				return entry.name === "node_modules" ||
					entry.name === "__tests__" ||
					entry.name.startsWith(".")
					? []
					: sourceFiles(path);
			return /\.tsx?$/.test(entry.name) &&
				!/\.test(-d)?\.tsx?$/.test(entry.name)
				? [path]
				: [];
		},
	);
}

/**
 * Whether the file can take the arm: its text names `HQ_READING_DELTA`, the
 * provenance's own key or its type in any spelling (a named import, a
 * member of a namespace import, a re-export), or it re-exports everything
 * the module declares.
 */
function namesTheArm(text: string): boolean {
	return (
		/\b(?:HQ_READING_DELTA|movesNoSavedRows|NoSavedRowsMoveProvenance)\b/.test(
			text,
		) ||
		/\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s+["'][^"']*\/diffDocsToMutations["']/.test(
			text,
		)
	);
}

function fileNamesTheArm(path: string): boolean {
	return namesTheArm(readFileSync(join(ROOT, path), "utf8"));
}

describe("the arm's callers", () => {
	it("are the plan of changes made in CommCare HQ alone", () => {
		const files = SOURCE_DIRS.flatMap(sourceFiles).map((path) =>
			relative(ROOT, join(ROOT, path)),
		);
		// The guard reads the arm where it is declared, so it is no vacuous pass.
		expect(files).toContain(DECLARED_IN);
		expect(fileNamesTheArm(DECLARED_IN)).toBe(true);
		const naming = files.filter(
			(path) => path !== DECLARED_IN && fileNamesTheArm(path),
		);
		expect(naming.filter((path) => !CALLERS.has(path))).toEqual([]);
	});

	it("sees every spelling that reaches the arm", () => {
		for (const spelling of [
			'import { HQ_READING_DELTA } from "@/lib/doc/diffDocsToMutations";',
			'import * as diff from "@/lib/doc/diffDocsToMutations";\ndiff.diffDocsToMutations(a, b, diff.HQ_READING_DELTA);',
			'export { HQ_READING_DELTA as delta } from "@/lib/doc/diffDocsToMutations";',
			'export * from "@/lib/doc/diffDocsToMutations";',
			'export * as diff from "./diffDocsToMutations";',
			"diffDocsToMutations(a, b, { movesNoSavedRows: true });",
			"const p: NoSavedRowsMoveProvenance = q;",
		])
			expect(namesTheArm(spelling)).toBe(true);
		expect(
			namesTheArm(
				'import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";',
			),
		).toBe(false);
	});
});
