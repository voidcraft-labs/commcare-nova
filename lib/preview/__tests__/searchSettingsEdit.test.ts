import { expect, it, vi } from "vitest";
import {
	localSearchDefaults,
	type PreviewSearchValues,
	resolvePreviewSearchFacts,
} from "../searchSettings";
import {
	applyPreviewSearchChanges,
	describePreviewSearchChanges,
	previewSearchChangesSchema,
	rebasePreviewSearchValues,
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

it("refuses text that PostgreSQL cannot preserve before a rule edit", () => {
	for (const literal of ["a\0b", "\udcff"])
		expect(
			previewSearchChangesSchema.safeParse({
				propertyMatchers: {
					ignoredText: [
						{
							start: 0,
							remove: 0,
							insert: [{ caseType: "person", property: "badge", literal }],
						},
					],
				},
			}).success,
		).toBe(false);
});

it("keeps each setting a person changed over a teammate's newer revision and takes the rest", () => {
	const rule = (literal: string) => ({
		caseType: "person",
		property: "code",
		literal,
	});
	const base: PreviewSearchValues = {
		maximum: 500,
		timeZone: "UTC",
		caseListMap: false,
		propertyMatchers: {
			fuzzyProperties: [{ caseType: "person", property: "name", fuzzy: true }],
			ignoredText: [rule("a"), rule("b")],
		},
	};
	const mine: PreviewSearchValues = {
		...base,
		timeZone: "Asia/Kolkata",
		propertyMatchers: {
			fuzzyProperties: base.propertyMatchers?.fuzzyProperties ?? [],
			ignoredText: [rule("b"), rule("a"), rule("mine")],
		},
	};
	const latest: PreviewSearchValues = {
		maximum: 1500,
		timeZone: "Europe/Berlin",
		caseListMap: true,
		propertyMatchers: {
			fuzzyProperties: [],
			ignoredText: [rule("team")],
		},
	};
	const kept = rebasePreviewSearchValues(base, mine, latest);
	expect(kept).toEqual({
		maximum: 1500,
		timeZone: "Asia/Kolkata",
		caseListMap: true,
		propertyMatchers: {
			fuzzyProperties: [],
			ignoredText: [rule("b"), rule("a"), rule("mine")],
		},
	});
	// The save then sends only what differs from the team's revision.
	expect(describePreviewSearchChanges(latest, kept)).toEqual({
		timeZone: "Asia/Kolkata",
		propertyMatchers: {
			ignoredText: [
				{ start: 0, remove: 1, insert: [rule("b"), rule("a"), rule("mine")] },
			],
		},
	});
	// Clearing confirmed matching survives a teammate's rule edit; leaving
	// matching alone follows the team, including its own clearing.
	expect(
		rebasePreviewSearchValues(base, { ...base, propertyMatchers: null }, latest)
			.propertyMatchers,
	).toBeNull();
	expect(
		rebasePreviewSearchValues(base, base, {
			...latest,
			propertyMatchers: null,
		}),
	).toEqual({ ...latest, propertyMatchers: null });
});

it("reads a saved calendar this browser's time zone data lacks, and leaves only that calendar unconfirmed", () => {
	const zone = "America/Coyhaique";
	const catalog = {
		projectId: "p",
		profiles: [
			{
				target: { kind: "local" as const },
				revision: "2",
				values: {
					...localSearchDefaults,
					timeZone: zone,
					maximum: 1500 as const,
				},
			},
		],
	};
	// A browser with older ICU data refuses the zone a newer runtime saved.
	const RealFormat = Intl.DateTimeFormat;
	const olderData = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((
		locale?: string | string[],
		options?: Intl.DateTimeFormatOptions,
	) => {
		if (options?.timeZone === zone)
			throw new RangeError(`Invalid time zone specified: ${zone}`);
		return new RealFormat(locale, options);
	}) as typeof Intl.DateTimeFormat);
	try {
		const read = createPreviewSearchFrameReader();
		let received: ReturnType<typeof read>;
		for (const frame of previewSearchFrames(catalog))
			received = read(JSON.stringify(frame), "p");
		expect(received).toEqual(catalog);
		const facts = resolvePreviewSearchFacts(received ?? null, {
			kind: "local",
		});
		expect(facts.timeZone).toBeNull();
		expect(facts.maximum).toBe(1500);
		expect(facts.propertyMatchers).toEqual(
			localSearchDefaults.propertyMatchers,
		);
		// Saving that calendar from this browser is refused in Nova's words.
		const saving = previewSearchChangesSchema.safeParse({ timeZone: zone });
		expect(saving.error?.issues[0]?.message).toMatch(/^Nova can't use that/);
		// An edit to another setting keeps the saved calendar.
		expect(
			applyPreviewSearchChanges(catalog.profiles[0].values, { maximum: 500 }),
		).toEqual({ values: { ...catalog.profiles[0].values, maximum: 500 } });
	} finally {
		olderData.mockRestore();
	}
});
