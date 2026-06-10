// lib/commcare/validator/__tests__/referenceSlotUnions.test.ts
//
// Asserts the validator's per-surface unions (`XPathSurface` /
// `ProseSurface` / `ConnectXPathSlot`) equal the reference-slot
// registry's projections. This file lives on the commcare side of the
// boundary because it must import both sides; the registry itself
// (`lib/domain/referenceSlots.ts`) cannot.
//
// Two failure channels, by design:
//
//   - Registry grows a slot the validator doesn't walk → the runtime
//     comparison against the registry-derived list fails (vitest).
//   - Validator union grows a surface the registry doesn't classify →
//     the `Record<Surface, SlotId>` mapping below is missing a key,
//     which is a compile error (`npm run typecheck` / the build).
//
// The mappings are identity by construction — the registry's slot ids
// were chosen to speak the validator's vocabulary — and the runtime
// loop pins that, so a rename on either side surfaces immediately.

import { describe, expect, it } from "vitest";
import {
	type ConnectXPathSlotId,
	FIELD_REFERENCE_SLOTS,
	type FieldProseSlotId,
	type FieldXPathSlotId,
	FORM_REFERENCE_SLOTS,
} from "@/lib/domain";
import type { ConnectXPathSlot, ProseSurface, XPathSurface } from "../index";

const XPATH_SURFACE_BY_SLOT: Record<FieldXPathSlotId, XPathSurface> = {
	relevant: "relevant",
	calculate: "calculate",
	default_value: "default_value",
	validate: "validate",
	required: "required",
	repeat_count: "repeat_count",
	ids_query: "ids_query",
};
const SLOT_BY_XPATH_SURFACE: Record<XPathSurface, FieldXPathSlotId> = {
	relevant: "relevant",
	calculate: "calculate",
	default_value: "default_value",
	validate: "validate",
	required: "required",
	repeat_count: "repeat_count",
	ids_query: "ids_query",
};

const PROSE_SURFACE_BY_SLOT: Record<FieldProseSlotId, ProseSurface> = {
	label: "label",
	hint: "hint",
	help: "help",
	validate_msg: "validate_msg",
	option_label: "option_label",
};
const SLOT_BY_PROSE_SURFACE: Record<ProseSurface, FieldProseSlotId> = {
	label: "label",
	hint: "hint",
	help: "help",
	validate_msg: "validate_msg",
	option_label: "option_label",
};

const CONNECT_SLOT_BY_REGISTRY_SLOT: Record<
	ConnectXPathSlotId,
	ConnectXPathSlot
> = {
	assessment_user_score: "assessment_user_score",
	deliver_entity_id: "deliver_entity_id",
	deliver_entity_name: "deliver_entity_name",
};
const REGISTRY_SLOT_BY_CONNECT_SLOT: Record<
	ConnectXPathSlot,
	ConnectXPathSlotId
> = {
	assessment_user_score: "assessment_user_score",
	deliver_entity_id: "deliver_entity_id",
	deliver_entity_name: "deliver_entity_name",
};

function expectIdentityOverRegistry(
	mapping: Record<string, string>,
	registrySlots: string[],
): void {
	expect(Object.keys(mapping).sort()).toEqual([...registrySlots].sort());
	for (const [slot, surface] of Object.entries(mapping)) {
		expect(surface).toBe(slot);
	}
}

describe("validator surface unions ≡ registry projections", () => {
	it("XPathSurface ≡ the field slots of kind `xpath`", () => {
		const registrySlots = FIELD_REFERENCE_SLOTS.filter(
			(s) => s.kind === "xpath",
		).map((s) => s.slot);
		expectIdentityOverRegistry(XPATH_SURFACE_BY_SLOT, registrySlots);
		expectIdentityOverRegistry(SLOT_BY_XPATH_SURFACE, registrySlots);
	});

	it("ProseSurface ≡ the field slots of kind `prose`", () => {
		const registrySlots = FIELD_REFERENCE_SLOTS.filter(
			(s) => s.kind === "prose",
		).map((s) => s.slot);
		expectIdentityOverRegistry(PROSE_SURFACE_BY_SLOT, registrySlots);
		expectIdentityOverRegistry(SLOT_BY_PROSE_SURFACE, registrySlots);
	});

	it("ConnectXPathSlot ≡ the form slots under the connect block", () => {
		const registrySlots = FORM_REFERENCE_SLOTS.filter((s) =>
			s.path.startsWith("connect."),
		).map((s) => s.slot);
		expectIdentityOverRegistry(CONNECT_SLOT_BY_REGISTRY_SLOT, registrySlots);
		expectIdentityOverRegistry(REGISTRY_SLOT_BY_CONNECT_SLOT, registrySlots);
	});
});
