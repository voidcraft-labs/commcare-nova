/**
 * A gate-valid follow-up form whose case changes can be held: the form's own
 * case (it saves `village`) and a child `kid` it creates, each with the
 * places the placement planner offers it. The Postgres suites seed it, write
 * holds and recordings over it, and commit edits through the real kernel.
 */
import type { Kysely } from "kysely";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { placementCandidates } from "@/lib/commcare/placement";
import type { Mutation, PlacementHoldEntry } from "@/lib/doc/types";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePlacement,
	Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { AppDatabase } from "../pg";

export interface HeldPlacementApp {
	readonly doc: BlueprintDoc;
	readonly formUuid: Uuid;
	readonly own: CaseOperation;
	readonly kid: CaseOperation;
	/** The own case's basic slot. */
	readonly ownBasic: CasePlacement;
	/** The own case's Save to Case block. */
	readonly ownSaveToCase: CasePlacement;
	/** The kid's Save to Case block. */
	readonly kidSaveToCase: CasePlacement;
}

function candidates(doc: BlueprintDoc, formUuid: Uuid, operationUuid: Uuid) {
	return placementCandidates(doc, formUuid, {
		kind: "operation",
		operationUuid,
	});
}

/** The app, with `configure` writing holds onto its document. */
export function heldPlacementApp(
	configure: (app: HeldPlacementApp) => void = () => {},
): HeldPlacementApp {
	const doc = buildDoc({
		appName: "Held placements",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "village",
								label: proseText("Village"),
								caseWrite: { caseType: "patient", property: "village" },
							}),
							f({
								kind: "text",
								id: "kid_name",
								label: proseText("Kid"),
								caseWrite: { caseType: "kid", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				name: "Kids",
				caseType: "kid",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village") },
				],
			},
			{
				name: "kid",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
	});
	const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
	const [own, kid] = doc.forms[formUuid].caseOperations ?? [];
	if (own?.action !== "own" || kid?.action !== "create")
		throw new Error("The fixture's form holds its own case and a kid.");
	const [ownBasic, ownSaveToCase] = candidates(doc, formUuid, own.uuid);
	// The kid takes a basic subcase slot first; its Save to Case block follows.
	const kidSaveToCase = candidates(doc, formUuid, kid.uuid).find(
		(candidate) => candidate.kind === "save-to-case",
	);
	if (
		ownBasic?.kind !== "basic" ||
		ownSaveToCase?.kind !== "save-to-case" ||
		kidSaveToCase?.kind !== "save-to-case"
	)
		throw new Error("The planner offers the fixture's places.");
	const app: HeldPlacementApp = {
		doc,
		formUuid,
		own: structuredClone(own),
		kid: structuredClone(kid),
		ownBasic,
		ownSaveToCase,
		kidSaveToCase,
	};
	configure(app);
	return app;
}

/** Writes `placement` onto the operation's held slot of `app.doc`. */
export function holdOperation(
	app: HeldPlacementApp,
	operationUuid: Uuid,
	placement: CasePlacement,
): void {
	const op = app.doc.forms[app.formUuid].caseOperations?.find(
		(o) => o.uuid === operationUuid,
	);
	if (op === undefined) throw new Error(`The fixture holds ${operationUuid}.`);
	op.placement = placement;
}

export function operationHold(
	app: HeldPlacementApp,
	operationUuid: Uuid,
	placement: CasePlacement | null,
): PlacementHoldEntry {
	return {
		target: "case-operation",
		formUuid: app.formUuid,
		operationUuid,
		placement,
	};
}

export const holdPlacements = (...holds: PlacementHoldEntry[]): Mutation => ({
	kind: "holdPlacements",
	holds,
});

/** Saves `village` only when its answer changed (`true`), or every time
 *  again (`null`). Save to Case cannot keep only changed answers. */
export function villageOnlyIfChanged(
	app: HeldPlacementApp,
	onlyIfChanged: true | null,
): Mutation {
	return {
		kind: "updateForm",
		uuid: app.formUuid,
		patch: {},
		caseOperationPatch: {
			operation: "update-write",
			uuid: app.own.uuid,
			key: { property: "village" },
			patch: { onlyIfChanged },
		},
	} as Mutation;
}

export function removeKid(app: HeldPlacementApp): Mutation {
	return {
		kind: "updateForm",
		uuid: app.formUuid,
		patch: {},
		caseOperationChange: { operation: "remove", uuid: app.kid.uuid },
	} as Mutation;
}

export function addKid(app: HeldPlacementApp): Mutation {
	return {
		kind: "updateForm",
		uuid: app.formUuid,
		patch: {},
		caseOperationChange: { operation: "add", value: app.kid },
	} as Mutation;
}

/**
 * One `app_changes` row of `kind` holding `mutations`, at the app's next
 * sequence, with the head advanced to it, written as a raw row: a recording a
 * publish or a migration wrote, or an editor's row, read by `readRecordedPlacementHolds` alone.
 * Returns its sequence.
 */
export async function appendChangeRow(
	db: Kysely<AppDatabase>,
	appId: string,
	kind:
		| "publish-placement"
		| "blueprint-migration"
		| "autosave"
		| "mcp"
		| "chat",
	mutations: readonly Mutation[],
): Promise<number> {
	return db.transaction().execute(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const seq = Number(app.mutation_seq) + 1;
		await tx
			.updateTable("apps")
			.set({ mutation_seq: seq })
			.where("id", "=", appId)
			.execute();
		await tx
			.insertInto("app_changes")
			.values({
				app_id: appId,
				seq,
				batch_id: `placement-row:${seq}`,
				run_id: kind === "chat" || kind === "mcp" ? `run-${seq}` : null,
				actor_id:
					kind === "blueprint-migration"
						? "system:placement-recordings"
						: "placement-editor",
				kind,
				mutations: JSON.stringify(mutations),
				from_project_id: null,
				to_project_id: null,
			})
			.execute();
		return seq;
	});
}
