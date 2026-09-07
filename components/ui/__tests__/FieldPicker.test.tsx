import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { proseText } from "@/lib/domain";
import type { FieldEntrySource } from "@/lib/references/provider";
import { buildFieldEntries } from "../FieldPicker";

const FORM = testUuid("picker-form");
const TARGET = testUuid("picker-target");
const LABELED = testUuid("picker-labeled");
const WORKER_PROPERTY = testUuid("picker-worker-property");

function source({
	targetId,
	workerSlug,
	includeTargets = true,
}: {
	targetId: string;
	workerSlug: string;
	includeTargets?: boolean;
}): FieldEntrySource {
	return {
		forms: { [FORM]: {} },
		fields: {
			[TARGET]: {
				uuid: TARGET,
				id: targetId,
				kind: "text",
				label: proseText("Target"),
			},
			[LABELED]: {
				uuid: LABELED,
				id: "summary",
				kind: "text",
				label: {
					parts: [
						{ kind: "text", text: "Uses " },
						{ kind: "field-ref", uuid: TARGET },
						{ kind: "text", text: " and " },
						{
							kind: "user-property-ref",
							userPropertyUuid: WORKER_PROPERTY,
						},
					],
				},
			},
		},
		fieldOrder: {
			[FORM]: [TARGET, LABELED],
		},
		userProperties: includeTargets
			? {
					[WORKER_PROPERTY]: {
						slug: workerSlug,
					},
				}
			: {},
		...(includeTargets
			? {}
			: {
					fieldParent: {
						[TARGET]: null,
						[LABELED]: FORM,
					},
				}),
	};
}

describe("buildFieldEntries label projection", () => {
	it("projects valid referenced labels through the current owning document", () => {
		const before = buildFieldEntries(
			source({ targetId: "old_name", workerSlug: "district" }),
			FORM,
		).find((entry) => entry.uuid === LABELED);
		expect(before?.labelProjection.ok).toBe(true);
		expect(before?.label).toBe("Uses #form/old_name and #user/district");

		const after = buildFieldEntries(
			source({ targetId: "current_name", workerSlug: "supervision_area" }),
			FORM,
		).find((entry) => entry.uuid === LABELED);
		expect(after?.labelProjection.ok).toBe(true);
		expect(after?.label).toBe(
			"Uses #form/current_name and #user/supervision_area",
		);
	});

	it("keeps a dangling label structured and identity-free", () => {
		const projected = buildFieldEntries(
			source({
				targetId: "removed",
				workerSlug: "removed",
				includeTargets: false,
			}),
			FORM,
		).find((entry) => entry.uuid === LABELED);

		expect(projected?.labelProjection.ok).toBe(false);
		expect(projected?.label).toBe(
			"Uses #form/[reference needs repair] and #user/[reference needs repair]",
		);
		expect(projected?.label).not.toContain(TARGET);
		expect(projected?.label).not.toContain(WORKER_PROPERTY);
	});
});
