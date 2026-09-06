import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { parsePathToLocation } from "../location";
import { advanceLocationRecovery } from "../locationRecovery";
import type { PreviousLocationTopology } from "../topologyRecovery";

function fixture() {
	const doc = buildDoc({
		modules: [
			{ name: "Care", forms: [{ type: "survey", name: "Intake" }] },
			{
				name: "Visits",
				forms: [
					{
						type: "survey",
						name: "Visit",
						fields: [f({ kind: "text", id: "name" })],
					},
				],
			},
		],
	});
	const [parent, child] = doc.moduleOrder;
	const form = doc.formOrder[child][0];
	const field = doc.fieldOrder[form][0];
	doc.modules[child].parentModuleUuid = parent;
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	let previous: PreviousLocationTopology | undefined;
	return {
		store,
		parent,
		child,
		form,
		field,
		visit: (segments: string[]) => {
			const doc = store.getState();
			const result = advanceLocationRecovery(
				previous,
				segments,
				parsePathToLocation(segments, doc),
				doc,
			);
			previous = result.topology;
			return result;
		},
	};
}

describe("location recovery", () => {
	it("keeps canonical URLs and canonicalizes old nested selection or stale references once", () => {
		const h = fixture();
		expect(h.visit([h.field]).replacement).toBeUndefined();
		expect(h.visit([h.form, h.field]).replacement).toEqual({
			kind: "form",
			moduleUuid: h.child,
			formUuid: h.form,
			selectedUuid: h.field,
		});
		expect(h.visit([h.form, "missing-field"]).replacement).toEqual({
			kind: "form",
			moduleUuid: h.child,
			formUuid: h.form,
		});
		expect(h.visit([h.form]).replacement).toBeUndefined();
		expect(h.visit(["missing-entity"]).replacement).toEqual({ kind: "home" });
		expect(h.visit([]).replacement).toBeUndefined();
	});
	it.each(["cases", "search-config", "detail-config"])(
		"leaves retired %s bookmarks unresolved",
		(token) => {
			const h = fixture();
			const prior = h.visit([h.child]).topology;
			const result = h.visit([h.child, token]);
			expect(result).toEqual({ topology: prior });
		},
	);
	it("recovers an unchanged URL through real remote child and parent deletion", () => {
		const h = fixture();
		expect(h.visit([h.form]).replacement).toBeUndefined();
		h.store.getState().applyMany([{ kind: "removeModule", uuid: h.child }]);
		expect(h.visit([h.form]).replacement).toEqual({
			kind: "module",
			moduleUuid: h.parent,
		});
		expect(h.visit([h.parent]).replacement).toBeUndefined();
		h.store.getState().applyMany([{ kind: "removeModule", uuid: h.parent }]);
		expect(h.visit([h.parent]).replacement).toEqual({ kind: "home" });
		expect(h.visit([]).replacement).toBeUndefined();
	});
	it("does not carry former ancestry into an intentional navigation", () => {
		const h = fixture();
		h.visit([h.form]);
		h.store.getState().applyMany([{ kind: "removeModule", uuid: h.child }]);
		expect(h.visit(["missing-bookmark"]).replacement).toEqual({ kind: "home" });
	});
});
