import { describe, expect, it } from "vitest";
import {
	classifyFrozenCanonicalRepairBoundary,
	removeFrozenThreadAttachmentTargets,
} from "../20260728000000_canonical_identity_foundation/frozenDatabaseRepair";
import { FROZEN_FOLD_FAMILY_OBJECT_KEYS } from "../20260728000000_canonical_identity_foundation/frozenRelationLifecycle";
import {
	FROZEN_THREAD_ATTACHMENT_REPAIR_MANIFEST_DIGEST,
	FROZEN_THREAD_ATTACHMENT_REPAIRS,
} from "../20260728000000_canonical_identity_foundation/frozenRepairManifest";
import { canonicalIdentityDigest } from "../20260728000000_canonical_identity_foundation/frozenTransform";

/**
 * A strict-shaped attachment for a manifest target.
 *
 * The manifest deliberately holds no attachment body — these were real customer
 * documents — so a fixture is synthesized from the identity it does keep. The
 * placeholder filename and mimeType only have to satisfy the strict shape gate;
 * nothing under test reads them.
 */
function attachmentFor(target: {
	readonly assetId: string;
	readonly attachmentKind: string;
}): Record<string, unknown> {
	return {
		assetId: target.assetId,
		kind: target.attachmentKind,
		filename: "fixture",
		mimeType: "application/octet-stream",
	};
}

describe("frozen canonical-identity repair terminal boundary", () => {
	it("keeps repair-before and its immediate no-write rerun in the pre-canonical stage", () => {
		expect(
			classifyFrozenCanonicalRepairBoundary({
				canonicalMigrationLedgerRows: "0",
				foldFamilyObjectKeys: [],
			}),
		).toBe("pre-canonical");
	});

	it("makes the exact canonical state terminal after the repair has applied", () => {
		expect(
			classifyFrozenCanonicalRepairBoundary({
				canonicalMigrationLedgerRows: "1",
				foldFamilyObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
			}),
		).toBe("canonical-applied-not-applicable");
	});

	it.each([
		{
			name: "direct unledgered canonical migration",
			ledger: "0",
			keys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
		},
		{
			name: "ledger-only canonical claim",
			ledger: "1",
			keys: [],
		},
		{
			name: "partial fold family",
			ledger: "1",
			keys: FROZEN_FOLD_FAMILY_OBJECT_KEYS.slice(0, -1),
		},
		{
			name: "duplicate fold object",
			ledger: "1",
			keys: [
				...FROZEN_FOLD_FAMILY_OBJECT_KEYS,
				FROZEN_FOLD_FAMILY_OBJECT_KEYS[0],
			],
		},
		{
			name: "duplicate migration ledger evidence",
			ledger: "2",
			keys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
		},
	])("keeps $name classified as drift", ({ ledger, keys }) => {
		expect(
			classifyFrozenCanonicalRepairBoundary({
				canonicalMigrationLedgerRows: ledger,
				foldFamilyObjectKeys: keys,
			}),
		).toBe("drift");
	});

	it("rejects a non-exact migration ledger count", () => {
		expect(() =>
			classifyFrozenCanonicalRepairBoundary({
				canonicalMigrationLedgerRows: "01",
				foldFamilyObjectKeys: [],
			}),
		).toThrow(/canonical migration ledger count is not an exact decimal count/);
	});
});

describe("frozen thread attachment repair manifest", () => {
	it("names exactly thirteen objects and removes only those strict paths", () => {
		expect(canonicalIdentityDigest(FROZEN_THREAD_ATTACHMENT_REPAIRS)).toBe(
			FROZEN_THREAD_ATTACHMENT_REPAIR_MANIFEST_DIGEST,
		);
		expect(FROZEN_THREAD_ATTACHMENT_REPAIRS).toHaveLength(7);
		expect(
			FROZEN_THREAD_ATTACHMENT_REPAIRS.reduce(
				(total, repair) => total + repair.targets.length,
				0,
			),
		).toBe(13);
		for (const repair of FROZEN_THREAD_ATTACHMENT_REPAIRS) {
			const messages = [
				{
					id: "preserved-message",
					role: "user",
					parts: [{ type: "text", text: "preserved" }],
					metadata: {
						attachments: repair.targets.map(attachmentFor),
					},
				},
			];
			expect(removeFrozenThreadAttachmentTargets(messages, repair)).toEqual([
				{
					id: "preserved-message",
					role: "user",
					parts: [{ type: "text", text: "preserved" }],
					metadata: { attachments: [] },
				},
			]);
			expect(messages[0]?.metadata.attachments).toHaveLength(
				repair.targets.length,
			);
		}
	});

	it("fails closed if one exact target object changes", () => {
		const repair = FROZEN_THREAD_ATTACHMENT_REPAIRS[0];
		expect(repair).toBeDefined();
		if (repair === undefined) return;
		const target = repair.targets[0];
		expect(target).toBeDefined();
		if (target === undefined) return;
		// The asset id is what the disposition check acts on, so retargeting it is
		// the change that must fail closed. Cosmetic fields are covered upstream by
		// the whole-column `sourceMessagesDigest` and again by the per-target SQL
		// digest, neither of which this pure function can see.
		const attachment = {
			...attachmentFor(target),
			assetId: "00000000-0000-4000-8000-000000000000",
		};
		expect(() =>
			removeFrozenThreadAttachmentTargets(
				[
					{
						metadata: { attachments: [attachment] },
					},
				],
				repair,
			),
		).toThrow(/changed/);
	});
});
