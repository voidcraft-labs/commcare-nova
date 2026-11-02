/**
 * Identity moves in private work, over migrated Postgres: the staging
 * receipt, a recovered request, and the save through the real commit kernel.
 * The plausible failures: a move staged without its sentence, a recovered
 * request that forgets the moves its first answer gave, a save the kernel
 * refuses because the private batch carries a hold change it cannot justify,
 * and a move a later step took back still stated (or still committed) at the
 * save.
 */

import { expect, it } from "vitest";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { writeHqRoundTripHorizon } from "@/lib/agent/change-set/__tests__/foldHorizonFixture";
import { lookupStageRequest } from "@/lib/agent/change-set/store";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadApp } from "@/lib/db/apps";
import {
	FOLLOWUP,
	holdVisits,
	moveFixture,
	OPEN_PATIENTS,
	PATIENTS,
	PATIENTS_NAMED,
	U,
} from "@/lib/doc/__tests__/placementMoveFixture";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { identityMovesBetween } from "@/lib/doc/identityMoves";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import type { BlueprintDoc } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import {
	beginWork,
	executeWorkTool,
	getWork,
	saveWork,
} from "../../authoring/session";

const h = setupAppStateTestDb("identity_moves_", {
	authSchema: "migrated",
	poolMax: 3,
});
const actorUserId = "identity-mover";
const projectId = "identity-moves-project";
const host = { kind: "mcp" } as const;
const VISITS = U("visits");

/** The follow-up's query repeat as a publish recorded it: its rows set
 *  when the form opens. */
function published(): BlueprintDoc {
	return expectAdmittedDoc({
		...holdVisits(moveFixture(), "model-iteration"),
	});
}

/** The query as an author writes it into the repeat. */
function queryText(doc: BlueprintDoc, query: Expression): string {
	return projectFormExpression(
		doc,
		{ entity: "field", uuid: VISITS, slot: "ids_query" },
		query,
		"unavailable",
	).text;
}

async function openWork() {
	await h.seedProjectMember(actorUserId, projectId, "owner");
	const doc = published();
	const appId = await h.seedAppWithBlueprint(doc, {
		owner: actorUserId,
		projectId,
	});
	// The saved head and its fold baseline, as the cutover leaves an app.
	await writeHqRoundTripHorizon(h.db(), appId, doc.appName);
	const work = await beginWork({
		actorUserId,
		projectId,
		host,
		target: { appId },
		requestId: "open",
	});
	return { appId, doc, args: { actorUserId, host, workId: work.workId } };
}

const editQuery = (doc: BlueprintDoc, query: Expression) => ({
	toolName: "editField",
	input: {
		moduleUuid: PATIENTS,
		formUuid: FOLLOWUP,
		fieldUuid: VISITS,
		updates: {
			kind: "repeat",
			repeat: { mode: "query_bound", ids_query: queryText(doc, query) },
		},
	},
});

async function savedDoc(appId: string): Promise<BlueprintDoc> {
	const app = await loadApp(appId);
	if (app === null) throw new Error("The app is saved.");
	return hydratePersistedBlueprint(app.blueprint);
}

const heldRows = (doc: BlueprintDoc) => {
	const visits = doc.fields[VISITS];
	return visits?.kind === "repeat" && visits.repeat_mode === "query_bound"
		? visits.placement
		: undefined;
};

it("stages a move with its sentence, returns it again on recovery, and saves it through the kernel", async () => {
	const { appId, doc, args } = await openWork();
	const call = {
		...args,
		requestId: "strand",
		...editQuery(doc, PATIENTS_NAMED),
	};
	const staged = await executeWorkTool(call);
	if (staged.kind !== "mutate") throw new Error("A staged edit mutates.");
	const subject = {
		kind: "query-repeat",
		formUuid: FOLLOWUP,
		fieldUuid: VISITS,
	};
	const result = staged.result as {
		identityMoves?: { subject: unknown; sentence: string }[];
	};
	expect(result.identityMoves?.map((move) => move.subject)).toEqual([subject]);
	expect(result.identityMoves?.[0]?.sentence).not.toBe("");

	// The durable staging receipt keeps the moves.
	const session = await h
		.db()
		.selectFrom("authoring_sessions")
		.select("active_candidate_id")
		.where("id", "=", args.workId)
		.executeTakeFirstOrThrow();
	const candidateId = session.active_candidate_id;
	if (candidateId === null) throw new Error("The work holds a candidate.");
	const stored = await lookupStageRequest(candidateId, call.requestId);
	expect(stored?.receipt.identityMoves).toEqual(result.identityMoves);

	// A request recovered from its staging receipt, as after a crash before
	// its answer was recorded, answers with the same moves.
	await h
		.db()
		.updateTable("authoring_session_requests")
		.set({ result_json: null })
		.where("ordinary_session_id", "=", args.workId)
		.where("request_id", "=", call.requestId)
		.execute();
	expect(await executeWorkTool(call)).toEqual(staged);

	const work = await getWork(args);
	const revision = work.revision;
	if (revision === null) throw new Error("The work is pending.");
	const saved = await saveWork({
		...args,
		requestId: "save",
		expectedRevision: revision,
	});
	expect(saved).toMatchObject({ saved: true });
	const after = await savedDoc(appId);
	expect(heldRows(after)).toBe("count");
	const committed = identityMovesBetween(doc, after);
	expect(committed).toHaveLength(1);
	expect(
		(saved as { identityMoves?: { subject: unknown }[] }).identityMoves?.map(
			(move) => move.subject,
		),
	).toEqual(committed.map((move) => move.subject));
	// A retried save returns the response it recorded.
	expect(
		await saveWork({ ...args, requestId: "save", expectedRevision: revision }),
	).toEqual(saved);
});

it("saves with no move where a later step puts the earlier content back", async () => {
	const { appId, doc, args } = await openWork();
	const first = await executeWorkTool({
		...args,
		requestId: "strand",
		...editQuery(doc, PATIENTS_NAMED),
	});
	expect(first).toMatchObject({
		result: { identityMoves: [{ subject: { kind: "query-repeat" } }] },
	});
	const second = await executeWorkTool({
		...args,
		requestId: "restore",
		...editQuery(doc, OPEN_PATIENTS),
	});
	expect(second.kind).toBe("mutate");
	expect((second as { result: object }).result).not.toHaveProperty(
		"identityMoves",
	);

	const work = await getWork(args);
	if (work.revision === null) throw new Error("The work is pending.");
	const saved = await saveWork({
		...args,
		requestId: "save",
		expectedRevision: work.revision,
	});
	expect(saved).toMatchObject({ saved: true });
	expect(saved).not.toHaveProperty("identityMoves");
	const after = await savedDoc(appId);
	expect(heldRows(after)).toBe("model-iteration");
	expect(readPlacementHolds(after)).toEqual(readPlacementHolds(doc));
});
