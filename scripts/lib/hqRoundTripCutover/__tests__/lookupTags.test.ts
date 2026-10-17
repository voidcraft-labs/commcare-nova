/**
 * The Project-level lookup tag rename, pure: what each stored tag that holds
 * `casedb` or `ledgerdb` becomes, the two ways a rename cannot be made, and
 * that the context the plan judges every app against carries the renames,
 * so an app that references a renamed table meets no reserved-tag finding.
 */

import { describe, expect, it } from "vitest";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import {
	isReservedInstanceTag,
	LOOKUP_MAX_TAG_LENGTH,
} from "@/lib/lookup/constants";
import { lookupTagSchema } from "@/lib/lookup/schema";
import { lookupContextOf } from "@/proof/corpus/documents";
import {
	holdsReservedTagWord,
	planProjectLookupTags,
	renamedReservedTag,
} from "../lookupTags";
import {
	migratedFixtureDocument,
	readFixtureProject,
} from "./fixtures/preStep";

const NONE: ReadonlySet<string> = new Set();

describe("renamedReservedTag", () => {
	it.each([
		["clinic_casedb_codes", "clinic_case_db_codes"],
		["stock_ledgerdb_codes", "stock_ledger_db_codes"],
		["casedbledgerdb", "case_dbledger_db"],
		["ledgerdb_casedb_ledgerdb", "ledger_db_case_db_ledger_db"],
		["xcasedbcasedb", "xcase_dbcase_db"],
	])("splits each reserved word in %s, left to right", (tag, renamed) => {
		expect(renamedReservedTag(tag, NONE)).toBe(renamed);
		expect(holdsReservedTagWord(renamed)).toBe(false);
		expect(isReservedInstanceTag(renamed)).toBe(false);
	});

	it("truncates to the tag cap, which leaves no reserved word behind", () => {
		const tag = `${"a".repeat(26)}casedb`;
		expect(tag).toHaveLength(32);
		const renamed = renamedReservedTag(tag, NONE);
		expect(renamed).toBe(`${"a".repeat(26)}case_d`);
		expect(renamed).toHaveLength(LOOKUP_MAX_TAG_LENGTH);
		expect(holdsReservedTagWord(renamed ?? "")).toBe(false);
	});

	it("takes the first free suffixed form, truncated to make room", () => {
		const tag = `${"b".repeat(26)}casedb`;
		const truncated = `${"b".repeat(26)}case_d`;
		expect(renamedReservedTag(tag, new Set([truncated]))).toBe(
			`${"b".repeat(26)}case_2`,
		);
		expect(
			renamedReservedTag(
				"clinic_casedb",
				new Set(["clinic_case_db", "clinic_case_db_2"]),
			),
		).toBe("clinic_case_db_3");
	});

	it("gives up when the tag and each of its forms _2 to _99 are taken", () => {
		const stem = "clinic_case_db";
		const taken = new Set([
			stem,
			...Array.from({ length: 98 }, (_, index) => `${stem}_${index + 2}`),
		]);
		expect(renamedReservedTag("clinic_casedb", taken)).toBeNull();
		taken.delete(`${stem}_99`);
		expect(renamedReservedTag("clinic_casedb", taken)).toBe(`${stem}_99`);
	});

	it("never returns more than the cap, and each result parses as a tag", () => {
		const long = `${"c".repeat(20)}ledgerdb${"d".repeat(4)}`;
		const taken = new Set<string>();
		for (let round = 0; round < 99; round += 1) {
			const renamed = renamedReservedTag(long, taken);
			if (renamed === null) throw new Error(`no tag at round ${round}`);
			expect(renamed.length).toBeLessThanOrEqual(LOOKUP_MAX_TAG_LENGTH);
			expect(lookupTagSchema.safeParse(renamed).success).toBe(true);
			taken.add(renamed);
		}
		expect(renamedReservedTag(long, taken)).toBeNull();
	});
});

function context(
	tags: readonly (readonly [string, string])[],
): LookupValidationContext {
	return lookupContextOf({
		projectId: "project-tags",
		projectRevision: "1",
		definitions: tags.map(([id, tag]) => ({
			id,
			name: `Table ${tag}`,
			tag,
			definitionRevision: "1",
			columns: [
				{
					id: `${id.slice(0, -1)}f`,
					wireName: "code",
					label: "code",
					dataType: "text",
				},
			],
		})),
		rowsByTable: {},
	} as never);
}

const T1 = "018f0000-0000-7000-8000-000000000001";
const T2 = "018f0000-0000-7000-8000-000000000002";
const T3 = "018f0000-0000-7000-8000-000000000003";

describe("planProjectLookupTags", () => {
	it("renames each reserved tag in table order, applies it to the context and leaves the rest", () => {
		const plan = planProjectLookupTags(
			context([
				[T2, "stock_ledgerdb_codes"],
				[T1, "clinic_casedb_codes"],
				[T3, "regions"],
			]),
		);
		expect(plan.renames).toEqual([
			{
				tableId: T1,
				fromTag: "clinic_casedb_codes",
				toTag: "clinic_case_db_codes",
			},
			{
				tableId: T2,
				fromTag: "stock_ledgerdb_codes",
				toTag: "stock_ledger_db_codes",
			},
		]);
		expect(plan.blockers).toEqual([]);
		if (plan.context.kind !== "available") throw new Error("unavailable");
		expect(
			plan.context.definitions.map((table) => [table.id, table.tag]),
		).toEqual([
			[T2, "stock_ledger_db_codes"],
			[T1, "clinic_case_db_codes"],
			[T3, "regions"],
		]);
	});

	it("gives two reserved tags that rename to one stem distinct tags", () => {
		const plan = planProjectLookupTags(
			context([
				[T1, "codes_casedb"],
				[T2, "codes_case_db"],
				[T3, "codescasedb"],
			]),
		);
		// T2 already holds T1's split form, so T1 takes the next free one.
		expect(plan.renames.map((rename) => rename.toTag)).toEqual([
			"codes_case_db_2",
			"codescase_db",
		]);
		expect(
			planProjectLookupTags(
				context([
					[T1, "a_casedb"],
					[T2, "a_case_db_casedb"],
					[T3, "a_casedb_casedb"],
				]),
			).renames.map((rename) => rename.toTag),
		).toEqual(["a_case_db", "a_case_db_case_db", "a_case_db_case_db_2"]);
	});

	it("blocks a rename with no free tag, and a rename the tag rule refuses", () => {
		const stem = "clinic_case_db";
		const collision = planProjectLookupTags(
			context([
				[T1, "clinic_casedb"],
				[T2, stem],
				...Array.from(
					{ length: 98 },
					(_, index) =>
						[
							`018f0000-0000-7000-8000-${(0x100 + index).toString(16).padStart(12, "0")}`,
							`${stem}_${index + 2}`,
						] as const,
				),
			]),
		);
		expect(collision.blockers).toEqual([
			{ tableId: T1, code: "lookup-tag-rename-collision" },
		]);
		expect(collision.renames).toEqual([]);
		if (collision.context.kind !== "available") throw new Error("unavailable");
		expect(
			collision.context.definitions.find((table) => table.id === T1)?.tag,
		).toBe("clinic_casedb");
		// No stored tag starts with xml, which the tag rule refuses; the arm
		// holds all the same.
		expect(
			planProjectLookupTags(context([[T1, "xmlcasedb"]])).blockers,
		).toEqual([{ tableId: T1, code: "lookup-tag-unparsable" }]);
	});
});

describe("the gate the plan judges an app against", () => {
	it("finds no reserved tag on an app whose tables the plan renames, and the stored tags alone refuse it", () => {
		const doc = migratedFixtureDocument("hand-lookup-tag-collision");
		const project = readFixtureProject("hand-lookup-tag-collision");
		const stored = lookupContextOf(project.lookup as never);
		if (stored.kind !== "available") throw new Error("unavailable");
		const reserved = (verdict: ReturnType<typeof mutationCommitVerdict>) =>
			verdict.ok
				? []
				: verdict.findings
						.filter(
							(finding) => finding.code === "LOOKUP_TAG_RESERVED_BY_RUNTIME",
						)
						.map((finding) => finding.details?.tableId);
		// Without the tables that hold every form the casedb table's rename
		// could take, both tables are renamed.
		const without = stored.definitions.filter(
			(table) => !table.tag.startsWith("clinic_case_db"),
		);
		const free = planProjectLookupTags({ ...stored, definitions: without });
		expect(free.blockers).toEqual([]);
		expect(free.renames.map((rename) => rename.toTag)).toEqual([
			"stock_ledger_db_codes",
			"clinic_case_db_codes",
		]);
		expect(
			reserved(
				mutationCommitVerdict(doc, [], { ...stored, definitions: without }),
			),
		).not.toEqual([]);
		expect(reserved(mutationCommitVerdict(doc, [], free.context))).toEqual([]);

		const blocked = planProjectLookupTags(stored);
		expect(blocked.blockers.map((blocker) => blocker.code)).toEqual([
			"lookup-tag-rename-collision",
		]);
		expect(
			new Set(reserved(mutationCommitVerdict(doc, [], blocked.context))),
		).toEqual(new Set(blocked.blockers.map((blocker) => blocker.tableId)));
	});
});
