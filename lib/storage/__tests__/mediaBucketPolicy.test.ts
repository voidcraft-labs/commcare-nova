/**
 * The media bucket's temporary-object retention contract is one
 * metageneration-fenced metadata policy.
 *
 * Lifecycle Delete alone is not a hard byte-retention boundary: soft delete,
 * versioning, default holds, and bucket retention can all keep bytes alive.
 * These tests pin the whole policy and its post-write verification so a deploy
 * fails rather than silently extending a capture's advertised TTL.
 */

import type { BucketMetadata, LifecycleRule } from "@google-cloud/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";
import { PENDING_OBJECT_PREFIX } from "@/lib/domain/multimedia";

const getMetadata = vi.fn<() => Promise<[BucketMetadata]>>();
const setMetadata =
	vi.fn<
		(
			metadata: BucketMetadata,
			options?: { ifMetagenerationMatch?: string | number },
		) => Promise<void>
	>();
const setCorsConfiguration =
	vi.fn<
		(
			rules: Array<{
				origin: string[];
				method: string[];
				responseHeader: string[];
				maxAgeSeconds: number;
			}>,
		) => Promise<void>
	>();
const storageOptions = vi.fn();

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		constructor(options: unknown) {
			storageOptions(options);
		}

		bucket() {
			return { getMetadata, setMetadata, setCorsConfiguration };
		}
	},
}));

const expectedRules: LifecycleRule[] = [
	{
		action: { type: "Delete" },
		condition: {
			age: 1,
			matchesPrefix: [PENDING_OBJECT_PREFIX],
		},
	},
	{
		action: { type: "Delete" },
		condition: {
			age: 7,
			matchesPrefix: [STAGED_CAPTURE_PREFIX],
		},
	},
];

function beforeMetadata(
	overrides: Partial<BucketMetadata> = {},
): BucketMetadata {
	return {
		metageneration: "41",
		...overrides,
	};
}

function afterMetadata(
	overrides: Partial<BucketMetadata> = {},
): BucketMetadata {
	return {
		metageneration: "42",
		lifecycle: { rule: expectedRules },
		softDeletePolicy: { retentionDurationSeconds: 0 },
		versioning: { enabled: false },
		defaultEventBasedHold: false,
		...overrides,
	};
}

async function applyPolicy(args?: {
	before?: BucketMetadata;
	after?: BucketMetadata;
}): Promise<void> {
	getMetadata
		.mockResolvedValueOnce([args?.before ?? beforeMetadata()])
		.mockResolvedValueOnce([args?.after ?? afterMetadata()]);
	const { applyMediaBucketStoragePolicy } = await import("../media");
	await applyMediaBucketStoragePolicy();
}

describe("media bucket policy", () => {
	beforeEach(() => {
		vi.resetModules();
		getMetadata.mockReset();
		setMetadata.mockReset();
		setMetadata.mockResolvedValue(undefined);
		setCorsConfiguration.mockReset();
		setCorsConfiguration.mockResolvedValue(undefined);
		storageOptions.mockReset();
		process.env.NOVA_MEDIA_BUCKET = "test-bucket";
	});

	it("bounds each storage request and the complete retry loop", async () => {
		await applyPolicy();
		expect(storageOptions).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 30_000,
				retryOptions: expect.objectContaining({
					maxRetries: 3,
					totalTimeout: 30,
				}),
			}),
		);
	});

	it("converges the exact policy in one metageneration-fenced patch", async () => {
		await applyPolicy();
		expect(getMetadata).toHaveBeenCalledTimes(2);
		expect(setMetadata).toHaveBeenCalledWith(
			{
				lifecycle: { rule: expectedRules },
				softDeletePolicy: { retentionDurationSeconds: 0 },
				versioning: { enabled: false },
				defaultEventBasedHold: false,
			},
			{ ifMetagenerationMatch: "41" },
		);
	});

	it("carries both prefix-scoped positive-age Delete reapers", async () => {
		await applyPolicy();
		const policy = setMetadata.mock.calls[0]?.[0];
		const rules = policy?.lifecycle?.rule ?? [];
		expect(rules).toHaveLength(2);
		const prefixes = rules.flatMap(
			(rule) => rule.condition.matchesPrefix ?? [],
		);
		expect(prefixes).toEqual(
			expect.arrayContaining([PENDING_OBJECT_PREFIX, STAGED_CAPTURE_PREFIX]),
		);
		for (const rule of rules) {
			expect(rule.action.type).toBe("Delete");
			expect(rule.condition.age).toBeGreaterThan(0);
			expect(rule.condition.matchesPrefix).toHaveLength(1);
			expect(rule.condition.matchesPrefix?.[0]?.startsWith("projects/")).toBe(
				false,
			);
		}
	});

	it.each([
		["unlocked", false],
		["locked", true],
	] as const)(
		"refuses to remove an existing %s bucket retention policy",
		async (_label, isLocked) => {
			getMetadata.mockResolvedValueOnce([
				beforeMetadata({
					retentionPolicy: {
						retentionPeriod: 86_400,
						isLocked,
					},
				}),
			]);
			const { applyMediaBucketStoragePolicy } = await import("../media");
			await expect(applyMediaBucketStoragePolicy()).rejects.toThrow(
				/operator protection/i,
			);
			expect(setMetadata).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the read has no metageneration", async () => {
		getMetadata.mockResolvedValueOnce([
			beforeMetadata({ metageneration: undefined }),
		]);
		const { applyMediaBucketStoragePolicy } = await import("../media");
		await expect(applyMediaBucketStoragePolicy()).rejects.toThrow(
			/metageneration/i,
		);
		expect(setMetadata).not.toHaveBeenCalled();
	});

	it("propagates a concurrent-policy precondition failure without verifying stale state", async () => {
		getMetadata.mockResolvedValueOnce([beforeMetadata()]);
		setMetadata.mockRejectedValueOnce(
			Object.assign(new Error("conditionNotMet"), { code: 412 }),
		);
		const { applyMediaBucketStoragePolicy } = await import("../media");
		await expect(applyMediaBucketStoragePolicy()).rejects.toMatchObject({
			code: 412,
		});
		expect(getMetadata).toHaveBeenCalledTimes(1);
	});

	it.each([
		["absent", undefined],
		["numeric zero", { retentionDurationSeconds: 0 }],
		["string zero", { retentionDurationSeconds: "0" }],
	] as const)("accepts soft delete reported as %s", async (_label, policy) => {
		await expect(
			applyPolicy({
				after: afterMetadata({ softDeletePolicy: policy }),
			}),
		).resolves.toBeUndefined();
	});

	it.each([
		{
			name: "an extra lifecycle rule",
			after: afterMetadata({
				lifecycle: {
					rule: [
						...expectedRules,
						{
							action: { type: "Delete" },
							condition: { age: 30, matchesPrefix: ["unexpected/"] },
						},
					],
				},
			}),
			message: /lifecycle rule set is not exact/i,
		},
		{
			name: "soft delete enabled",
			after: afterMetadata({
				softDeletePolicy: { retentionDurationSeconds: 604_800 },
			}),
			message: /soft delete is not disabled/i,
		},
		{
			name: "versioning enabled",
			after: afterMetadata({ versioning: { enabled: true } }),
			message: /object versioning is enabled/i,
		},
		{
			name: "default holds enabled",
			after: afterMetadata({ defaultEventBasedHold: true }),
			message: /default event-based hold is enabled/i,
		},
		{
			name: "a retention policy appearing after the patch",
			after: afterMetadata({
				retentionPolicy: { retentionPeriod: 86_400, isLocked: false },
			}),
			message: /bucket retention policy is present/i,
		},
	])("fails post-write verification for $name", async ({ after, message }) => {
		await expect(applyPolicy({ after })).rejects.toThrow(message);
	});

	it("keeps the staging prefix disjoint from the durable capture prefix", async () => {
		const { captureObjectKeyFor } = await import("@/lib/domain/captureFormats");
		const durable = captureObjectKeyFor("proj", "att", ".jpg");
		expect(durable.startsWith(STAGED_CAPTURE_PREFIX)).toBe(false);
		expect(durable.startsWith(PENDING_OBJECT_PREFIX)).toBe(false);
	});

	it("allows both signed capture PUT headers through bucket CORS", async () => {
		const { applyMediaBucketCors } = await import("../media");
		await applyMediaBucketCors(["https://commcare.app"]);
		expect(setCorsConfiguration).toHaveBeenCalledWith([
			expect.objectContaining({
				origin: ["https://commcare.app"],
				method: ["PUT", "OPTIONS"],
				responseHeader: expect.arrayContaining([
					"Content-Type",
					"x-goog-content-length-range",
					"x-goog-if-generation-match",
				]),
			}),
		]);
	});
});
