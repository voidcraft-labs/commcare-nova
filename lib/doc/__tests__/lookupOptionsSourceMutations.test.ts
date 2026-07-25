import { describe, expect, it } from "vitest";
import { setFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import { asUuid, mutationSchema } from "@/lib/doc/types";
import type { LookupOptionsSource } from "@/lib/domain/lookupCarriers";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";

const fieldUuid = asUuid("44444444-4444-4444-4444-444444444444");

const source: LookupOptionsSource = {
	kind: "lookup-table",
	tableId: lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001"),
	valueColumnId: lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c001",
	),
	labelColumnId: lookupColumnIdSchema.parse(
		"01912d68-783e-7000-8000-00000000c002",
	),
};

describe("setFieldOptionsSourceMutation", () => {
	it("sets the source without touching the inline options", () => {
		const mutation = setFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			source,
		);
		expect(mutation).toEqual({
			kind: "updateField",
			uuid: fieldUuid,
			targetKind: "single_select",
			patch: {},
			optionsSource: source,
		});
	});

	it("clears with an explicit null, never an omitted key", () => {
		const mutation = setFieldOptionsSourceMutation(
			fieldUuid,
			"multi_select",
			undefined,
		);
		expect(mutation).toMatchObject({ optionsSource: null });
	});

	/**
	 * The load-bearing test. `undefined` and `null` are indistinguishable to the
	 * reducer, so an in-memory assertion passes while the feature is silently
	 * broken in the running app: the SSE frame and the persisted jsonb are both
	 * `JSON.stringify`, which drops an `undefined`-valued key entirely. A clear
	 * that does not survive this round trip applies locally, reaches no
	 * receiver, and is overwritten by the next auto-save.
	 */
	it("carries the clear through a JSON round trip", () => {
		const mutation = setFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			undefined,
		);
		const wire = JSON.parse(JSON.stringify(mutation)) as Record<
			string,
			unknown
		>;
		expect("optionsSource" in wire).toBe(true);
		expect(wire.optionsSource).toBeNull();
	});

	it("carries a set source through the same round trip", () => {
		const mutation = setFieldOptionsSourceMutation(
			fieldUuid,
			"single_select",
			source,
		);
		const wire = JSON.parse(JSON.stringify(mutation));
		expect(wire).toEqual(mutation);
	});

	it("produces mutations the rolling external envelope accepts", () => {
		// Both directions must parse as ordinary `updateField` events: the
		// discriminator is not new, so an open pre-deploy tab and an old server
		// already recognize them.
		for (const next of [source, undefined]) {
			const parsed = mutationSchema.safeParse(
				JSON.parse(
					JSON.stringify(
						setFieldOptionsSourceMutation(fieldUuid, "single_select", next),
					),
				),
			);
			expect(parsed.success).toBe(true);
		}
	});
});
