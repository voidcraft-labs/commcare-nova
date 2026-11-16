// A Search check that reads data the worker's device lacks stops the Search
// screen, which shows the refusal in place of its fields. It stands only
// while what it was judged against is unchanged: an edit, new lookup data or
// another worker can give the device what it lacked, and then the fields come
// back for the next Search to judge.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { eq, literal } from "@/lib/domain/expression";
import { WORKER_INFORMATION_REFUSAL } from "../dataRefusal";
import { previewAsMe, previewSessionValues } from "../identity";
import {
	type HeldCheckRefusal,
	heldCheckRefusal,
	type SearchCheckWorld,
} from "../searchCheckRefusal";
import { webAppsDevice } from "./fixtures/previewDevices";

const doc = buildDoc({ appName: "Search checks", modules: [] });

function world(): SearchCheckWorld {
	return {
		scopeKey: "module-1",
		searchInputs: [],
		filter: undefined,
		environment: { doc, moduleUuid: testUuid("search-checks-module") },
		session: previewSessionValues(
			previewAsMe({ id: "worker-1", name: "Amina Diallo" }),
			webAppsDevice(),
		),
	};
}

describe("heldCheckRefusal", () => {
	it("stands while the world it was judged against is unchanged", () => {
		const judged = world();
		const held: HeldCheckRefusal = {
			world: judged,
			reason: WORKER_INFORMATION_REFUSAL,
		};
		expect(heldCheckRefusal(held, { ...judged })).toBe(
			WORKER_INFORMATION_REFUSAL,
		);
		expect(heldCheckRefusal(undefined, judged)).toBeUndefined();
	});

	it("no longer stands once any part of that world changes", () => {
		const judged = world();
		const held: HeldCheckRefusal = {
			world: judged,
			reason: WORKER_INFORMATION_REFUSAL,
		};
		const changes: Partial<SearchCheckWorld>[] = [
			{ scopeKey: "module-2" },
			{ searchInputs: [] },
			{ filter: eq(literal("a"), literal("a")) },
			{ environment: { ...judged.environment } },
			{
				session: previewSessionValues(
					previewAsMe({ id: "worker-2", name: "Kofi Mensah" }),
					webAppsDevice(),
				),
			},
		];
		for (const change of changes)
			expect(heldCheckRefusal(held, { ...judged, ...change })).toBeUndefined();
	});
});
