/**
 * Records a publish's placements in one app of the local smoke database, as
 * `publishAppToHq` does after preflight: the head read under an `edit`
 * check, `placementsToHold` over it, and `recordPublishPlacements` at that
 * head. The multiplayer spec runs it between two steps of one scenario, so
 * the open tabs meet the `publish-placement` change a real publish writes,
 * with no CommCare HQ in the loop.
 *
 * A child process of its own because the writer is server-only: it runs
 * under `tsx --conditions=react-server`, as `e2e/seed.ts` does, and prints
 * one line, `recorded placements: ` and the JSON `{ seq, count }`.
 *
 *   tsx --conditions=react-server e2e/lib/recordPublishPlacements.ts <appId> <userId>
 */

import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { recordPublishPlacements } from "@/lib/deployment/placements";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";

async function main(): Promise<void> {
	if (!process.env.NOVA_DB_LOCAL_URL)
		throw new Error(
			"Recording a publish's placements here writes to the local smoke database only, and NOVA_DB_LOCAL_URL isn't set. Run it from the smoke harness.",
		);
	const [appId, userId] = process.argv.slice(2);
	if (appId === undefined || userId === undefined)
		throw new Error(
			"Name the app and the user who publishes it: recordPublishPlacements.ts <appId> <userId>.",
		);
	const access = await resolveAppAccess(appId, userId, "edit");
	const doc = hydratePersistedBlueprint(access.app.blueprint as PersistableDoc);
	const holds = placementsToHold(doc);
	if (holds.length === 0)
		throw new Error(
			`App ${appId} holds every placement its emission derives, so a publish would record nothing. The scenario needs an app with an unheld case change.`,
		);
	const outcome = await recordPublishPlacements({
		scope: {
			appId,
			projectId: access.projectId,
			role: access.role,
			actorUserId: userId,
		},
		expectedHeadSeq: access.app.mutation_seq,
		holds,
	});
	if (outcome.kind !== "recorded")
		throw new Error(
			outcome.kind === "head-moved"
				? `App ${appId} changed while its placements were being recorded. Nothing was written; the scenario's tabs should be idle at this step.`
				: `The placements of app ${appId} were refused: ${outcome.message}`,
		);
	process.stdout.write(
		`recorded placements: ${JSON.stringify({ seq: outcome.seq, count: outcome.count })}\n`,
	);
}

main()
	.finally(closeCaseStoreDatabase)
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
