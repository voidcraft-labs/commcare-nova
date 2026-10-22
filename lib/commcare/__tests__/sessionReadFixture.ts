import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, tileCell } from "@/lib/domain";
import { term } from "@/lib/domain/expression";
import type { DatumRef } from "@/lib/domain/expression/types";

const uuid = (name: string) => testUuid(`session-reads:${name}`);
export const SESSION_READS = {
	root: uuid("households"),
	module: uuid("visits"),
	followup: uuid("followup"),
	registration: uuid("registration"),
	groupedModule: uuid("grouped-visits"),
	groupedFollowup: uuid("grouped-followup"),
} as const;

const read = (id: string, datum: DatumRef) =>
	f({
		uuid: uuid(id),
		id,
		kind: "hidden",
		calculate: term({ kind: "session-datum", datum }),
	});
const list = (name: string, grouped = false) => {
	const column = {
		...plainColumn(uuid(`${name}-column`), "case_name", "Name"),
		...(grouped ? { tile: tileCell(0, 1, 4, 1) } : {}),
	};
	const columns = grouped
		? [
				plainColumn(uuid(`${name}-group-column`), "case_name", "Household", {
					tile: tileCell(0, 0, 4, 1),
				}),
				column,
			]
		: [column];
	return {
		columns,
		listColumnOrder: columns.map(({ uuid }) => uuid),
		detailColumnOrder: columns.map(({ uuid }) => uuid),
		searchInputs: [],
		...(grouped
			? { tile: { grouping: { identifier: "parent", headerRows: 1 } } }
			: {}),
	};
};

/** Every identity is explicit: adding this scenario consumes no fixture draws. */
export function sessionReadFixture(nested = false, linked = false) {
	return buildSessionReadFixture({ nested, linked, parentSelection: false });
}

/** The nested witness follows a selected parent into its selected child.
 * Grouped-parent reads have their own standalone tile witness. */
export function nestedSessionReadFixture() {
	return buildSessionReadFixture({
		nested: true,
		linked: false,
		parentSelection: true,
	});
}

/** All datum kinds, with a flat grouped entry beside the selected-parent flow. */
export function sessionIdentityFixture(nested = false) {
	return buildSessionReadFixture({
		nested,
		linked: false,
		parentSelection: true,
		standaloneGrouping: true,
	});
}

function buildSessionReadFixture({
	nested,
	linked,
	parentSelection,
	standaloneGrouping = false,
}: {
	readonly nested: boolean;
	readonly linked: boolean;
	readonly parentSelection: boolean;
	readonly standaloneGrouping?: boolean;
}) {
	return buildDoc(
		{
			appId: "targeted-session-reads",
			appName: "Session identities",
			caseTypes: [
				{ name: "household", properties: [] },
				{ name: "visit", parent_type: "household", properties: [] },
				{ name: "note", parent_type: "visit", properties: [] },
			],
			modules: [
				{
					uuid: SESSION_READS.root,
					name: "Households",
					caseType: "household",
					caseListConfig: list("household"),
					forms: [
						{
							uuid: uuid("household-form"),
							name: "Household visit",
							type: "followup",
							fields: [
								f({ uuid: uuid("household-note"), kind: "text", id: "note" }),
							],
						},
					],
				},
				{
					uuid: SESSION_READS.module,
					name: "Visits",
					caseType: "visit",
					caseListConfig: list("visit", !parentSelection),
					forms: [
						{
							uuid: SESSION_READS.followup,
							name: "Read selected visit",
							type: "followup",
							fields: [
								read("selected_id", {
									kind: "selected-case",
									module: SESSION_READS.module,
								}),
								parentSelection
									? read("parent_selected_id", {
											kind: "selected-case",
											module: SESSION_READS.root,
										})
									: read("group_parent_ids", {
											kind: "tile-group-parents",
											module: SESSION_READS.module,
										}),
								f({
									uuid: uuid("followup-note"),
									kind: "text",
									id: "note",
									label: "Visit note",
								}),
							],
						},
						{
							uuid: SESSION_READS.registration,
							name: "Create visit and note",
							type: "registration",
							formLinks: [
								{
									uuid: uuid("open-created-visit"),
									target: {
										type: "form",
										moduleUuid: SESSION_READS.module,
										formUuid: SESSION_READS.followup,
									},
									datums: [
										{
											name: {
												kind: "selected-case",
												module: SESSION_READS.module,
											},
											xpath: term({
												kind: "session-datum",
												datum: { kind: "new-case" },
											}),
										},
									],
								},
							],
							fields: [
								f({
									uuid: uuid("visit-name"),
									kind: "text",
									id: "name",
									label: "Visit name",
									caseWrite: { caseType: "visit", property: "case_name" },
								}),
								f({
									uuid: uuid("note-name"),
									kind: "text",
									id: "note_name",
									label: "Note name",
									caseWrite: { caseType: "note", property: "case_name" },
								}),
								f({
									uuid: uuid("worker-note"),
									kind: "text",
									id: "worker_note",
									label: "Worker note",
									caseWrite: {
										caseType: "commcare-user",
										property: "session_note",
									},
								}),
								read("new_id", { kind: "new-case" }),
								read("child_id", { kind: "new-child-case", caseType: "note" }),
								read("worker_id", { kind: "worker-record" }),
							],
						},
					],
				},
				{
					uuid: uuid("notes"),
					name: "Notes",
					caseType: "note",
					caseListOnly: true,
					caseListConfig: list("note"),
					forms: [],
				},
				...(standaloneGrouping
					? [
							{
								uuid: SESSION_READS.groupedModule,
								name: "Visits by household",
								caseType: "visit",
								caseListConfig: list("standalone-visit", true),
								forms: [
									{
										uuid: SESSION_READS.groupedFollowup,
										name: "Read grouped visit",
										type: "followup" as const,
										fields: [
											read("group_selected_id", {
												kind: "selected-case",
												module: SESSION_READS.groupedModule,
											}),
											read("group_parent_ids", {
												kind: "tile-group-parents",
												module: SESSION_READS.groupedModule,
											}),
											f({
												uuid: uuid("group-followup-note"),
												kind: "text",
												id: "group_note",
												label: "Grouped visit note",
											}),
										],
									},
								],
							},
						]
					: []),
			],
		},
		(doc) => {
			if (!linked) delete doc.forms[SESSION_READS.registration].formLinks;
			const property = uuid("worker-property");
			doc.userProperties = {
				[property]: {
					uuid: property,
					slug: "session_note",
					label: "Session note",
				},
			};
			doc.userPropertyOrder = [property];
			if (nested)
				doc.modules[SESSION_READS.module].parentModuleUuid = SESSION_READS.root;
			if (parentSelection)
				doc.modules[SESSION_READS.module].parentCaseModuleUuid =
					SESSION_READS.root;
		},
	);
}
