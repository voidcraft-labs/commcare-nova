// Which workers a commit changed — the gate that keeps the usercase sweep off
// the autosave path.
//
// This is pure on purpose. The overwhelmingly common commit edits a field and
// touches no worker, and it must cost ZERO queries; syncing every persona on
// every save would put one read per persona on a path that fires constantly.
// So the interesting assertions here are the NEGATIVE ones.

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { workersNeedingUsercaseSync } from "../syncUsercaseRow";

const A = "1a2b3c4d-0000-4000-8000-000000000001";
const B = "1a2b3c4d-0000-4000-8000-000000000002";

function makeDoc(args: {
	personas?: Record<
		string,
		{
			uuid: string;
			name: string;
			values?: Record<string, string>;
			userTypeUuid?: string;
		}
	>;
	userProperties?: Record<
		string,
		{ uuid: string; slug: string; label: string }
	>;
	userTypes?: Record<
		string,
		{ uuid: string; name: string; values?: Record<string, string> }
	>;
}): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "Test",
		connectType: null,
		caseTypes: [],
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		personas: args.personas ?? {},
		userProperties: args.userProperties ?? {},
		userTypes: args.userTypes ?? {},
	} as unknown as BlueprintDoc;
}

const CADRE = { uuid: "u-1", slug: "cadre", label: "Cadre" };
const AMARA = { uuid: A, name: "Amara" };

function changed(prior: BlueprintDoc, next: BlueprintDoc): string[] {
	return workersNeedingUsercaseSync({
		prior,
		next,
		projectSpace: null,
	}).map((entry) => entry.worker.id);
}

describe("workersNeedingUsercaseSync", () => {
	it("names nobody when nothing about any worker changed", () => {
		// THE cost-control assertion. A field edit commits constantly; if this
		// ever returns a worker, every save pays a database round-trip per
		// persona.
		const doc = makeDoc({
			personas: { [A]: AMARA },
			userProperties: { "u-1": CADRE },
		});
		expect(changed(doc, doc)).toEqual([]);
	});

	it("names a newly added worker", () => {
		expect(changed(makeDoc({}), makeDoc({ personas: { [A]: AMARA } }))).toEqual(
			[A],
		);
	});

	it("names a worker whose display name changed", () => {
		// The case that would be missed by watching the case-type surface
		// alone: a rename changes the case's NAME and no property at all.
		expect(
			changed(
				makeDoc({ personas: { [A]: AMARA } }),
				makeDoc({ personas: { [A]: { ...AMARA, name: "Amara Sow" } } }),
			),
		).toEqual([A]);
	});

	it("names a worker whose authored value changed", () => {
		const base = { personas: { [A]: AMARA }, userProperties: { "u-1": CADRE } };
		expect(
			changed(
				makeDoc(base),
				makeDoc({
					...base,
					personas: { [A]: { ...AMARA, values: { "u-1": "nurse" } } },
				}),
			),
		).toEqual([A]);
	});

	it("names every worker when the property catalog itself changed", () => {
		// A new declared property seeds a blank slot on EVERY worker's case, so
		// every worker's record differs and every row needs it.
		const personas = { [A]: AMARA, [B]: { uuid: B, name: "Bala" } };
		expect(
			changed(
				makeDoc({ personas }),
				makeDoc({ personas, userProperties: { "u-1": CADRE } }),
			).sort(),
		).toEqual([A, B].sort());
	});

	it("names only the worker that changed, not their colleagues", () => {
		const base = {
			personas: { [A]: AMARA, [B]: { uuid: B, name: "Bala" } },
			userProperties: { "u-1": CADRE },
		};
		expect(
			changed(
				makeDoc(base),
				makeDoc({
					...base,
					personas: {
						...base.personas,
						[B]: { uuid: B, name: "Bala", values: { "u-1": "driver" } },
					},
				}),
			),
		).toEqual([B]);
	});

	it("names a worker whose user type's defaults changed", () => {
		// The value can arrive from the persona OR from its user type, and the
		// derived record is what this compares — so neither source needs to be
		// enumerated here, which is why a new one cannot be forgotten.
		const personas = { [A]: { ...AMARA, userTypeUuid: "t-1" } };
		const userProperties = { "u-1": CADRE };
		expect(
			changed(
				makeDoc({
					personas,
					userProperties,
					userTypes: { "t-1": { uuid: "t-1", name: "Nurse" } },
				}),
				makeDoc({
					personas,
					userProperties,
					userTypes: {
						"t-1": { uuid: "t-1", name: "Nurse", values: { "u-1": "nurse" } },
					},
				}),
			),
		).toEqual([A]);
	});

	it("says nothing about a REMOVED worker", () => {
		// Removal closes the row rather than rewriting it, so it is a different
		// operation on a different trigger. Reporting it here would make the
		// sweep create a case for a persona that no longer exists.
		expect(changed(makeDoc({ personas: { [A]: AMARA } }), makeDoc({}))).toEqual(
			[],
		);
	});
});
