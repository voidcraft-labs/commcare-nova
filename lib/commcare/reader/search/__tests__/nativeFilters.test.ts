import { expect, it } from "vitest";
import { literal, term } from "@/lib/domain/expression/builders";
import type { SearchFilter } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { codes, listOf, readLists } from "../../caseList/__tests__/listReading";

it("reads two independent values of one native request key in order and keeps their identities after an HQ edit", async () => {
	const targets: SearchFilter["target"][] = [
		{ kind: "property", property: "notes" },
		{ kind: "owner" },
		{ kind: "property", property: "notes" },
		{ kind: "link", identifier: "parent" },
	];
	const values = ["active", "worker", "waiting", ""];
	const filters = targets.map((target, index) => ({
		uuid: uuid(index + 20),
		target,
		value: term(literal(values[index])),
	}));
	const doc = patients([], { search: {}, list: { searchFilters: filters } });
	const before = await readLists(doc);
	expect(codes(before), JSON.stringify(before.findings)).toEqual([]);
	expect(before.app.modules[0].search_config.default_properties).toEqual([
		{ property: "notes", defaultValue: "'active'" },
		{ property: "owner_id", defaultValue: "'worker'" },
		{ property: "notes", defaultValue: "'waiting'" },
		{ property: "indices.parent", defaultValue: "''" },
	]);
	const held = listOf(before).searchFilters ?? [];
	expect(held.map(({ target, value }) => ({ target, value }))).toEqual(
		filters.map(({ target, value }) => ({ target, value })),
	);
	const after = await readLists(doc, {
		edit: (app) => {
			const rows = app.modules[0].search_config.default_properties as {
				defaultValue: string;
				doc_type?: string;
			}[];
			for (const row of rows) row.doc_type = "DefaultCaseSearchProperty";
			rows[2].defaultValue = "'booked'";
		},
	});
	expect(codes(after), JSON.stringify(after.findings)).toEqual([]);
	const edited = listOf(after).searchFilters ?? [];
	expect(edited.map((row) => row.uuid)).toEqual(held.map((row) => row.uuid));
	expect(edited[2].value).toEqual(term(literal("booked")));
});
