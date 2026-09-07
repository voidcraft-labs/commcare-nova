/** Stored JSON compatibility: full admitted endpoints and exact projection.
 * Sealed raw digest verification remains in the native artifact-store suite. */
import { expect, it } from "vitest";
import {
	type AppDesignContract,
	appDesignContractSchema,
	normalizeStoredAppDesignContract,
} from "../contract";
import {
	addPatientReviewWorkflow,
	did,
	ids,
	makeContract,
	makeNestedMenuContract,
} from "./fixtures";

function legacy(current: AppDesignContract, hint = ids.taskVisit) {
	return {
		...current,
		moduleCompositions: current.moduleCompositions.map(
			({ selection: _selection, ...module }) => module,
		),
		lists: current.lists.map((list) => ({
			...list,
			selectionWorkflowId: hint,
		})),
	};
}
function roundTrip(stored: unknown, expected: AppDesignContract) {
	const before = JSON.stringify(stored);
	const parsed = JSON.parse(before);
	const normalized = normalizeStoredAppDesignContract(parsed);
	expect(normalized).toEqual(appDesignContractSchema.parse(expected));
	expect(normalizeStoredAppDesignContract(normalized)).toEqual(normalized);
	expect(JSON.stringify(stored)).toBe(before);
	expect(parsed).toEqual(JSON.parse(before));
	return normalized;
}

it("preserves the whole current graph and is idempotent without mutating input", () => {
	const current = makeContract();
	roundTrip(current, current);
});
it("fills only omitted additive collections at the stored boundary", () => {
	const current = makeContract();
	const {
		moduleCompositions: _modules,
		formCompositions: _forms,
		lookupTables: _lookups,
		...stored
	} = current;
	expect(appDesignContractSchema.safeParse(stored).success).toBe(false);
	roundTrip(stored, {
		...current,
		moduleCompositions: [],
		formCompositions: [],
		lookupTables: [],
	});
});
it.each(["moduleCompositions", "formCompositions", "lookupTables"] as const)(
	"does not repair malformed %s into an empty collection",
	(key) => {
		const current = appDesignContractSchema.parse({
			...makeContract(),
			moduleCompositions: [],
			formCompositions: [],
			lookupTables: [],
		});
		for (const invalid of [null, {}, "", false, 1]) {
			const stored = { ...current, [key]: invalid };
			expect(appDesignContractSchema.safeParse(stored).success).toBe(false);
			expect(() => normalizeStoredAppDesignContract(stored)).toThrow();
		}
	},
);
it.each([ids.taskVisit, ids.taskRegister])(
	"derives actual selected consumers rather than trusting legacy usage hint %s",
	(hint) => {
		const current = makeContract();
		const stored = legacy(current, hint);
		expect(appDesignContractSchema.safeParse(stored).success).toBe(false);
		roundTrip(stored, current);
	},
);
it("derives all consumers in workflow order while leaving nonconsumers unselected", () => {
	const current = makeContract();
	addPatientReviewWorkflow(current);
	current.moduleCompositions[0].selection = {
		workflowIds: [ids.taskVisit, ids.taskReview],
		cases: "one",
	};
	const admitted = appDesignContractSchema.parse(current);
	const stored = legacy(admitted);
	stored.formCompositions = [...stored.formCompositions].reverse();
	roundTrip(stored, { ...admitted, formCompositions: stored.formCompositions });
});
it("preserves explicit current many-case selection rather than defaulting it", () => {
	const current = makeContract();
	current.moduleCompositions[0].selection = {
		workflowIds: [ids.taskVisit],
		cases: "several",
		maximum: 12,
	};
	const admitted = appDesignContractSchema.parse(current);
	roundTrip(
		{
			...admitted,
			lists: admitted.lists.map((list) => ({
				...list,
				selectionWorkflowId: ids.taskVisit,
			})),
		},
		admitted,
	);
});
it("recovers a child form-host's own selection when the parent is not a queue-only carrier", () => {
	const current = makeNestedMenuContract();
	roundTrip(legacy(current), current);
});
it("recovers parent queue selection without synthesizing a duplicate child carrier", () => {
	const current = makeNestedMenuContract();
	const [parent, child] = current.moduleCompositions;
	parent.role = "queue-only";
	parent.selection = { workflowIds: [ids.taskVisit], cases: "one" };
	delete child.selection;
	child.workflowIds = [ids.taskRegister, ids.taskVisit];
	current.formCompositions = current.formCompositions.map((form) => ({
		...form,
		moduleCompositionId: child.id,
	}));
	const admitted = appDesignContractSchema.parse(current);
	roundTrip(legacy(admitted), admitted);
});
it("restores implicit one-case selection for a form-host without a list", () => {
	const current = makeContract();
	current.moduleCompositions[0].role = "form-host";
	current.moduleCompositions[0].listIds = [];
	current.lists = [];
	current.access = [];
	current.navigation[0].listIds = [];
	const admitted = appDesignContractSchema.parse(current);
	roundTrip(legacy(admitted), admitted);
});
it("refuses missing legacy workflows and unknown current vocabulary", () => {
	const current = makeContract();
	expect(() =>
		normalizeStoredAppDesignContract(legacy(current, did(9999))),
	).toThrow();
	expect(() =>
		normalizeStoredAppDesignContract({ ...current, unexpected: true }),
	).toThrow();
	for (const invalid of [null, [], "contract", 12])
		expect(() => normalizeStoredAppDesignContract(invalid)).toThrow();
});
it("does not synthesize a missing stable lookup table identity", () => {
	const current = makeContract();
	const stored = {
		...current,
		records: current.records.map((record) => ({
			...record,
			properties: record.properties.map((property) => {
				if (property.id !== ids.factRisk) return property;
				const { choiceValues: _choiceValues, ...rest } = property;
				return {
					...rest,
					choiceSource: {
						kind: "existing-project-lookup",
						valueColumnId: "018f0000-0000-7000-8000-000000000102",
						labelColumnId: "018f0000-0000-7000-8000-000000000103",
					},
				};
			}),
		})),
	};
	expect(() => normalizeStoredAppDesignContract(stored)).toThrow();
});
