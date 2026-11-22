import { expect, it } from "vitest";
import { expandDoc } from "@/lib/commcare/expander";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { plainColumn, projectSearchOf } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { closedCodes, readLists } from "../../caseList/__tests__/listReading";
import { readProjectSearchBindings } from "../../context";

it("reads repeated service parameters as ordered values and publishes them under the selected destination's id", async () => {
	const source = patients([plainColumn(uuid(1), "case_name", "Name")], {
		search: {},
	});
	const rows = [
		{ property: "_xpath_query", defaultValue: "'district'" },
		{ property: "_xpath_query", defaultValue: "'north'" },
		{ property: "include_closed", defaultValue: "''" },
	];
	const read = await readLists(source, {
		edit(app) {
			const config = app.modules[0]?.search_config;
			if (!config) throw new Error("The source has no menu.");
			config.case_search_endpoint_id = 17;
			config.default_properties = rows;
		},
	});
	expect(closedCodes(read)).toEqual([]);
	const doc = read.ctx.doc;
	const module = read.ctx.draft.modules[0];
	if (!doc || !module) throw new Error("The menu did not read.");
	const search = projectSearchOf(doc.modules[module.uuid]);
	if (!search) throw new Error("The menu lost its project search.");
	expect(search.defaults.map((parameter) => parameter.name)).toEqual(
		rows.map((row) => row.property),
	);
	expect(new Set(search.defaults.map((parameter) => parameter.uuid)).size).toBe(
		3,
	);
	expect(readProjectSearchBindings(read.ctx)).toEqual([
		{ searchUuid: search.searchUuid, endpointId: 17 },
	]);
	const emitTo = (id: number) =>
		expandDoc(doc, {
			identity: targetWireIdentity(
				[],
				[],
				[{ searchUuid: search.searchUuid, endpointId: id }],
			),
		}).modules[0]?.search_config;
	expect(emitTo(17)).toMatchObject({
		case_search_endpoint_id: 17,
		default_properties: rows,
	});
	expect(emitTo(91)).toMatchObject({
		case_search_endpoint_id: 91,
		default_properties: rows,
	});
	expect(() => expandDoc(doc)).toThrow("Choose a project space");
});
