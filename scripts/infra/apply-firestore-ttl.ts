/**
 * Provision the Firestore per-field TTL policies the multiplayer stream relies
 * on. Each of the three multiplayer subcollections carries an `expireAt`
 * Timestamp the writer stamps (`acceptedMutations` at `now +
 * ACCEPTED_MUTATIONS_TTL_MS`, `presence` at `now + PRESENCE_TTL_MS`, `batchDedup`
 * at `now + BATCH_DEDUP_TTL_MS`); a TTL policy on that field is what makes
 * Firestore reap the expired doc. The stamp is written by application code, but
 * the POLICY is out-of-band infrastructure — this script installs it.
 *
 * The three are SUBcollections (`apps/{appId}/acceptedMutations/{seq}`, etc.),
 * so the field path targets the collection id at the collection-group scope:
 * one policy covers that field across every app's subcollection of that id.
 *
 * Idempotent — re-running sets the same three policies. TTL provisioning is an
 * async long-running operation; the script awaits each to completion so a
 * failure surfaces with a non-zero exit.
 *
 * Run against the real database, with ADC configured for an identity holding
 * `datastore.indexes.update` (the TTL policy is a field-config write):
 *
 *   GOOGLE_CLOUD_PROJECT=<project> \
 *   npx tsx scripts/infra/apply-firestore-ttl.ts
 *
 * Alternatively, provision the same three policies out-of-band via gcloud:
 *
 *   gcloud firestore fields ttls update expireAt \
 *     --collection-group=acceptedMutations --enable-ttl --project=<project>
 *   gcloud firestore fields ttls update expireAt \
 *     --collection-group=presence --enable-ttl --project=<project>
 *   gcloud firestore fields ttls update expireAt \
 *     --collection-group=batchDedup --enable-ttl --project=<project>
 */

import { v1 } from "@google-cloud/firestore";

/** The three multiplayer subcollections whose `expireAt` field carries a TTL. */
const TTL_COLLECTION_GROUPS = [
	"acceptedMutations",
	"presence",
	"batchDedup",
] as const;

const TTL_FIELD = "expireAt";

async function main(): Promise<void> {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (!project) {
		console.error(
			"GOOGLE_CLOUD_PROJECT is unset — set it to the target project before running.",
		);
		process.exit(1);
	}

	const client = new v1.FirestoreAdminClient();
	const database = "(default)";

	for (const collectionGroup of TTL_COLLECTION_GROUPS) {
		const name = client.fieldPath(
			project,
			database,
			collectionGroup,
			TTL_FIELD,
		);
		console.log(
			`Enabling TTL on ${collectionGroup}.${TTL_FIELD} (collection-group) …`,
		);
		const [operation] = await client.updateField({
			field: { name, ttlConfig: {} },
			/* Update ONLY the ttlConfig — an empty mask would let the RPC clear the
			 * field's index config. */
			updateMask: { paths: ["ttl_config"] },
		});
		await operation.promise();
		console.log(`  Done — expired ${collectionGroup} docs will be reaped.`);
	}

	await client.close();
	console.log("All three TTL policies are in place.");
}

main().catch((err: unknown) => {
	console.error("Failed to apply the Firestore TTL policies:", err);
	process.exit(1);
});
