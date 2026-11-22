import { expect, it } from "vitest";
import {
	localSearchDefaults,
	type PreviewSearchValues,
} from "../searchSettings";
import {
	applyPreviewSearchChanges,
	describePreviewSearchChanges,
	previewSearchChangesSchema,
} from "../searchSettingsEdit";
import {
	createPreviewSearchFrameReader,
	previewSearchFrames,
} from "../searchSettingsFrames";

it("preserves ordered, repeated and distant rules when transmitting only the changed rows", () => {
	const literal = (literal: string) => ({
		caseType: "person",
		property: "code",
		literal,
	});
	const original = Array.from({ length: 4100 }, (_, i) =>
		literal(String(i).padStart(256, "x")),
	);
	original[21] = original[1];
	const base: PreviewSearchValues = {
		...localSearchDefaults,
		propertyMatchers: { fuzzyProperties: [], ignoredText: original },
	};
	expect(new TextEncoder().encode(JSON.stringify(base)).length).toBeGreaterThan(
		1024 * 1024,
	);
	const next = { ...base, timeZone: "Asia/Kolkata" };
	expect(describePreviewSearchChanges(base, next)).toEqual({
		timeZone: "Asia/Kolkata",
	});
	const rows = [
		original[1],
		...original.slice(0, 20),
		literal("<edited>"),
		...original.slice(23, -2),
		literal("last"),
	];
	const desired = {
		...next,
		propertyMatchers: { fuzzyProperties: [], ignoredText: rows },
	};
	const changes = describePreviewSearchChanges(base, desired);
	expect(JSON.stringify(changes).length).toBeLessThan(3000);
	expect(
		applyPreviewSearchChanges(base, previewSearchChangesSchema.parse(changes)),
	).toEqual({ values: desired });
	expect(
		applyPreviewSearchChanges(base, {
			propertyMatchers: {
				ignoredText: [{ start: 5000, remove: 1, insert: [] }],
			},
		}),
	).toMatchObject({ error: expect.stringContaining("position") });
	expect(
		previewSearchChangesSchema.safeParse({
			propertyMatchers: {
				ignoredText: [{ start: 0, remove: 0, insert: original }],
			},
		}).success,
	).toBe(false);
});

it("publishes a large streamed catalog only when complete in the same Project", () => {
	const row = {
		caseType: "person",
		property: "badge",
		literal: "🌏".repeat(110),
	};
	const catalog = {
		projectId: "p",
		profiles: [
			{
				target: { kind: "local" as const },
				revision: "1",
				values: {
					...localSearchDefaults,
					propertyMatchers: {
						fuzzyProperties: [],
						ignoredText: Array.from({ length: 160 }, () => row),
					},
				},
			},
		],
	};
	const frames = [...previewSearchFrames(catalog)];
	const read = createPreviewSearchFrameReader();
	const accept = (f: (typeof frames)[number], project = "p") =>
		read(JSON.stringify(f), project);
	expect(frames.length).toBeGreaterThan(4);
	for (const frame of frames.slice(0, -1)) {
		expect(JSON.stringify(frame).length).toBeLessThan(80_000);
		expect(accept(frame)).toBeUndefined();
	}
	expect(accept(frames[frames.length - 1])).toEqual(catalog);
	expect(accept(frames[0])).toBeUndefined();
	expect(accept(frames[1], "other")).toBeNull();
	expect(accept(frames[frames.length - 1])).toBeNull();
});
