/**
 * The genesis write tail over real Postgres, at a size only a whole app
 * brought in from CommCare HQ reaches.
 *
 * It would catch: a birth that writes its entity rows in one statement, which
 * Postgres refuses past 65,535 bound parameters (six per row, so about 10,900
 * menus, forms and fields), leaving an app that can never be created however
 * often the person tries again.
 */

import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import { proseText } from "@/lib/domain/prose";
import {
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "../appGenesis";
import { loadApp } from "../apps";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("app_genesis_");
const PROJECT = "project-1";
const OWNER = "owner-1";

/** Twelve forms of a thousand questions: 12,013 entity rows, past the
 *  10,922 one statement of six parameters a row can bind. */
const FORMS = 12;
const FIELDS_PER_FORM = 1000;

it("births an app whose entity rows pass what one statement can bind", async () => {
	await h.seedProjectMember(OWNER, PROJECT, "owner");
	const doc = buildDoc({
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

	const stored = await h
		.db()
		.selectFrom("blueprint_entities")
		.select((eb) => eb.fn.countAll<string>().as("count"))
		.where("app_id", "=", doc.appId)
		.executeTakeFirstOrThrow();
	expect(Number(stored.count)).toBe(1 + FORMS + FORMS * FIELDS_PER_FORM);
	const loaded = await loadApp(doc.appId);
	expect(loaded?.blueprint).toEqual(toPersistableDoc(doc));
}, 120_000);
