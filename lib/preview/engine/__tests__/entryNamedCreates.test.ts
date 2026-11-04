/**
 * The id of a carried create: the submission program names every create the
 * form's wire plan gives a session datum with that datum's key, whatever its
 * placement, and the entry's session mints the same key for the same datum,
 * so the case the submission creates is the case the form read as
 * `session/data/<datum>` and the case a link carries on.
 *
 * The failure each case catches: a create placed as an advanced open action
 * that keeps a fresh id (the link's target then opens a case nobody made),
 * or two creates of one type sharing one key (one id for two cases).
 */

import { describe, expect, it } from "vitest";
import {
	advancedFixture,
	HOUSEHOLDS,
	read,
	UNDER_TEST,
} from "@/lib/commcare/__tests__/advancedPlacementFixture";
import { OP, OWN } from "@/lib/commcare/__tests__/placementFixture";
import { planFormCaseWire } from "@/lib/commcare/casePlacementPlan";
import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import { entryDatumCaseId } from "@/lib/domain/entryCaseIdentity";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import { buildCaseOperationProgramFromDoc } from "../caseDataBindingHelpers";
import { entrySessionData } from "../entrySessionData";
import { FormEngine } from "../formEngine";
import type { ResolvedPreviewIdentity } from "../identity";
import { webAppsDevice } from "./fixtures/previewDevices";

const APP_ID = "app-entry-named";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "worker-1";
const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR,
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: {},
		userPropertySlugs: {},
	},
	usercase: {},
};

/** A visit made as an extension of the household the form registers. */
function visit(key: string): CaseOperation {
	return {
		uuid: OP(key),
		id: key,
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: read("name"),
		links: [
			{
				identifier: "host",
				targetType: "household",
				target: { kind: "op", opUuid: OWN },
				relationship: "extension",
			},
		],
	} as CaseOperation;
}

function registration(): BlueprintDoc {
	return advancedFixture({
		formType: "registration",
		operations: () => [
			{ uuid: OWN, id: "household", action: "own", name: read("name") },
			visit("first_visit"),
			visit("second_visit"),
		],
	}).doc;
}

function programOf(doc: BlueprintDoc) {
	const engine = new FormEngine(
		{
			doc,
			form: doc.forms[UNDER_TEST],
			formUuid: UNDER_TEST,
			fields: doc.fields,
			fieldOrder: doc.fieldOrder,
			caseTypes: doc.caseTypes ?? [],
		},
		"household",
		undefined,
		null,
	);
	engine.setValue("/data/name", "Amina");
	const mutation = engine.computeSubmissionMutation({ entryKey: ENTRY_KEY });
	const built = buildCaseOperationProgramFromDoc({
		device: webAppsDevice(),
		blueprint: doc,
		mutation,
		projection: validateCaptureSubmissionProjection(mutation),
		identity: IDENTITY,
	});
	if (built.program === undefined)
		throw new Error("The registration built no case-operation program.");
	return built.program;
}

describe("the id of every create the entry gives a datum", () => {
	it("names each open action of an advanced form with its own datum key", () => {
		const doc = registration();
		expect(emittedModuleKind(doc, HOUSEHOLDS)).toBe("advanced");
		const program = programOf(doc);
		expect(
			program.operations.map(({ operation }) =>
				program.entryCaseKeys?.get(operation.uuid),
			),
		).toEqual(["new-case", "new-child-case:visit", "new-child-case:visit:1"]);
	});

	it("mints the session's datums under the keys the submission creates them with", () => {
		const doc = registration();
		const program = programOf(doc);
		const session = entrySessionData(doc, UNDER_TEST, {
			appId: APP_ID,
			entryKey: ENTRY_KEY,
			boundCases: [],
			menuSelections: {},
			caseDatabase: null,
			session: IDENTITY.session,
		});
		// The plan's datums, in the entry's order, each holding the id the
		// envelope derives for the create the program names under that key.
		const datums = planFormCaseWire(doc, UNDER_TEST).datums;
		expect(datums.map((datum) => datum.id)).toEqual([
			"case_id_new_household_0",
			"case_id_new_visit_1",
			"case_id_new_visit_2",
		]);
		const created = datums.map((datum) => {
			const key = program.entryCaseKeys?.get(datum.operationUuid);
			if (key === undefined)
				throw new Error(`No key names the create of ${datum.id}.`);
			return entryDatumCaseId(APP_ID, ENTRY_KEY, key);
		});
		expect(datums.map((datum) => session.data[datum.id])).toEqual(created);
		expect(new Set(created).size).toBe(3);
		expect(session.newCaseId).toBe(created[0]);
	});

	it("keeps a fresh id for a create no datum names", () => {
		const doc = advancedFixture({
			formType: "registration",
			operations: () => [
				{ uuid: OWN, id: "household", action: "own", name: read("name") },
				visit("visit_per_kid"),
			],
			// One visit per row of the kids repeat: a device mints each row's id
			// as the row is made, and no datum names it.
			configure: (draft) => {
				const form = draft.forms[UNDER_TEST];
				const kids = Object.values(draft.fields).find(
					(field) => field.id === "kids",
				);
				if (form === undefined || kids === undefined)
					throw new Error("The fixture holds the kids repeat.");
				draft.forms[UNDER_TEST] = {
					...form,
					caseOperations: (form.caseOperations ?? []).map((operation) =>
						operation.uuid === OP("visit_per_kid")
							? ({
									...operation,
									name: read("kid_name"),
									forEach: { repeat: kids.uuid },
								} as CaseOperation)
							: operation,
					),
				};
			},
		}).doc;
		const program = programOf(doc);
		expect(
			program.operations.map(({ operation }) =>
				program.entryCaseKeys?.get(operation.uuid),
			),
		).toEqual(["new-case", undefined]);
	});
});
