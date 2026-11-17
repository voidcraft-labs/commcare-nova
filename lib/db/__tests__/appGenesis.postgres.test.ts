/**
 * The writers of an app's entity rows over real Postgres, at a size only a
 * whole app brought in from CommCare HQ reaches: the genesis write tail, a
 * commit's entity diff, and the test seed.
 *
 * It would catch: a writer that writes or deletes its entity rows in one
 * statement, which Postgres refuses past 65,535 bound parameters (six per row,
 * so about 10,900 menus, forms and fields), leaving an app that can never be
 * created, or an edit of one that can never be saved, however often the person
 * tries again.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "../appGenesis";
import { loadApp } from "../apps";
import { writeBlueprintEntityDiff } from "../canonicalCommitKernel";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("app_genesis_");
const PROJECT = "project-1";
const OWNER = "owner-1";

/** Twelve forms of a thousand questions: 12,013 entity rows, past the
 *  10,922 one statement of six parameters a row can bind. */
const FORMS = 12;
const FIELDS_PER_FORM = 1000;

/** One menu of twelve survey forms of a thousand questions each. */
function registry(): BlueprintDoc {
	return buildDoc({
		appName: "Registry",
		appSettings: { showSavedForms: false, showIncompleteForms: false },
		modules: [
			{
				name: "Registry",
				forms: Array.from({ length: FORMS }, (_, form) => ({
					name: `Section ${form + 1}`,
					type: "survey" as const,
					fields: Array.from({ length: FIELDS_PER_FORM }, (_, field) =>
						f({
							kind: "text",
							id: `q${field + 1}`,
							label: proseText(`Question ${field + 1}`),
						}),
					),
				})),
			},
		],
	});
}

async function entityRowCount(appId: string): Promise<number> {
	const stored = await h
		.db()
		.selectFrom("blueprint_entities")
		.select((eb) => eb.fn.countAll<string>().as("count"))
		.where("app_id", "=", appId)
		.executeTakeFirstOrThrow();
	return Number(stored.count);
}

it("births an app whose entity rows pass what one statement can bind", async () => {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const doc = registry();
	const candidate = prepareGenesisCandidate({
		appId: doc.appId,
		projectId: PROJECT,
		mutations: diffDocsToMutations(emptyBlueprintDoc(doc.appId), doc),
	});

	await h.withTransaction((tx) =>
		writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: OWNER,
			runId: crypto.randomUUID(),
			status: "complete",
		}),
	);

	expect(await entityRowCount(doc.appId)).toBe(
		1 + FORMS + FORMS * FIELDS_PER_FORM,
	);
	const loaded = await loadApp(doc.appId);
	expect(loaded?.blueprint).toEqual(toPersistableDoc(doc));
}, 120_000);

it("saves a commit that changes, then removes, more entity rows than one statement can bind", async () => {
	const doc = registry();
	await h.seedAppWithBlueprint(doc, {
		id: doc.appId,
		owner: OWNER,
		projectId: PROJECT,
	});
	const seeded = toPersistableDoc(doc);
	expect(await entityRowCount(doc.appId)).toBe(
		1 + FORMS + FORMS * FIELDS_PER_FORM,
	);

	/* Every question's label changes: twelve thousand rows upserted. */
	const fields = { ...doc.fields };
	for (const uuid of Object.keys(fields) as Uuid[]) {
		const field = fields[uuid];
		if (field?.kind === "text")
			fields[uuid] = { ...field, label: proseText(`Asked again ${field.id}`) };
	}
	const relabeled = toPersistableDoc({ ...doc, fields });
	await h.withTransaction((tx) =>
		writeBlueprintEntityDiff(tx, {
			appId: doc.appId,
			prevDoc: seeded,
			committedDoc: relabeled,
		}),
	);
	expect((await loadApp(doc.appId))?.blueprint).toEqual(relabeled);

	/* Every question goes: twelve thousand rows deleted. */
	const fieldOrder = { ...doc.fieldOrder };
	for (const parent of Object.keys(fieldOrder) as Uuid[])
		fieldOrder[parent] = [];
	const emptied = toPersistableDoc({ ...doc, fields: {}, fieldOrder });
	await h.withTransaction((tx) =>
		writeBlueprintEntityDiff(tx, {
			appId: doc.appId,
			prevDoc: relabeled,
			committedDoc: emptied,
		}),
	);
	expect(await entityRowCount(doc.appId)).toBe(1 + FORMS);
}, 120_000);
