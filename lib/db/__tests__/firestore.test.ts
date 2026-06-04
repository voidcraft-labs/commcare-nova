import { describe, expect, it } from "vitest";
import { sanitizeForFirestore } from "../firestore";

describe("sanitizeForFirestore", () => {
	it("normalizes Long-like values before Firestore serialization", () => {
		class MinifiedInteger {
			constructor(
				readonly low: number,
				readonly high: number,
				readonly unsigned = false,
			) {}

			toNumber() {
				return this.low;
			}

			toString() {
				return String(this.low);
			}
		}

		const out = sanitizeForFirestore({
			module_count: new MinifiedInteger(7, 0),
			nested: [{ form_count: new MinifiedInteger(1, 0) }],
		});

		expect(out).toEqual({
			module_count: 7,
			nested: [{ form_count: 1 }],
		});
	});

	it("preserves non-plain SDK objects such as sentinels", () => {
		class FirestoreSentinel {
			readonly _methodName = "serverTimestamp";
		}

		const sentinel = new FirestoreSentinel();
		const out = sanitizeForFirestore({ updated_at: sentinel });

		expect(out).toEqual({ updated_at: sentinel });
		expect((out as { updated_at: unknown }).updated_at).toBe(sentinel);
	});
});
