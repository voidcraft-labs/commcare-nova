/**
 * The one pure rule of a create: no answer the review offers may move a
 * binding the reader read.
 *
 * It would catch: an answer that moves a binding the reader read going on to
 * a birth unseen, so an app born from a document its digest never covered;
 * and `use-project` refused for a column the app never reads.
 */

import { describe, expect, it } from "vitest";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import type { LookupRevision, LookupTableDefinition } from "@/lib/lookup/types";
import { movedBindingCount } from "../create";
import type { ReadingLookupTable } from "../projectData";
import {
	broughtInLookupColumnId,
	broughtInLookupTableId,
} from "../projectData/lookupIds";
import type { LookupTableBinding } from "../projectData/lookupTables";

const READING_ID = "019a7f3c-2b1d-7e40-8a9b-0c1d2e3f4a5b";
const APP_ID = "0b4f6a52-7c55-4a35-9d1e-3c2f8a1b4e6d";
/** The app whose ids stand in for a Project table's own. */
const OTHER_APP_ID = "3e2d1c0b-8a7f-4e6d-9c5b-4a3f2e1d0c9b";

const tableId = (tag: string, appId = APP_ID): LookupTableId =>
	broughtInLookupTableId(appId, READING_ID, tag);
const columnId = (tag: string, field: string, appId = APP_ID): LookupColumnId =>
	broughtInLookupColumnId(appId, READING_ID, tag, field);

/** The Project's table a `choice` tag met, with CommCare HQ's two fields. */
function projectTable(tag: string): LookupTableDefinition {
	return {
		id: tableId(tag, OTHER_APP_ID),
		name: tag,
		tag,
		definitionRevision: "4" as LookupRevision,
		columns: ["code", "name"].map((field) => ({
			id: columnId(tag, field, OTHER_APP_ID),
			wireName: field,
			label: field,
			dataType: "text" as const,
		})),
	};
}

/** One gathered table: a `choice` tag, or a `new` one, under `binding`. */
function gathered(
	tag: string,
	kind: "choice" | "new",
	binding: LookupTableBinding,
): ReadingLookupTable {
	return {
		read: {
			kind: "rows-unreadable",
			table: {
				id: `hq${tag}`,
				tag,
				isGlobal: true,
				fields: ["code", "name"],
				fieldProperties: {},
				itemAttributes: [],
			},
		},
		findings: [],
		standing:
			kind === "new"
				? { kind: "new" }
				: {
						kind: "choice",
						table: projectTable(tag),
						differs: ["rows"],
						managed: { by: "nova" },
						apps: [],
						options: {
							"use-commcare-hq": {
								offered: true,
								goneColumns: [],
								retypedColumns: [],
							},
							"use-project": {
								offered: true,
								goneColumns: [],
								retypedColumns: [],
							},
						},
					},
		binding,
		choice: null,
		projectTable: null,
	};
}

/** The binding a `choice` tag holds before an answer: the Project table, its columns by name. */
function boundToProject(tag: string): LookupTableBinding {
	return {
		tag,
		tableId: tableId(tag, OTHER_APP_ID),
		columns: {
			code: columnId(tag, "code", OTHER_APP_ID),
			name: columnId(tag, "name", OTHER_APP_ID),
		},
	};
}

const READS = { district: ["code", "name"], clinic: ["code"] } as const;

describe("movedBindingCount", () => {
	it("answers 0 where every binding under the answers is the one read", () => {
		const read = [
			gathered("district", "choice", boundToProject("district")),
			gathered("clinic", "choice", boundToProject("clinic")),
		];
		const answered = read.map((table) => ({
			...table,
			choice: "use-project" as const,
		}));
		expect(movedBindingCount(read, answered, READS)).toBe(0);
	});

	it("counts a choice tag whose binding moved another column under a field the reader read", () => {
		const read = [gathered("district", "choice", boundToProject("district"))];
		const answered = [
			gathered("district", "choice", {
				...boundToProject("district"),
				columns: {
					code: columnId("district", "code"),
					name: columnId("district", "name", OTHER_APP_ID),
				},
			}),
		];
		expect(movedBindingCount(read, answered, READS)).toBe(1);
	});

	it("counts a choice tag whose binding moved to another table id", () => {
		const read = [gathered("district", "choice", boundToProject("district"))];
		const answered = [
			gathered("district", "choice", {
				...boundToProject("district"),
				tableId: tableId("district"),
			}),
		];
		expect(movedBindingCount(read, answered, READS)).toBe(1);
	});

	it("does not compare a column of a field the reader did not read", () => {
		const read = [gathered("clinic", "choice", boundToProject("clinic"))];
		const answered = [
			gathered("clinic", "choice", {
				...boundToProject("clinic"),
				columns: {
					code: columnId("clinic", "code", OTHER_APP_ID),
					name: columnId("clinic", "name"),
				},
			}),
		];
		expect(movedBindingCount(read, answered, READS)).toBe(0);
	});

	it("counts only choice tags: a new table's binding is no answer's", () => {
		const read = [gathered("district", "new", boundToProject("district"))];
		const answered = [
			gathered("district", "new", {
				...boundToProject("district"),
				tableId: tableId("district"),
			}),
		];
		expect(movedBindingCount(read, answered, READS)).toBe(0);
	});
});
