import { randomUUID } from "node:crypto";
import { withProjectContext } from "@/lib/case-store";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { caseRowsToFormPreloads } from "@/lib/preview/engine/caseDataBindingClient";
import {
	type CaseDataByType,
	FormEngine,
} from "@/lib/preview/engine/formEngine";
import { previewAsMe } from "@/lib/preview/engine/identity";
import type { CaseDatabaseSnapshot } from "@/lib/preview/engine/xpathInstances";

/** Human-adjudicated bindings for the one client pilot, not a golden app shape. */
export interface ClientPilotBindings {
	readonly registration: Uuid;
	readonly followup: Uuid;
	readonly name: Uuid;
	readonly age: Uuid;
	readonly registrationPhone: Uuid;
	readonly followupPhone: Uuid;
	readonly note: Uuid;
	readonly caseType: string;
	readonly ageProperty: string;
	readonly phoneProperty: string;
}

/** The caller owns a newly created, disposable local app and its cleanup. */
export async function observeClientPilot(args: {
	doc: BlueprintDoc;
	projectId: string;
	actorId: string;
	bindings: ClientPilotBindings;
	cases?: readonly { age: number; caseId: string }[];
}) {
	const { doc, bindings: b } = args;
	const store = await withProjectContext(
		args.projectId,
		args.actorId,
		args.actorId,
	);
	if (
		!args.cases &&
		(await store.count({ appId: doc.appId, caseType: b.caseType }))
	)
		throw new Error("Scenario data requires an empty disposable app.");
	const identity = previewAsMe(
		{ id: args.actorId, name: "Authoring trial", email: "agent@dimagi.com" },
		doc,
	);
	const path = (uuid: Uuid, formUuid: Uuid) => {
		const path = computeFieldPath(doc, uuid);
		if (!path || findContainingForm(doc, uuid) !== formUuid)
			throw new Error(`Scenario field ${uuid} is outside its bound form.`);
		return `/data/${path}`;
	};
	function engine(
		formUuid: Uuid,
		data?: CaseDataByType,
		caseDatabase?: CaseDatabaseSnapshot,
	) {
		const form = doc.forms[formUuid];
		if (!form) throw new Error(`Scenario form ${formUuid} is missing.`);
		return new FormEngine(
			{
				form,
				formUuid,
				fields: doc.fields,
				fieldOrder: doc.fieldOrder,
				caseTypes: doc.caseTypes ?? [],
			},
			b.caseType,
			data,
			identity,
			undefined,
			caseDatabase,
		);
	}
	const registration = engine(b.registration);
	const namePath = path(b.name, b.registration);
	const agePath = path(b.age, b.registration);
	const phonePath = path(b.registrationPhone, b.registration);
	registration.setValue(namePath, "Ada Example");
	const ages = [-1, 0, 17, 18, 120, 121].map((age) => {
		registration.setValue(agePath, String(age));
		const canSubmit = registration.validateAll();
		return {
			age,
			canSubmit,
			ageState: registration.getState(agePath),
			phoneVisible: registration.getState(phonePath).visible,
			nameRequired: registration.getState(namePath).required,
		};
	});
	const note = registration.getState(
		path(b.note, b.registration),
	).resolvedLabel;
	const followup = [];
	for (const age of [17, 18]) {
		const now = new Date();
		const existing = args.cases?.find((sample) => sample.age === age);
		if (args.cases && !existing)
			throw new Error(`Missing recorded case for age ${age}.`);
		const { caseId } =
			existing ??
			(await store.insert({
				appId: doc.appId,
				row: {
					case_type: b.caseType,
					case_name: `Client aged ${age}`,
					properties: { [b.ageProperty]: age, [b.phoneProperty]: "" },
					status: "open",
					opened_on: now,
					modified_on: now,
					closed_on: null,
					external_id: null,
					parent_case_id: null,
				},
			}));
		const [loaded] = await store.query({
			appId: doc.appId,
			caseType: b.caseType,
			caseIds: [caseId],
			limit: 1,
		});
		if (!loaded) throw new Error("The scenario's case could not be read back.");
		if (Number(loaded.properties[b.ageProperty]) !== age)
			throw new Error("The recorded case no longer has the expected age.");
		const rows = await store.query({ appId: doc.appId, caseType: b.caseType });
		if (rows.some((row) => row.parent_case_id !== null))
			throw new Error("This client fixture requires independent records.");
		const update = engine(
			b.followup,
			caseRowsToFormPreloads(loaded, [], [{ name: b.caseType, depth: 0 }]),
			{ rows, indices: [] },
		);
		const phone = path(b.followupPhone, b.followup);
		const phoneVisible = update.getState(phone).visible;
		const canSubmitWithBlankPhone = update.validateAll();
		const phoneRequired = update.getState(phone).required;
		if (phoneVisible) update.setValue(phone, "+15550001007");
		followup.push({
			age,
			caseId,
			phoneVisible,
			phoneRequired,
			canSubmitWithBlankPhone,
			submissionProjection: update.computeSubmissionMutation({
				caseIds: [caseId],
				entryKey: randomUUID(),
			}),
		});
	}
	return {
		appId: doc.appId,
		bindings: b,
		boundary:
			"Production Preview engine; persisted scenario rows; submission projection only",
		ages,
		note,
		followup,
	};
}
