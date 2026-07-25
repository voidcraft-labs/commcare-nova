/**
 * The media bucket's lifecycle policy is applied as ONE replacement, so
 * every rule it needs must travel in that single call.
 *
 * `applyMediaBucketLifecycle` passes `{ append: false }`, which replaces
 * the bucket's whole lifecycle. A second rule applied by a second call
 * would silently delete the first — and nothing would notice, because a
 * missing reaper has no symptom until someone audits storage months
 * later. These tests are the tripwire: they assert every prefix that
 * needs a TTL is present in the one call, so adding a rule elsewhere (or
 * dropping one from here) fails loudly instead of quietly stranding
 * objects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";
import { PENDING_OBJECT_PREFIX } from "@/lib/domain/multimedia";

type LifecycleRule = {
	action: { type: string };
	condition: { age?: number; matchesPrefix?: string[] };
};

const addLifecycleRule =
	vi.fn<
		(
			rules: LifecycleRule | LifecycleRule[],
			options?: { append?: boolean },
		) => Promise<void>
	>();

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return { addLifecycleRule };
		}
	},
}));

async function applyAndCapture(): Promise<{
	rules: LifecycleRule[];
	append: boolean | undefined;
}> {
	const { applyMediaBucketLifecycle } = await import("../media");
	await applyMediaBucketLifecycle();
	const call = addLifecycleRule.mock.calls.at(-1);
	if (!call) throw new Error("addLifecycleRule was never called");
	const [rules, options] = call;
	return {
		rules: Array.isArray(rules) ? rules : [rules],
		append: options?.append,
	};
}

describe("media bucket lifecycle", () => {
	beforeEach(() => {
		vi.resetModules();
		addLifecycleRule.mockReset();
		addLifecycleRule.mockResolvedValue(undefined);
		process.env.NOVA_MEDIA_BUCKET = "test-bucket";
	});

	it("replaces the whole policy rather than appending", () => {
		// If this ever flips to append, the duplicate-rule accumulation it
		// avoids becomes the new problem — so the mode is pinned either way.
		return applyAndCapture().then(({ append }) => {
			expect(append).toBe(false);
		});
	});

	it("carries BOTH reapers in the single replacing call", async () => {
		const { rules } = await applyAndCapture();
		const prefixes = rules.flatMap((r) => r.condition.matchesPrefix ?? []);
		expect(prefixes).toContain(PENDING_OBJECT_PREFIX);
		expect(prefixes).toContain(STAGED_CAPTURE_PREFIX);
	});

	it("makes every rule a Delete with a positive age", async () => {
		const { rules } = await applyAndCapture();
		expect(rules.length).toBeGreaterThanOrEqual(2);
		for (const rule of rules) {
			expect(rule.action.type).toBe("Delete");
			// GCS `age` is day-granular; 0 would be rejected, and an absent age
			// would delete every matching object immediately.
			expect(rule.condition.age).toBeGreaterThan(0);
		}
	});

	it("scopes every rule to a prefix, never the whole bucket", async () => {
		// An unprefixed Delete rule would reap submitted captures and every
		// published asset. There is no legitimate whole-bucket TTL here.
		const { rules } = await applyAndCapture();
		for (const rule of rules) {
			expect(rule.condition.matchesPrefix?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("never reaps a prefix that holds durable objects", async () => {
		// Submitted captures land under `projects/`, alongside published
		// library assets. A rule matching that prefix would delete both.
		const { rules } = await applyAndCapture();
		const prefixes = rules.flatMap((r) => r.condition.matchesPrefix ?? []);
		for (const prefix of prefixes) {
			expect(prefix.startsWith("projects/")).toBe(false);
		}
	});

	it("keeps the staging prefix disjoint from the durable capture prefix", async () => {
		// The promotion at submit is what protects a kept capture, and it
		// only works if the durable key cannot match the staging prefix.
		const { captureObjectKeyFor } = await import("@/lib/domain/captureFormats");
		const durable = captureObjectKeyFor("proj", "att", ".jpg");
		expect(durable.startsWith(STAGED_CAPTURE_PREFIX)).toBe(false);
		expect(durable.startsWith(PENDING_OBJECT_PREFIX)).toBe(false);
	});
});
