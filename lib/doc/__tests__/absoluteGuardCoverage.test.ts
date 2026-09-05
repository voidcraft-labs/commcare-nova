import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { withUserSequences } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Absolute commit-gate coverage per mutation kind:
 * for EVERY mutation kind, either a concrete probe shows the shared commit
 * verdict rejecting its invalid complete candidate, or the entry records why
 * its representative complete candidate remains valid.
 *
 * The table is `satisfies`-total over `Mutation["kind"]`: adding a
 * mutation kind without deciding its guard coverage here is a compile error.
 * The gate always validates the complete post-batch candidate.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import {
	automationMessageText,
	type BlueprintDoc,
	type Field,
} from "@/lib/domain";

/** Field lookup by semantic id (unique across these fixtures). */
function byId(doc: BlueprintDoc, id: string): Field {
	const field = Object.values(doc.fields).find((fl) => fl.id === id);
	if (!field) throw new Error(`fixture missing field "${id}"`);
	return field;
}

function formUuidAt(doc: BlueprintDoc, m: number, fIdx: number) {
	return doc.formOrder[doc.moduleOrder[m]][fIdx];
}

/**
 * The rich base fixture most probes share. Module 0 ("Patients",
 * patient): a registration form (case_name / village / dob writers) and
 * a followup form (a second `dob` writer — cousins legally share the id
 * — plus a `workflow_status` writer and an empty repeat). Module 1 ("Archive",
 * case-less): a survey whose form link targets the registration form.
 * Valid in full (no completeness findings), so every probe's rejection
 * is a finding the PROBE introduced.
 */
function richDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Guard Coverage",
		modules: [
			{
				name: "Patients",
				uuid: "mod-patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						uuid: "frm-reg",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
							f({
								kind: "date",
								id: "dob",
								label: proseText("Date of birth"),
								caseWrite: { caseType: "patient", property: "dob" },
							}),
						],
					},
					{
						name: "Follow up",
						type: "followup",
						fields: [
							f({
								kind: "date",
								id: "dob",
								label: proseText("Date of birth"),
								caseWrite: { caseType: "patient", property: "dob" },
							}),
							f({
								kind: "text",
								id: "workflow_status",
								label: proseText("Status"),
								caseWrite: {
									caseType: "patient",
									property: "workflow_status",
								},
							}),
							f({
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								children: [
									f({ kind: "text", id: "note", label: proseText("Note") }),
								],
							}),
						],
					},
				],
			},
			{
				name: "Archive",
				forms: [
					{
						name: "Archive survey",
						type: "survey",
						fields: [
							f({ kind: "text", id: "comments", label: proseText("Comments") }),
						],
						// A conditional link followed by its exhaustive "otherwise":
						// the baseline is valid with no explicit postSubmit, and each
						// link kind's probe below breaks exactly one rule of it.
						formLinks: [
							{
								uuid: "lnk-cond",
								condition: "1 = 1",
								target: {
									type: "form",
									moduleUuid: testUuid("mod-patients"),
									formUuid: testUuid("frm-reg"),
								},
							},
							{
								uuid: "lnk-else",
								target: {
									type: "module",
									moduleUuid: testUuid("mod-patients"),
								},
							},
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "village", label: proseText("Village") },
					{ name: "dob", label: proseText("Date of birth") },
					{ name: "workflow_status", label: proseText("Status") },
				],
			},
		],
	});
}

/** A field's relevant expression referencing the catalog — the granular
 *  property-removal probe's tripwire. */
function caseRefDoc(): BlueprintDoc {
	const doc = richDoc();
	const status = byId(doc, "workflow_status");
	return {
		...doc,
		fields: {
			...doc.fields,
			[status.uuid]: {
				...status,
				relevant: xp("#patient/village = 'riverside'"),
			} as Field,
		},
	};
}

function withStrangerChildType(doc: BlueprintDoc): BlueprintDoc {
	return {
		...doc,
		caseTypes: [
			...(doc.caseTypes ?? []),
			{
				name: "stranger",
				parent_type: "patient",
				relationship: "child",
				properties: [
					{ name: "stranger_note", label: proseText("Stranger note") },
					{ name: "workflow_status", label: proseText("Status") },
				],
			},
		],
	};
}

/**
 * A doc carrying all three user collections, each already valid: one
 * choice-bearing property, one role that sets it, and two personas holding
 * that role. Every user probe below breaks exactly one of those relations.
 */
function usersDoc(): BlueprintDoc {
	const doc = richDoc();
	doc.userProperties = {
		[testUuid("up-region")]: {
			uuid: testUuid("up-region"),
			slug: "region",
			label: "Region",
			choices: ["north", "south"],
		},
	};
	doc.userTypes = {
		[testUuid("ut-chw")]: {
			uuid: testUuid("ut-chw"),
			name: "CHW",
			values: { [testUuid("up-region")]: "north" },
		},
	};
	doc.personas = {
		[testUuid("pers-asha")]: {
			uuid: testUuid("pers-asha"),
			name: "Asha",
			userTypeUuid: testUuid("ut-chw"),
		},
		[testUuid("pers-bimal")]: {
			uuid: testUuid("pers-bimal"),
			name: "Bimal",
			userTypeUuid: testUuid("ut-chw"),
		},
	};
	// The record and its sequence cannot disagree in a real doc; a fixture
	// assembling one by hand has to say both.
	return withUserSequences(doc);
}

function organizationDoc(): BlueprintDoc {
	const doc = richDoc();
	const region = testUuid("org-region");
	const facility = testUuid("org-facility");
	const beds = testUuid("locprop-beds");
	doc.organizationLevels = {
		[region]: {
			uuid: region,
			code: "region",
			name: "Region",
			caseFlow: { workers: "none", ownsCases: false },
			addressBook: { reach: "own-branch" },
		},
		[facility]: {
			uuid: facility,
			code: "facility",
			name: "Facility",
			parentLevelUuid: region,
			caseFlow: {
				workers: "assigned",
				ownsCases: true,
				descendantCases: { kind: "none" },
			},
			addressBook: { reach: "own-branch" },
		},
	};
	doc.organizationLevelOrder = [region, facility];
	doc.locationProperties = {
		[beds]: { uuid: beds, slug: "beds", label: "Beds" },
	};
	doc.locationPropertyOrder = [beds];
	return doc;
}

function automationDoc(): BlueprintDoc {
	const doc = richDoc();
	const cleanup = testUuid("automation-cleanup");
	const alert = testUuid("automation-alert");
	doc.automations = {
		[cleanup]: {
			uuid: cleanup,
			kind: "case-update",
			name: "Close completed patients",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			updates: [
				{
					uuid: testUuid("automation-update"),
					target: { scope: "case", property: "workflow_status" },
					value: { kind: "literal", value: "complete" },
				},
			],
			closeCase: false,
		},
		[alert]: {
			uuid: alert,
			kind: "conditional-alert",
			name: "Patient reminder",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("automation-recipient"), kind: "self" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("automation-event"),
						minutesToWait: 0,
						content: {
							kind: "sms",
							message: automationMessageText("Follow up"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		},
	};
	doc.automationOrder = [cleanup, alert];
	return doc;
}

interface RejectionProbe {
	/** Build the doc + the batch the gate must refuse. */
	build: () => { doc: BlueprintDoc; batch: Mutation[] };
	/** At least one of these codes must be among the rejection findings. */
	expectCodes: ValidationErrorCode[];
}

interface NeverGates {
	/** Why this representative complete candidate remains fully valid. */
	neverGates: string;
	/** A representative batch that passes the complete-candidate gate. */
	build?: () => { doc: BlueprintDoc; batch: Mutation[] };
}

type Coverage = RejectionProbe | NeverGates;

const GUARD_COVERAGE = {
	addEntryPoint: {
		neverGates:
			"A named survey destination has no case-selection requirements.",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "addEntryPoint",
						target: {
							kind: "form",
							moduleUuid: doc.moduleOrder[1],
							formUuid: formUuidAt(doc, 1, 0),
						},
						entryPoint: { uuid: testUuid("entry-point"), id: "survey" },
					},
				],
			};
		},
	},
	updateEntryPoint: {
		neverGates:
			"Changing an existing unique external identifier preserves the destination.",
		build: () => {
			const doc = richDoc();
			const uuid = formUuidAt(doc, 1, 0);
			doc.forms[uuid].entryPoint = {
				uuid: testUuid("entry-point"),
				id: "survey",
			};
			return {
				doc,
				batch: [
					{
						kind: "updateEntryPoint",
						entryPointUuid: testUuid("entry-point"),
						patch: { id: "survey_two" },
					},
				],
			};
		},
	},
	removeEntryPoint: {
		neverGates: "Removing an entry point leaves its destination intact.",
		build: () => {
			const doc = richDoc();
			const uuid = formUuidAt(doc, 1, 0);
			doc.forms[uuid].entryPoint = {
				uuid: testUuid("entry-point"),
				id: "survey",
			};
			return {
				doc,
				batch: [
					{ kind: "removeEntryPoint", entryPointUuid: testUuid("entry-point") },
				],
			};
		},
	},
	// ── Module kinds ────────────────────────────────────────────────
	addModule: {
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "addModule",
					module: {
						uuid: testUuid("m-new"),
						id: "households",
						name: "Households",
						caseType: "household",
					},
				},
			],
		}),
		expectCodes: ["NO_FORMS_OR_CASE_LIST"],
	},
	removeModule: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "removeModule", uuid: doc.moduleOrder[0] }],
			};
		},
		expectCodes: ["FORM_LINK_TARGET_NOT_FOUND"],
	},
	moveModule: {
		neverGates:
			"pure reorder of moduleOrder — no rule reads module position (duplicate names are name-keyed app rules)",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "moveModule", uuid: doc.moduleOrder[1], after: null }],
			};
		},
	},
	renameModule: {
		neverGates:
			"renames the module's SEMANTIC id, which no validator rule reads — display names ride updateModule patches and no rule gates on them",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{ kind: "renameModule", uuid: doc.moduleOrder[1], newId: "archive2" },
				],
			};
		},
	},
	updateModule: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "updateModule",
						uuid: doc.moduleOrder[0],
						patch: { caseType: "household" },
					},
				],
			};
		},
		expectCodes: ["CASE_CREATE_NAME_MISSING", "CASE_LIST_COLUMN_UNKNOWN_FIELD"],
	},
	setModuleMedia: {
		neverGates:
			"media slots never touch the writer set; the media rules are manifest-gated and boundary-only",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "setModuleMedia",
						uuid: doc.moduleOrder[0],
						icon: null,
						audioLabel: null,
					},
				],
			};
		},
	},

	// ── Form kinds ──────────────────────────────────────────────────
	addForm: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "addForm",
						moduleUuid: doc.moduleOrder[0],
						form: {
							uuid: testUuid("f-new"),
							id: "empty_form",
							name: "Empty form",
							type: "survey",
						},
					},
				],
			};
		},
		// An empty form may never land — the lone `addForm` introduces
		// EMPTY_FORM on any app. Creation that satisfies the rule goes
		// through the atomic `createForm`, whose required `fields` ride
		// the same batch.
		expectCodes: ["EMPTY_FORM"],
	},
	removeForm: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "removeForm", uuid: testUuid("frm-reg") }],
			};
		},
		expectCodes: ["FORM_LINK_TARGET_NOT_FOUND"],
	},
	moveForm: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "moveForm",
						uuid: testUuid("frm-reg"),
						toModuleUuid: doc.moduleOrder[1],
						after: null,
					},
				],
			};
		},
		expectCodes: ["NO_CASE_TYPE"],
	},
	renameForm: {
		neverGates:
			"renames the form's SEMANTIC id, which no validator rule reads — display names ride updateForm patches",
		build: () => ({
			doc: richDoc(),
			batch: [
				{ kind: "renameForm", uuid: testUuid("frm-reg"), newId: "renamed" },
			],
		}),
	},
	updateForm: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// Flip the case-less module's survey to a registration form:
				// the MODULE's rule input changes (case forms now exist where
				// no case type does) — a finding the form's own scope can't
				// see, which is why a type flip widens to full.
				batch: [
					{
						kind: "updateForm",
						uuid: formUuidAt(doc, 1, 0),
						patch: { type: "registration" },
					},
				],
			};
		},
		expectCodes: ["NO_CASE_TYPE"],
	},
	// ── After-submit link kinds ─────────────────────────────────────
	// richDoc's Archive survey carries [conditional → Register, else →
	// Patients menu]; the probes break the link rules one at a time.
	addFormLink: {
		build: () => {
			const doc = richDoc();
			const formUuid = formUuidAt(doc, 1, 0);
			return {
				doc,
				// Appended after the unconditional "else" link, so it can never
				// fire — and it points back at its own form.
				batch: [
					{
						kind: "addFormLink",
						formUuid,
						link: {
							uuid: testUuid("lnk-new"),
							target: {
								type: "form",
								moduleUuid: doc.moduleOrder[1],
								formUuid,
							},
						},
					},
				],
			};
		},
		expectCodes: ["FORM_LINK_UNREACHABLE", "FORM_LINK_SELF_REFERENCE"],
	},
	updateFormLink: {
		build: () => {
			const doc = richDoc();
			const formUuid = formUuidAt(doc, 1, 0);
			return {
				doc,
				batch: [
					{
						kind: "updateFormLink",
						formUuid,
						uuid: testUuid("lnk-cond"),
						patch: {
							target: {
								type: "form",
								moduleUuid: doc.moduleOrder[1],
								formUuid,
							},
						},
					},
				],
			};
		},
		expectCodes: ["FORM_LINK_SELF_REFERENCE"],
	},
	removeFormLink: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// Dropping the "else" leaves a conditional last link with no
				// explicit postSubmit to fall back to.
				batch: [
					{
						kind: "removeFormLink",
						formUuid: formUuidAt(doc, 1, 0),
						uuid: testUuid("lnk-else"),
					},
				],
			};
		},
		expectCodes: ["FORM_LINK_NO_FALLBACK"],
	},
	moveFormLink: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// The unconditional link moved first shadows the conditional one.
				batch: [
					{
						kind: "moveFormLink",
						formUuid: formUuidAt(doc, 1, 0),
						uuid: testUuid("lnk-else"),
						after: null,
					},
				],
			};
		},
		expectCodes: ["FORM_LINK_UNREACHABLE"],
	},
	setFormMedia: {
		neverGates:
			"media slots never touch the writer set; the media rules are manifest-gated and boundary-only",
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "setFormMedia",
					uuid: testUuid("frm-reg"),
					icon: null,
					audioLabel: null,
				},
			],
		}),
	},

	// ── Field kinds ─────────────────────────────────────────────────
	addField: {
		build: () => {
			const doc = withStrangerChildType(richDoc());
			return {
				doc,
				// A writer for a case type with no module: child-case creation
				// derives, and the child case has no name writer.
				batch: [
					{
						kind: "addField",
						parentUuid: testUuid("frm-reg"),
						field: {
							uuid: testUuid("fld-stranger"),
							kind: "text",
							id: "stranger_note",
							label: proseText("Note"),
							caseWrite: {
								caseType: "stranger",
								property: "stranger_note",
							},
						} as Field,
					},
				],
			};
		},
		expectCodes: ["CASE_CREATE_NAME_MISSING", "MISSING_CHILD_CASE_MODULE"],
	},
	removeField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "removeField", uuid: byId(doc, "case_name").uuid }],
			};
		},
		expectCodes: ["CASE_CREATE_NAME_MISSING", "CASE_LIST_COLUMN_UNKNOWN_FIELD"],
	},
	moveField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// A case-bound writer may not live inside a repeat — the case
				// transaction would write once from a repeated node.
				batch: [
					{
						kind: "moveField",
						uuid: byId(doc, "workflow_status").uuid,
						toParentUuid: byId(doc, "visits").uuid,
						after: null,
					},
				],
			};
		},
		expectCodes: ["PRIMARY_CASE_FIELD_IN_REPEAT"],
	},
	convertField: {
		build: () => {
			const doc = richDoc();
			// Two writers of `dob` (both date) live in sibling forms; convert
			// ONE to time and the property's writers disagree on data type —
			// a finding attributed cross-form.
			const followupDob = (doc.fieldOrder[formUuidAt(doc, 0, 1)] ?? [])
				.map((u) => doc.fields[u])
				.find((fl) => fl?.id === "dob");
			if (!followupDob) throw new Error("fixture missing followup dob");
			return {
				doc,
				batch: [
					{ kind: "convertField", uuid: followupDob.uuid, toKind: "time" },
				],
			};
		},
		expectCodes: ["FIELD_KIND_WRITERS_DISAGREE"],
	},
	updateField: {
		build: () => {
			const doc = withStrangerChildType(richDoc());
			return {
				doc,
				// Retarget this writer to an exact direct-child type. The child
				// now has a create action but no case-name writer or viewer module.
				batch: [
					{
						kind: "updateField",
						uuid: byId(doc, "workflow_status").uuid,
						targetKind: "text",
						patch: {
							caseWrite: {
								caseType: "stranger",
								property: "workflow_status",
							},
						},
					} as Mutation,
				],
			};
		},
		expectCodes: ["CASE_CREATE_NAME_MISSING", "MISSING_CHILD_CASE_MODULE"],
	},
	setFieldMedia: {
		neverGates:
			"media slots never touch the writer set; the media rules are manifest-gated and boundary-only",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "setFieldMedia",
						fieldUuid: byId(doc, "village").uuid,
						slot: "label",
						media: null,
					} as Mutation,
				],
			};
		},
	},

	// ── App-level kinds ─────────────────────────────────────────────
	setAppName: {
		build: () => ({
			doc: richDoc(),
			batch: [{ kind: "setAppName", name: "" }],
		}),
		expectCodes: ["EMPTY_APP_NAME"],
	},
	setAppLogo: {
		neverGates:
			"the logo feeds only the manifest-gated media rules, which never run on the commit path",
		build: () => ({
			doc: richDoc(),
			batch: [{ kind: "setAppLogo", logo: null }],
		}),
	},
	relabelSourceLanguage: {
		neverGates:
			"relabeling the sole source language replaces its identity without changing authored content",
	},
	addLanguage: {
		neverGates: "a target language may start with an empty translation overlay",
	},
	removeLanguage: {
		neverGates: "removing a non-source, non-default target closes its overlay",
	},
	setDefaultLanguage: {
		neverGates: "the selected existing default remains first in language order",
	},
	setTranslation: {
		neverGates:
			"a target overlay changes presentation without changing canonical app structure",
	},
	reviewTranslation: {
		neverGates: "review changes provenance only after an exact value fence",
	},
	renameCaseProperties: {
		neverGates:
			"the admitted exclusive command proves a complete bijection over materialized sources, then rewrites every declaration, writer, and reference as one semantic relation",
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "renameCaseProperties",
					renames: [{ caseType: "patient", from: "village", to: "community" }],
				},
			],
		}),
	},
	setConnectType: {
		build: () => ({
			doc: richDoc(),
			// Enabling Connect on an app whose forms all lack blocks leaves
			// the app with ZERO participating forms — the app-level
			// completeness floor fires. The session store's
			// switchConnectMode passes this same gate by landing the staged
			// participating blocks in the same batch as the flip.
			batch: [{ kind: "setConnectType", connectType: "learn" }],
		}),
		expectCodes: ["CONNECT_NO_PARTICIPATING_FORMS"],
	},
	// ── Granular case-type catalog ───────────────────────────────────
	declareCaseType: {
		neverGates: "a bare new case-type declaration is valid",
	},
	addCaseProperty: {
		neverGates: "appending a property to a declared type is valid",
	},
	setCaseProperty: {
		neverGates: "replacing a property by name preserves validity",
	},
	removeCaseProperty: {
		build: () => {
			const doc = caseRefDoc();
			return {
				doc,
				// Drop `village` from the catalog while a field's relevant still
				// reads it — the reference resolution flips in an entity this
				// batch never names.
				batch: [
					{
						kind: "removeCaseProperty",
						caseType: "patient",
						property: "village",
					},
				],
			};
		},
		expectCodes: ["INVALID_CASE_REF", "INVALID_REF"],
	},
	setCaseTypeMeta: {
		neverGates: "the complete ancestry metadata remains valid",
	},
	retireCaseType: {
		// Retire the type a field still writes to — its case destination now
		// names an absent type, the exact concurrent-retirement race.
		build: () => {
			const doc = buildDoc({
				appName: "Retire",
				caseTypes: [
					{
						name: "patient",
						properties: [{ name: "case_name", label: proseText("Name") }],
					},
				],
				modules: [
					{
						name: "Patients",
						caseType: "patient",
						caseListConfig: caseListConfig([
							{ field: "case_name", header: "Name" },
						]),
						forms: [
							{
								name: "Register",
								type: "registration",
								fields: [
									f({
										kind: "text",
										id: "case_name",
										label: proseText("Name"),
										caseWrite: {
											caseType: "patient",
											property: "case_name",
										},
									}),
								],
							},
						],
					},
				],
			});
			return { doc, batch: [{ kind: "retireCaseType", caseType: "patient" }] };
		},
		expectCodes: ["CASE_LIST_COLUMN_UNKNOWN_FIELD"],
	},

	// ── Case-list collections ────────────────────────────────────────
	addColumn: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "addColumn",
						moduleUuid: testUuid("mod-patients"),
						column: {
							uuid: testUuid("col-ghost"),
							kind: "plain",
							field: "ghost",
							header: "Ghost",
						},
						afterInList: null,
						afterInDetail: null,
					},
				],
			};
		},
		expectCodes: ["CASE_LIST_COLUMN_UNKNOWN_FIELD"],
	},
	updateColumn: {
		build: () => {
			const doc = richDoc();
			const col = patientsColumn(doc);
			return {
				doc,
				batch: [
					{
						kind: "updateColumn",
						moduleUuid: testUuid("mod-patients"),
						uuid: col.uuid,
						column: {
							kind: "plain",
							field: "ghost",
							header: "Ghost",
						},
					},
				],
			};
		},
		expectCodes: ["CASE_LIST_COLUMN_UNKNOWN_FIELD"],
	},
	removeColumn: {
		build: () => {
			const doc = richDoc();
			const col = patientsColumn(doc);
			return {
				doc,
				batch: [
					{
						kind: "removeColumn",
						moduleUuid: testUuid("mod-patients"),
						uuid: col.uuid,
					},
				],
			};
		},
		// Dropping the only column leaves a case module without a list to render.
		expectCodes: ["MISSING_CASE_LIST_COLUMNS"],
	},
	moveColumn: {
		neverGates:
			"reorders a case-list column (generic or one-surface order key only) — no rule reads column position",
		build: () => {
			const doc = richDoc();
			const col = patientsColumn(doc);
			return {
				doc,
				batch: [
					{
						kind: "moveColumn",
						moduleUuid: testUuid("mod-patients"),
						uuid: col.uuid,
						surface: "list",
						after: null,
					},
				],
			};
		},
	},
	addSearchInput: {
		neverGates: "a bare simple search input on a known property is valid",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "addSearchInput",
						moduleUuid: testUuid("mod-patients"),
						searchInput: {
							uuid: testUuid("si-new"),
							kind: "simple",
							name: "name_q",
							label: "Name",
							type: "text",
							property: "case_name",
						},
					},
				],
			};
		},
	},
	updateSearchInput: {
		neverGates: "the replacement is a valid simple input on a known property",
	},
	removeSearchInput: {
		neverGates:
			"removing the search surface leaves the complete candidate valid",
	},
	moveSearchInput: {
		neverGates:
			"reorders a search input in its owning array — no rule reads search-input position",
	},
	setCaseListMeta: {
		neverGates: "the case-list-link icon is a commit-valid media-only slot",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "setCaseListMeta",
						uuid: testUuid("mod-patients"),
						patch: { icon: testMediaAssetId("asset-1") },
					},
				],
			};
		},
	},

	// ── Select options ───────────────────────────────────────────────
	addOption: {
		neverGates: "the appended select option leaves a valid option set",
	},
	updateOption: {
		neverGates: "the option content replacement leaves a valid option set",
	},
	moveOption: {
		neverGates:
			"reorders a select option in its owning array — no rule reads option position",
	},
	removeOption: {
		// Dropping a select to ONE option is the sub-2 state the in-place option
		// reducer reaches without a `.min(2)` re-parse — the gate catches it.
		build: () => {
			const doc = buildDoc({
				appName: "Opt",
				modules: [
					{
						name: "M",
						forms: [
							{
								name: "F",
								type: "survey",
								fields: [
									f({
										kind: "single_select",
										id: "color",
										label: proseText("Color"),
										options: [
											{ value: "r", label: "Red" },
											{ value: "g", label: "Green" },
										],
									}),
								],
							},
						],
					},
				],
			});
			const field = byId(doc, "color");
			if (
				!("optionsSource" in field) ||
				field.optionsSource.kind !== "inline"
			) {
				throw new Error("fixture must be an inline select");
			}
			const options = field.optionsSource.options;
			return {
				doc,
				batch: [
					{
						kind: "removeOption",
						fieldUuid: field.uuid,
						uuid: testUuid(options[0].uuid),
					},
				],
			};
		},
		expectCodes: ["SELECT_TOO_FEW_OPTIONS"],
	},

	// ── User properties, user types, personas ───────────────────────
	addUserProperty: {
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "addUserProperty",
					property: {
						uuid: testUuid("up-bad"),
						slug: "commcare_region",
						label: "Region",
					},
				},
			],
		}),
		expectCodes: ["USER_PROPERTY_SLUG_INVALID"],
	},
	updateUserProperty: {
		build: () => ({
			doc: usersDoc(),
			batch: [
				{
					kind: "updateUserProperty",
					uuid: testUuid("up-region"),
					patch: { slug: "owner_id" },
				},
			],
		}),
		expectCodes: ["USER_PROPERTY_SLUG_INVALID"],
	},
	removeUserProperty: {
		// The role's value bag still names the property, so exact target
		// admission rejects a direct removal before reduction. The removal
		// planner clears every bag in the same batch.
		build: () => ({
			doc: usersDoc(),
			batch: [{ kind: "removeUserProperty", uuid: testUuid("up-region") }],
		}),
		expectCodes: ["MUTATION_TARGET_INVALID"],
	},
	addUserType: {
		build: () => ({
			doc: usersDoc(),
			batch: [
				{
					kind: "addUserType",
					userType: { uuid: testUuid("ut-dupe"), name: "chw" },
				},
			],
		}),
		expectCodes: ["USER_TYPE_NAME_DUPLICATE"],
	},
	updateUserType: {
		build: () => ({
			doc: usersDoc(),
			batch: [
				{
					kind: "updateUserType",
					uuid: testUuid("ut-chw"),
					patch: {},
					valuePatch: {
						userPropertyUuid: testUuid("up-region"),
						value: "atlantis",
					},
				},
			],
		}),
		expectCodes: ["USER_DATA_INVALID_CHOICE"],
	},
	removeUserType: {
		build: () => ({
			doc: usersDoc(),
			batch: [{ kind: "removeUserType", uuid: testUuid("ut-chw") }],
		}),
		expectCodes: ["MUTATION_TARGET_INVALID"],
	},
	addPersona: {
		build: () => ({
			doc: usersDoc(),
			batch: [
				{
					kind: "addPersona",
					persona: {
						uuid: testUuid("pers-new"),
						name: "Bimal",
						userTypeUuid: testUuid("ut-gone"),
					},
				},
			],
		}),
		expectCodes: ["MUTATION_TARGET_INVALID"],
	},
	updatePersona: {
		build: () => ({
			doc: usersDoc(),
			batch: [
				{
					kind: "updatePersona",
					uuid: testUuid("pers-bimal"),
					patch: { name: "asha" },
				},
			],
		}),
		expectCodes: ["PERSONA_NAME_DUPLICATE"],
	},
	removePersona: {
		neverGates:
			"drops a preview actor — nothing references a persona, so the complete candidate remains valid; app-scoped with no module or form widening",
		build: () => ({
			doc: usersDoc(),
			batch: [{ kind: "removePersona", uuid: testUuid("pers-bimal") }],
		}),
	},

	// ── Organization levels and place information ──────────────────
	addOrganizationLevel: {
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "addOrganizationLevel",
					level: {
						uuid: testUuid("org-region-copy"),
						code: "region",
						name: "Another region",
						caseFlow: { workers: "none", ownsCases: false },
						addressBook: { reach: "own-branch" },
					},
				},
			],
		}),
		expectCodes: ["ORGANIZATION_LEVEL_CODE_DUPLICATE"],
	},
	updateOrganizationLevel: {
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "updateOrganizationLevel",
					uuid: testUuid("org-region"),
					patch: { parentLevelUuid: testUuid("org-facility") },
				},
			],
		}),
		expectCodes: ["ORGANIZATION_LEVEL_CYCLE"],
	},
	removeOrganizationLevel: {
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "removeOrganizationLevel",
					uuid: testUuid("org-region"),
				},
			],
		}),
		expectCodes: ["ORGANIZATION_LEVEL_PARENT_UNKNOWN"],
	},
	addLocationProperty: {
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "addLocationProperty",
					property: {
						uuid: testUuid("locprop-beds-copy"),
						slug: "beds",
						label: "More beds",
					},
				},
			],
		}),
		expectCodes: ["LOCATION_PROPERTY_SLUG_DUPLICATE"],
	},
	updateLocationProperty: {
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "updateLocationProperty",
					uuid: testUuid("locprop-beds"),
					patch: { levelUuids: [testUuid("org-missing")] },
				},
			],
		}),
		expectCodes: ["LOCATION_PROPERTY_LEVEL_UNKNOWN"],
	},
	removeLocationProperty: {
		neverGates:
			"removing an unused declaration is document-valid; its row values are shed by the transactional organization integrity hook",
		build: () => ({
			doc: organizationDoc(),
			batch: [
				{
					kind: "removeLocationProperty",
					uuid: testUuid("locprop-beds"),
				},
			],
		}),
	},

	// ── Human-applied automations ──────────────────────────────────
	addAutomation: {
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "addAutomation",
					automation: {
						uuid: testUuid("automation-duplicate-name"),
						kind: "case-update",
						name: "Close completed patients",
						caseType: "patient",
						criteriaOperator: "all",
						criteria: [],
						setupOnlyCriteria: [],
						updates: [],
						closeCase: true,
					},
				},
			],
		}),
		expectCodes: ["AUTOMATION_INVALID"],
	},
	updateAutomation: {
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "updateAutomation",
					uuid: testUuid("automation-cleanup"),
					targetKind: "case-update",
					patch: { caseType: "missing" },
				},
			],
		}),
		expectCodes: ["AUTOMATION_INVALID"],
	},
	removeAutomation: {
		neverGates: "removing one automation leaves the app valid",
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "removeAutomation",
					uuid: testUuid("automation-cleanup"),
					targetKind: "case-update",
				},
			],
		}),
	},
	moveAutomation: {
		neverGates: "moving an automation changes sequence only",
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "moveAutomation",
					uuid: testUuid("automation-alert"),
					targetKind: "conditional-alert",
					after: null,
				},
			],
		}),
	},
	editAutomationItem: {
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "editAutomationItem",
					automationUuid: testUuid("automation-cleanup"),
					targetKind: "case-update",
					edit: {
						collection: "criterion",
						operation: "add",
						value: {
							uuid: testUuid("automation-invalid-criterion"),
							kind: "match-property",
							scope: "case",
							property: "missing",
							matchType: "has-value",
						},
					},
				},
			],
		}),
		expectCodes: ["AUTOMATION_INVALID"],
	},
	setAutomationSchedule: {
		build: () => ({
			doc: automationDoc(),
			batch: [
				{
					kind: "setAutomationSchedule",
					uuid: testUuid("automation-alert"),
					schedule: {
						kind: "immediate",
						events: [
							{
								uuid: testUuid("automation-invalid-event"),
								minutesToWait: 0,
								content: {
									kind: "sms-survey",
									formUuid: testUuid("missing-form"),
									expirationHours: 24,
									reminderIntervalsMinutes: [],
									submitPartiallyCompletedForms: false,
									includeCaseUpdatesInPartialSubmissions: false,
								},
							},
						],
					},
				},
			],
		}),
		expectCodes: ["AUTOMATION_INVALID"],
	},
	updateAutomationSchedule: {
		build: () => ({
			doc: (() => {
				const doc = automationDoc();
				const alert = doc.automations?.[testUuid("automation-alert")];
				if (alert?.kind === "conditional-alert") {
					alert.schedule = {
						kind: "timed",
						repeatEvery: 7,
						totalIterations: -1,
						startOffsetDays: 0,
						startDayOfWeek: -1,
						start: { kind: "rule-trigger" },
						events: [
							{
								uuid: testUuid("automation-event"),
								day: 0,
								timing: { kind: "specific-time", time: "09:00" },
								content: {
									kind: "sms",
									message: automationMessageText("Follow up"),
								},
							},
						],
					};
				}
				return doc;
			})(),
			batch: [
				{
					kind: "updateAutomationSchedule",
					uuid: testUuid("automation-alert"),
					patch: {
						start: { kind: "case-property", property: "missing" },
					},
				},
			],
		}),
		expectCodes: ["AUTOMATION_INVALID"],
	},
} satisfies Record<Mutation["kind"], Coverage>;

/** The single case-list column the rich Patients module is born with. */
function patientsColumn(doc: BlueprintDoc): {
	uuid: ReturnType<typeof testUuid>;
} {
	const col = doc.modules[testUuid("mod-patients")]?.caseListConfig?.columns[0];
	if (!col) throw new Error("fixture missing Patients case-list column");
	return col;
}

describe("absolute commit-gate coverage — every mutation kind is decided", () => {
	for (const [kind, coverage] of Object.entries(GUARD_COVERAGE) as Array<
		[string, Coverage]
	>) {
		if ("neverGates" in coverage) {
			it(`${kind}: the complete candidate remains valid (${coverage.neverGates})`, () => {
				if (!coverage.build) return;
				const { doc, batch } = coverage.build();
				const verdict = mutationCommitVerdict(
					doc,
					batch,
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(
					verdict.ok,
					verdict.ok ? undefined : JSON.stringify(verdict.findings),
				).toBe(true);
			});
			continue;
		}
		it(`${kind}: the gate rejects its probe (${coverage.expectCodes.join(" / ")})`, () => {
			const { doc, batch } = coverage.build();
			const verdict = mutationCommitVerdict(
				doc,
				batch,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) {
				const codes = verdict.findings.map((e) => e.code);
				expect(
					coverage.expectCodes.some((c) => codes.includes(c)),
					`expected one of [${coverage.expectCodes.join(", ")}], got [${codes.join(", ")}]`,
				).toBe(true);
			}
		});
	}
});
