/**
 * Guard coverage per mutation kind — the second half of the proof that
 * licenses deleting the validate-fix loop (beside the construction fuzz):
 * for EVERY mutation kind, either a concrete probe shows the shared
 * commit verdict rejecting a finding that kind can introduce — with the
 * scope derivation widened far enough to SEE it — or the entry records
 * why the kind cannot introduce a gated finding at all (and pins that
 * its scope never widens to `full`).
 *
 * The table is `satisfies`-total over `Mutation["kind"]`: adding a
 * mutation kind without deciding its guard coverage here is a compile
 * error, the same tripwire shape `scopeOfMutations`' exhaustive switch
 * uses for the scope decision itself. The kinds whose probes assert
 * `fullScope` are the validation re-scopers (the gate would go STALE on
 * them under any entity-keyed narrowing): `removeModule`, `moveForm`,
 * `removeForm`, `updateModule({caseType})`, `updateForm({type})`,
 * `setCaseTypes`, `setConnectType`, and the case-property-writer field
 * mutations.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f, xp } from "@/lib/__tests__/docHelpers";
import type { ValidationErrorCode } from "@/lib/commcare/validator/errors";
import { scopeOfMutations } from "@/lib/commcare/validator/scopeOfMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc, type Field } from "@/lib/domain";

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
 * — plus a `status` writer and an empty repeat). Module 1 ("Archive",
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
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "village",
								label: "Village",
								case_property_on: "patient",
							}),
							f({
								kind: "date",
								id: "dob",
								label: "Date of birth",
								case_property_on: "patient",
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
								label: "Date of birth",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "status",
								label: "Status",
								case_property_on: "patient",
							}),
							f({
								kind: "repeat",
								id: "visits",
								label: "Visits",
								children: [f({ kind: "text", id: "note", label: "Note" })],
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
						fields: [f({ kind: "text", id: "comments", label: "Comments" })],
						formLinks: [
							{
								target: {
									type: "form",
									moduleUuid: asUuid("mod-patients"),
									formUuid: asUuid("frm-reg"),
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
					{ name: "case_name", label: "Name" },
					{ name: "village", label: "Village" },
					{ name: "dob", label: "Date of birth" },
					{ name: "status", label: "Status" },
				],
			},
		],
	});
}

/** A field's relevant expression referencing the catalog — the
 *  `setCaseTypes` probe's tripwire. */
function caseRefDoc(): BlueprintDoc {
	const doc = richDoc();
	const status = byId(doc, "status");
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

/** A writer whose id sits exactly at the case-property length cap —
 *  `duplicateField`'s probe: the clone's dedup suffix (`_2`) pushes the
 *  MINTED property name past the cap, a finding keyed on the NEW
 *  property (so it can't collapse into any pre-existing identity). */
const AT_CAP_ID = `p${"x".repeat(254)}`;
function capWriterDoc(): BlueprintDoc {
	return buildDoc({
		appName: "Cap writer",
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
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: AT_CAP_ID,
								label: "At the cap",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: AT_CAP_ID, label: "At the cap" },
				],
			},
		],
	});
}

interface RejectionProbe {
	/** Build the doc + the batch the gate must refuse. */
	build: () => { doc: BlueprintDoc; batch: Mutation[] };
	/** At least one of these codes must be among the introduced findings. */
	expectCodes: ValidationErrorCode[];
	/** True for the kinds whose effects out-run any entity-keyed scope —
	 *  asserts `scopeOfMutations` widens to `full` for this batch, which
	 *  is what lets the verdict SEE the cross-entity finding at all. */
	fullScope?: boolean;
}

interface NeverGates {
	/** Why this kind cannot introduce a gated finding on its own. */
	neverGates: string;
	/** A representative batch — pinned to NOT widen to full (the kind's
	 *  scope decision in `scopeOfMutations` matches its documented reach). */
	build?: () => { doc: BlueprintDoc; batch: Mutation[] };
}

type Coverage = RejectionProbe | NeverGates;

const GUARD_COVERAGE = {
	// ── Module kinds ────────────────────────────────────────────────
	addModule: {
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "addModule",
					module: {
						uuid: asUuid("m-new"),
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
		fullScope: true,
	},
	moveModule: {
		neverGates:
			"pure reorder of moduleOrder — no rule reads module position (duplicate names are name-keyed app rules)",
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "moveModule", uuid: doc.moduleOrder[1], toIndex: 0 }],
			};
		},
	},
	renameModule: {
		neverGates:
			"renames the module's SEMANTIC id, which no validator rule reads — display names (DUPLICATE_MODULE_NAME) ride updateModule patches",
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
		expectCodes: ["REGISTRATION_NO_CASE_PROPS", "MISSING_CASE_LIST_COLUMNS"],
		fullScope: true,
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
							uuid: asUuid("f-new"),
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
				batch: [{ kind: "removeForm", uuid: asUuid("frm-reg") }],
			};
		},
		expectCodes: ["FORM_LINK_TARGET_NOT_FOUND"],
		fullScope: true,
	},
	moveForm: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [
					{
						kind: "moveForm",
						uuid: asUuid("frm-reg"),
						toModuleUuid: doc.moduleOrder[1],
						toIndex: 0,
					},
				],
			};
		},
		expectCodes: ["NO_CASE_TYPE"],
		fullScope: true,
	},
	renameForm: {
		neverGates:
			"renames the form's SEMANTIC id, which no validator rule reads — display names ride updateForm patches",
		build: () => ({
			doc: richDoc(),
			batch: [
				{ kind: "renameForm", uuid: asUuid("frm-reg"), newId: "renamed" },
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
		fullScope: true,
	},
	setFormMedia: {
		neverGates:
			"media slots never touch the writer set; the media rules are manifest-gated and boundary-only",
		build: () => ({
			doc: richDoc(),
			batch: [
				{
					kind: "setFormMedia",
					uuid: asUuid("frm-reg"),
					icon: null,
					audioLabel: null,
				},
			],
		}),
	},

	// ── Field kinds ─────────────────────────────────────────────────
	addField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// A writer for a case type with no module: child-case creation
				// derives, and the child case has no name writer.
				batch: [
					{
						kind: "addField",
						parentUuid: asUuid("frm-reg"),
						field: {
							uuid: asUuid("fld-stranger"),
							kind: "text",
							id: "stranger_note",
							label: "Note",
							case_property_on: "stranger",
						} as Field,
					},
				],
			};
		},
		expectCodes: ["CHILD_CASE_NO_NAME_FIELD", "MISSING_CHILD_CASE_MODULE"],
		fullScope: true,
	},
	removeField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				batch: [{ kind: "removeField", uuid: byId(doc, "case_name").uuid }],
			};
		},
		expectCodes: ["NO_CASE_NAME_FIELD", "CASE_LIST_COLUMN_UNKNOWN_FIELD"],
		fullScope: true,
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
						uuid: byId(doc, "status").uuid,
						toParentUuid: byId(doc, "visits").uuid,
						toIndex: 0,
					},
				],
			};
		},
		expectCodes: ["PRIMARY_CASE_FIELD_IN_REPEAT"],
		fullScope: true,
	},
	renameField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// Renaming a case-bound writer renames the case PROPERTY —
				// `date` is on CommCare's reserved list.
				batch: [
					{
						kind: "renameField",
						uuid: byId(doc, "village").uuid,
						newId: "date",
					},
				],
			};
		},
		expectCodes: ["RESERVED_CASE_PROPERTY"],
		fullScope: true,
	},
	duplicateField: {
		build: () => {
			const doc = capWriterDoc();
			return {
				doc,
				batch: [{ kind: "duplicateField", uuid: byId(doc, AT_CAP_ID).uuid }],
			};
		},
		// The clone's auto-suffixed id MINTS a new case property past the
		// 255-char cap — a finding keyed on the new property name, so it
		// can't collapse into any pre-existing identity.
		expectCodes: ["CASE_PROPERTY_TOO_LONG"],
		fullScope: true,
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
		fullScope: true,
	},
	updateField: {
		build: () => {
			const doc = richDoc();
			return {
				doc,
				// Re-target a writer at a case type with no module/name writer.
				batch: [
					{
						kind: "updateField",
						uuid: byId(doc, "village").uuid,
						targetKind: "text",
						patch: { case_property_on: "stranger" },
					} as Mutation,
				],
			};
		},
		expectCodes: ["CHILD_CASE_NO_NAME_FIELD", "MISSING_CHILD_CASE_MODULE"],
		fullScope: true,
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
		fullScope: true,
	},
	setCaseTypes: {
		build: () => {
			const doc = caseRefDoc();
			return {
				doc,
				// Drop `village` from the catalog while a field's relevant
				// still reads `#patient/village` — the reference resolution
				// flips in an entity the batch never names.
				batch: [
					{
						kind: "setCaseTypes",
						caseTypes: [
							{
								name: "patient",
								properties: [
									{ name: "case_name", label: "Name" },
									{ name: "dob", label: "Date of birth" },
									{ name: "status", label: "Status" },
								],
							},
						],
					},
				],
			};
		},
		expectCodes: [
			"INVALID_CASE_REF",
			"INVALID_REF",
			"CASE_PROPERTY_MISSING_FIELD",
		],
		fullScope: true,
	},
} satisfies Record<Mutation["kind"], Coverage>;

describe("re-scoping guard coverage — every mutation kind is decided", () => {
	for (const [kind, coverage] of Object.entries(GUARD_COVERAGE)) {
		if ("neverGates" in coverage) {
			it(`${kind}: cannot introduce a gated finding (${coverage.neverGates})`, () => {
				if (!coverage.build) return;
				const { doc, batch } = coverage.build();
				// The kind's scope decision matches its documented reach — it
				// never silently widens to a full run (nor needs to).
				expect(scopeOfMutations(doc, batch)).not.toBe("full");
				const verdict = mutationCommitVerdict(doc, batch);
				expect(verdict.ok).toBe(true);
			});
			continue;
		}
		it(`${kind}: the gate rejects its probe (${coverage.expectCodes.join(" / ")})`, () => {
			const { doc, batch } = coverage.build();
			if ("fullScope" in coverage && coverage.fullScope) {
				expect(scopeOfMutations(doc, batch)).toBe("full");
			}
			const verdict = mutationCommitVerdict(doc, batch);
			expect(verdict.ok).toBe(false);
			if (!verdict.ok) {
				const codes = verdict.introduced.map((e) => e.code);
				expect(
					coverage.expectCodes.some((c) => codes.includes(c)),
					`expected one of [${coverage.expectCodes.join(", ")}], got [${codes.join(", ")}]`,
				).toBe(true);
			}
		});
	}
});
