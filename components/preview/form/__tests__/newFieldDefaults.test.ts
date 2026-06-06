import { describe, expect, it } from "vitest";
import { asUuid, fieldKinds, fieldSchema } from "@/lib/domain";
import { NEW_FIELD_BUILDERS } from "../newFieldDefaults";

const UUID = asUuid("00000000-0000-4000-8000-000000000000");

describe("NEW_FIELD_BUILDERS — every kind's starter field is schema-valid", () => {
	// The mapped type guarantees each builder's STRUCTURE matches its kind, but
	// the Zod schema carries runtime constraints the type can't express
	// (`options.min(2)`, non-empty visible label). This is the guard that a
	// freshly-inserted field of ANY kind round-trips through `fieldSchema` — the
	// exact thing the auto-save validates, so the insertion can never mint an
	// unsaveable field again (the `hidden` + `label` regression).
	it.each(fieldKinds)("%s builds a valid field", (kind) => {
		const built = NEW_FIELD_BUILDERS[kind](`new_${kind}`, "New Field");
		const result = fieldSchema.safeParse({ ...built, uuid: UUID });
		expect(
			result.success,
			result.success ? "" : JSON.stringify(result.error.issues),
		).toBe(true);
	});

	it("never gives a hidden field a label (it has no label slot)", () => {
		const built = NEW_FIELD_BUILDERS.hidden("new_hidden", "ignored");
		expect("label" in built).toBe(false);
	});
});
