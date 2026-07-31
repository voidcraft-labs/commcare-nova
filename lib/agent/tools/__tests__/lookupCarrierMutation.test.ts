/**
 * A mutating tool must still commit when the document holds a lookup carrier.
 *
 * The commit gate is absolute rather than a delta: a lookup occurrence it
 * cannot check is a `soundness` finding, and a soundness finding rejects. So a
 * tool layer that hands the gate an unavailable definition snapshot refuses
 * every mutating call on an app that touches Project data — not just the calls
 * that touch lookups. That is a whole-app brick with a retryable-sounding
 * message, and it is invisible to any test that only parses input schemas or
 * only executes read tools, which is what the suite had.
 *
 * These execute the real tool bodies against a doc carrying a lookup-backed
 * select, through a context whose `lookupDefinitions` answers.
 */

import { describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { PreparedMutationCandidate } from "@/lib/doc/commitVerdicts";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { updateModuleTool } from "../updateModule";

const MODULE = asUuid("11111111-1111-4111-8111-111111111111");
const FORM = asUuid("22222222-2222-4222-8222-222222222222");
const SELECT = asUuid("33333333-3333-4333-8333-333333333333");

const TABLE = lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001");
const VALUE = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c001",
);
const LABEL = lookupColumnIdSchema.parse(
	"01912d68-783e-7000-8000-00000000c002",
);

/** A doc whose select draws its choices from a Project data table. */
function docWithLookupCarrier(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: MODULE,
				id: "referrals",
				name: "Referrals",
				forms: [
					{
						uuid: FORM,
						id: "intake",
						name: "Intake",
						type: "survey",
						fields: [
							f({
								uuid: SELECT,
								kind: "single_select",
								id: "destination",
								label: proseText("Destination"),
								optionsSource: {
									kind: "lookup",
									tableId: TABLE,
									valueColumnId: VALUE,
									labelColumnId: LABEL,
								},
							}),
						],
					},
				],
			},
		],
	});
	return hydratePersistedBlueprint(toPersistableDoc(doc));
}

function makeCtx(options: { readonly answering: boolean }) {
	const lookupDefinitions = vi.fn(async (tableIds: readonly Uuid[]) => ({
		projectId: "project-1",
		projectRevision: 1,
		definitions: tableIds.map(() => ({
			id: TABLE,
			name: "Referral destinations",
			tag: "referral_destinations",
			revision: 1,
			columns: [
				{ id: VALUE, wireName: "code", label: "Code", dataType: "text" },
				{ id: LABEL, wireName: "name", label: "Name", dataType: "text" },
			],
		})),
	}));
	const ctx = {
		appId: "app-1",
		userId: "user-1",
		runId: "run-1",
		recordMutations: vi.fn(async (prepared: PreparedMutationCandidate) => ({
			events: [],
			committedDoc: prepared.nextDoc,
		})),
		recordMutationStages: vi.fn(
			async (prepared: PreparedMutationCandidate) => ({
				events: [],
				committedDoc: prepared.nextDoc,
			}),
		),
		recordConversation: vi.fn(),
		...(options.answering ? { lookupDefinitions } : {}),
	} as unknown as ToolExecutionContext;
	return { ctx, lookupDefinitions };
}

describe("mutating a document that carries a lookup source", () => {
	it("commits an edit that has nothing to do with the lookup", async () => {
		const doc = docWithLookupCarrier();
		const { ctx, lookupDefinitions } = makeCtx({ answering: true });

		const out = await updateModuleTool.execute(
			{ moduleUuid: MODULE, name: "Referral queue" },
			ctx,
			doc,
		);

		expect(out.result).not.toHaveProperty("error");
		expect(out.newDoc.modules[MODULE]?.name).toBe("Referral queue");
		// The gate was given a real snapshot, resolved from the carrier the doc
		// already holds — not from anything this call touched.
		expect(lookupDefinitions).toHaveBeenCalledWith([TABLE]);
	});

	it("refuses, rather than committing blind, when definitions cannot be read", async () => {
		const doc = docWithLookupCarrier();
		const { ctx } = makeCtx({ answering: false });

		const out = await updateModuleTool.execute(
			{ moduleUuid: MODULE, name: "Referral queue" },
			ctx,
			doc,
		);

		/* Fail closed: an unreadable snapshot is a soundness finding, so the
		 * whole batch is refused. The point of the test above is that this is
		 * reached only when the definitions genuinely cannot be read. */
		expect(out.result).toHaveProperty("error");
	});
});
