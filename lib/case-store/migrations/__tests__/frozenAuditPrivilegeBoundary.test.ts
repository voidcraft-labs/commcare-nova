import { describe, expect, test } from "vitest";
import { FROZEN_STORAGE_OCCURRENCES } from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	FROZEN_PROJECT_ORPHAN_APP_ID_TABLES,
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
} from "@/lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenRepairManifest";
import { AUDIT_SELECT_PUBLIC_TABLES } from "@/lib/db/privilegeConvergence";

describe("frozen canonical-identity audit privilege boundary", () => {
	test("equals the complete timestamp-owned scanner inventory", () => {
		const expected = new Set([
			...FROZEN_STORAGE_OCCURRENCES.map(
				(occurrence) => occurrence.table,
			).filter((table) => table !== "cases"),
			...FROZEN_PROJECT_ORPHAN_APP_ID_TABLES.flatMap((qualified) =>
				qualified.startsWith("public.") ? [qualified.slice(7)] : [],
			),
			...FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
			"lookup_project_state",
		]);
		expect([...AUDIT_SELECT_PUBLIC_TABLES].sort()).toEqual(
			[...expected].sort(),
		);
	});
});
