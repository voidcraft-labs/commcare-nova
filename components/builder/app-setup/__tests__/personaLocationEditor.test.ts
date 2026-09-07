import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { OrganizationLevel, Persona } from "@/lib/domain";
import { fixedLocation, term } from "@/lib/domain/predicate";
import type { StoredLocation } from "@/lib/organization/types";
import {
	type PersonaLocationEditorInputs,
	personaLocationEditor,
	planPersonaLocationChange,
} from "../personaLocationEditor";

const LEVEL = testUuid("assignment-level");
const NONWORKER = testUuid("assignment-nonworker");
const PERSONA = testUuid("assignment-persona");
const FORM = testUuid("assignment-form");
const A = testUuid("assignment-a"),
	B = testUuid("assignment-b"),
	C = testUuid("assignment-c");
function location(
	id: StoredLocation["id"],
	name: string,
	patch: Partial<StoredLocation> = {},
): StoredLocation {
	return {
		id,
		name,
		levelUuid: LEVEL,
		parentId: null,
		siteCode: name.toLowerCase().replaceAll(" ", "-"),
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: id,
		...patch,
	};
}
function inputs(): PersonaLocationEditorInputs {
	const level: OrganizationLevel = {
		uuid: LEVEL,
		code: "branch",
		name: "Branch",
		caseFlow: {
			workers: "assigned",
			ownsCases: true,
			descendantCases: { kind: "none" },
		},
		addressBook: { reach: "own-branch" },
	};
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note" })],
					},
				],
			},
		],
	});
	const persona: Persona = {
		uuid: PERSONA,
		name: "Asha",
		locations: { primaryUuid: A, additionalUuids: [B] },
	};
	doc.personas = { [PERSONA]: persona };
	doc.personaOrder = [PERSONA];
	doc.organizationLevels = {
		[LEVEL]: level,
		[NONWORKER]: {
			...level,
			uuid: NONWORKER,
			code: "storage",
			name: "Storage",
			caseFlow: { workers: "none", ownsCases: false },
		},
	};
	doc.organizationLevelOrder = [LEVEL, NONWORKER];
	doc.forms[FORM].caseOperations = [
		{
			uuid: testUuid("assignment-owner"),
			id: "assign_owner",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			owner: term(fixedLocation(B)),
		},
	];
	return {
		doc,
		persona,
		locations: [
			location(A, "Branch A"),
			location(B, "Branch B"),
			location(C, "Branch C"),
		],
		loading: false,
		error: undefined,
		warning: undefined,
		refreshing: false,
		canEdit: true,
		requestedPage: 0,
	};
}
const blocked =
	"\"Branch B\" is outside Asha's address book. Change that level's visibility or choose a destination this worker can carry on the device.";

it("uses actual owner rules to identify the assignment that must remain", () => {
	const input = inputs();
	const before = structuredClone(input);
	const view = personaLocationEditor(input);
	expect(view.assigned).toEqual([A, B]);
	expect(
		view.rows.map(({ id, index, label }) => ({ id, index, label })),
	).toEqual([
		{ id: A, index: 0, label: "Branch A · branch-a" },
		{ id: B, index: 1, label: "Branch B · branch-b" },
	]);
	expect(view.available.map(({ id }) => id)).toEqual([C]);
	expect(view.removalIssues).toEqual(new Map([[B, blocked]]));
	expect(
		planPersonaLocationChange(input, { kind: "remove", id: B }),
	).toBeUndefined();
	expect(planPersonaLocationChange(input, { kind: "remove", id: A })).toEqual({
		ids: [B],
		page: 0,
		removedIndex: 0,
	});
	expect(input).toEqual(before);
});

it.each([
	{ loading: true },
	{ error: "Connection failed." },
	{ warning: "Connection failed." },
	{ refreshing: true },
])(
	"keeps an incomplete catalog from becoming a deletion verdict (%#)",
	(read) => {
		const input = { ...inputs(), locations: [], ...read };
		const view = personaLocationEditor(input);
		expect(view.authoritative).toBe(false);
		expect(view.emptyMessage).toBeUndefined();
		expect(view.removalIssues).toEqual(new Map());
		expect(view.rows.map((row) => row.label)).toEqual(
			Array(2).fill(
				"warning" in read
					? "Assigned place unavailable until places reload"
					: "Refreshing assigned place",
			),
		);
		for (const kind of ["add", "remove", "main"] as const) {
			expect(
				planPersonaLocationChange(input, { kind, id: kind === "add" ? C : A }),
			).toBeUndefined();
		}
	},
);

it("reports missing assignments only after an authoritative read and keeps viewers read-only", () => {
	const input = { ...inputs(), locations: [] };
	expect(personaLocationEditor(input).rows.map((row) => row.label)).toEqual([
		"A place that no longer exists",
		"A place that no longer exists",
	]);
	const viewer = { ...inputs(), canEdit: false };
	expect(personaLocationEditor(viewer).removalIssues).toEqual(new Map());
	for (const kind of ["add", "remove", "main"] as const)
		expect(planPersonaLocationChange(viewer, { kind, id: C })).toBeUndefined();
});

it("offers only live worker places and distinguishes empty from temporarily unavailable", () => {
	const original = inputs();
	const assigned = { ...original.persona, locations: undefined };
	const input = {
		...original,
		persona: assigned,
		doc: { ...original.doc, personas: { [PERSONA]: assigned } },
		locations: [
			location(C, "Branch C"),
			location(testUuid("archived"), "Archived", {
				archivedAt: new Date("2026-01-01"),
			}),
			location(testUuid("no-workers"), "Storage", { levelUuid: NONWORKER }),
			location(testUuid("unknown-level"), "Unknown", { levelUuid: "unknown" }),
		],
	};
	expect(personaLocationEditor(input).available.map((row) => row.id)).toEqual([
		C,
	]);
	const none = { ...input, locations: [] };
	expect(personaLocationEditor(none).emptyMessage).toBe(
		"This app has no places yet. Add them in Organization, then assign this persona to one.",
	);
	expect(
		personaLocationEditor({ ...input, locations: input.locations.slice(1) })
			.emptyMessage,
	).toBe(
		"No live place is at a level where people work. Change a level in Organization, then assign this persona.",
	);
	expect(
		personaLocationEditor({ ...none, refreshing: true }).emptyMessage,
	).toBeUndefined();
});

it("plans full ordered assignments and ignores duplicate, missing, archived or nonworker choices", () => {
	const input = inputs();
	expect(planPersonaLocationChange(input, { kind: "main", id: B })).toEqual({
		ids: [B, A],
		page: 0,
		focusIndex: 0,
	});
	expect(planPersonaLocationChange(input, { kind: "add", id: C })).toEqual({
		ids: [A, B, C],
		page: 0,
	});
	for (const change of [
		{ kind: "add", id: A },
		{ kind: "add", id: "unknown" },
		{ kind: "remove", id: C },
		{ kind: "main", id: C },
	] as const) {
		expect(planPersonaLocationChange(input, change)).toBeUndefined();
	}
	for (const row of [
		location(C, "Archived", { archivedAt: new Date("2026-01-01") }),
		location(C, "Storage", { levelUuid: NONWORKER }),
	]) {
		expect(
			planPersonaLocationChange(
				{ ...input, locations: [...input.locations.slice(0, 2), row] },
				{ kind: "add", id: C },
			),
		).toBeUndefined();
	}
});

it("bounds removal verdicts to the visible page and plans paging from the resulting assignment", () => {
	const input = inputs();
	const many = Array.from({ length: 51 }, (_, index) =>
		location(testUuid(`assignment-${index}`), `Place ${index}`),
	);
	const persona: Persona = {
		...input.persona,
		locations: {
			primaryUuid: many[0].id,
			additionalUuids: many.slice(1).map((row) => row.id),
		},
	};
	const doc = {
		...input.doc,
		personas: { [PERSONA]: persona },
		forms: {
			...input.doc.forms,
			[FORM]: {
				...input.doc.forms[FORM],
				caseOperations: [
					{
						uuid: testUuid("page-owner"),
						id: "assign_owner",
						action: "update" as const,
						caseType: "patient",
						target: { kind: "session" as const },
						owner: term(fixedLocation(many[50].id)),
					},
				],
			},
		},
	};
	const first = { ...input, doc, persona, locations: many };
	expect(personaLocationEditor(first).rows.map((row) => row.id)).toEqual(
		many.slice(0, 50).map((row) => row.id),
	);
	expect(personaLocationEditor(first).removalIssues).toEqual(new Map());
	const last = { ...first, requestedPage: 100 };
	expect(personaLocationEditor(last).assignedPage).toEqual({
		ids: [many[50].id],
		page: 1,
		pageCount: 2,
		start: 50,
	});
	expect([...personaLocationEditor(last).removalIssues.keys()]).toEqual([
		many[50].id,
	]);
	expect(
		planPersonaLocationChange(last, { kind: "main", id: many[50].id }),
	).toEqual({
		ids: [many[50].id, ...many.slice(0, 50).map((row) => row.id)],
		page: 0,
		focusIndex: 0,
	});
	const noOwner = { ...last, doc: { ...doc, forms: {} } };
	expect(
		planPersonaLocationChange(noOwner, { kind: "remove", id: many[50].id }),
	).toEqual({
		ids: many.slice(0, 50).map((row) => row.id),
		page: 0,
		removedIndex: 50,
	});
	const extra = location(C, "Extra");
	const fiftyPersona: Persona = {
		...persona,
		locations: {
			primaryUuid: many[0].id,
			additionalUuids: many.slice(1, 50).map((row) => row.id),
		},
	};
	const fifty = {
		...noOwner,
		persona: fiftyPersona,
		doc: { ...noOwner.doc, personas: { [PERSONA]: fiftyPersona } },
		locations: [...many, extra],
		requestedPage: 0,
	};
	expect(planPersonaLocationChange(fifty, { kind: "add", id: C })).toEqual({
		ids: [...many.slice(0, 50).map((row) => row.id), C],
		page: 1,
	});
});
