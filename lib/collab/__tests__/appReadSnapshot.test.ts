import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	appReadSnapshotSchema,
	parseAppReadSnapshot,
} from "@/lib/collab/appReadSnapshot";
import { toPersistableDoc } from "@/lib/doc/fieldParent";

const SNAPSHOT = {
	projectId: "project-1",
	role: "editor",
	canEdit: true,
	blueprint: toPersistableDoc(
		buildDoc({
			modules: [
				{
					name: "Survey",
					forms: [
						{
							name: "Interview",
							type: "survey",
							fields: [{ kind: "text", id: "name" }],
						},
					],
				},
			],
		}),
	),
	baseSeq: 7,
};

describe("current app-read snapshot", () => {
	it("parses the exact five-key response", () => {
		expect(parseAppReadSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
		expect(
			Object.keys(appReadSnapshotSchema.parse(SNAPSHOT)).toSorted(),
		).toEqual(
			["projectId", "role", "canEdit", "blueprint", "baseSeq"].toSorted(),
		);
	});

	it.each(["app_name", "status", "error_type", "mutation_seq"])(
		"rejects the retired %s response key",
		(key) => {
			expect(() =>
				parseAppReadSnapshot({
					...SNAPSHOT,
					[key]: key === "mutation_seq" ? 7 : "old",
				}),
			).toThrow();
		},
	);

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
		"rejects invalid cursor %s",
		(baseSeq) => {
			expect(() => parseAppReadSnapshot({ ...SNAPSHOT, baseSeq })).toThrow();
		},
	);

	it("rejects an incomplete or malformed snapshot as a whole", () => {
		const { role: _role, ...withoutRole } = SNAPSHOT;
		expect(() => parseAppReadSnapshot(withoutRole)).toThrow();
		expect(() =>
			parseAppReadSnapshot({ ...SNAPSHOT, blueprint: {} }),
		).toThrow();
		expect(() =>
			parseAppReadSnapshot({ ...SNAPSHOT, canEdit: "true" }),
		).toThrow();
	});
});
