/**
 * Client-safe runtime contract for `event: lookup-revision` frames.
 *
 * The app stream carries the authoritative full Project lookup manifest, not a
 * delta. Keep the parser beside the browser transport so an invalid frame can
 * be skipped before it reaches future S02/S09 consumers without importing any
 * server persistence code into the client bundle.
 */

import { z } from "zod";
import {
	LOOKUP_MAX_COLUMNS,
	LOOKUP_MAX_ROWS,
	LOOKUP_MAX_TABLE_BYTES,
} from "@/lib/lookup/constants";
import {
	compareLookupRevisions,
	lookupIdSchema,
	lookupRevisionSchema,
	lookupTableNameSchema,
	lookupTagSchema,
} from "@/lib/lookup/schema";
import type { LookupManifest } from "@/lib/lookup/types";

const exactLookupTableNameSchema = z.string().refine((value) => {
	const parsed = lookupTableNameSchema.safeParse(value);
	return parsed.success && parsed.data === value;
}, "Expected a canonical lookup table name.");

const lookupTableManifestEntrySchema = z
	.object({
		id: lookupIdSchema,
		name: exactLookupTableNameSchema,
		tag: lookupTagSchema,
		columnCount: z.number().int().min(1).max(LOOKUP_MAX_COLUMNS),
		rowCount: z.number().int().min(0).max(LOOKUP_MAX_ROWS),
		dataBytes: z.number().int().min(0).max(LOOKUP_MAX_TABLE_BYTES),
		definitionRevision: lookupRevisionSchema,
		rowsRevision: lookupRevisionSchema,
		tableRevision: lookupRevisionSchema,
	})
	.strict()
	.superRefine((table, ctx) => {
		const expectedTableRevision =
			compareLookupRevisions(table.definitionRevision, table.rowsRevision) >= 0
				? table.definitionRevision
				: table.rowsRevision;
		if (table.tableRevision !== expectedTableRevision) {
			ctx.addIssue({
				code: "custom",
				path: ["tableRevision"],
				message:
					"Table revision must equal the latest definition or rows revision.",
			});
		}
	});

export const lookupManifestFrameSchema: z.ZodType<LookupManifest> = z
	.object({
		projectId: z.string().min(1),
		projectRevision: lookupRevisionSchema,
		tables: z.array(lookupTableManifestEntrySchema),
	})
	.strict()
	.superRefine((manifest, ctx) => {
		const ids = new Set<string>();
		const tags = new Set<string>();
		for (const [index, table] of manifest.tables.entries()) {
			if (ids.has(table.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["tables", index, "id"],
					message: "Lookup table ids must be unique within a manifest.",
				});
			}
			ids.add(table.id);
			if (tags.has(table.tag)) {
				ctx.addIssue({
					code: "custom",
					path: ["tables", index, "tag"],
					message: "Lookup table tags must be unique within a manifest.",
				});
			}
			tags.add(table.tag);
			if (
				compareLookupRevisions(table.tableRevision, manifest.projectRevision) >
				0
			) {
				ctx.addIssue({
					code: "custom",
					path: ["tables", index, "tableRevision"],
					message: "Table revision cannot be ahead of the Project revision.",
				});
			}
		}
	});

/** Parse one SSE data payload. Malformed transport input is best-effort and
 * intentionally returns `null` rather than disturbing blueprint collaboration. */
export function parseLookupManifestFrame(data: string): LookupManifest | null {
	try {
		const parsed = lookupManifestFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export interface LookupManifestBroker {
	/** Validate, retain, and fan out one full-manifest SSE payload. */
	dispatch: (data: string) => void;
	/** Clear the retained tenant snapshot. Current subscribers receive `null`; a
	 * later valid frame may latch a different Project and revision lineage. */
	reset: () => void;
	/** Subscribe to future snapshots and immediately replay the latest manifest,
	 * if any. `null` means an authorization/reload boundary cleared the snapshot. */
	subscribe: (
		subscriber: (manifest: LookupManifest | null) => void,
	) => () => void;
}

/**
 * Runtime-local lookup snapshot broker. The retained manifest is transport
 * state, not blueprint reconciler state: it never participates in `baseSeq`,
 * reload folding, or mutation reconciliation.
 */
export function createLookupManifestBroker(): LookupManifestBroker {
	const subscribers = new Set<(manifest: LookupManifest | null) => void>();
	let latest: LookupManifest | null = null;

	function callSubscriber(
		subscriber: (manifest: LookupManifest | null) => void,
		manifest: LookupManifest | null,
	): void {
		try {
			subscriber(manifest);
		} catch {
			// Subscriber faults are isolated so one surface cannot starve another.
		}
	}

	return {
		dispatch(data) {
			const manifest = parseLookupManifestFrame(data);
			if (manifest === null) return;
			if (latest !== null) {
				/* One provider runtime belongs to one app Project. A superseded
				 * EventSource callback or misrouted frame cannot silently re-tenant it;
				 * future admitted cross-Project moves must explicitly reset/remount the
				 * runtime. Likewise, level-triggered snapshots only move forward. */
				if (manifest.projectId !== latest.projectId) return;
				if (
					compareLookupRevisions(
						manifest.projectRevision,
						latest.projectRevision,
					) < 0
				)
					return;
			}
			latest = manifest;
			// Snapshot iteration keeps subscription mutations inside a callback from
			// changing which consumers receive this already-started dispatch.
			for (const subscriber of [...subscribers]) {
				callSubscriber(subscriber, manifest);
			}
		},
		reset() {
			if (latest === null) return;
			latest = null;
			for (const subscriber of [...subscribers]) {
				callSubscriber(subscriber, null);
			}
		},
		subscribe(subscriber) {
			subscribers.add(subscriber);
			if (latest !== null) callSubscriber(subscriber, latest);
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				subscribers.delete(subscriber);
			};
		},
	};
}
