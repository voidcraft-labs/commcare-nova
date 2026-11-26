/**
 * A stack `<create>` evaluates every datum it pushes in the linking form's
 * session (commcare-core `CommCareSession.performPushInner` hands each step
 * the same evaluation context), so a destination's automatic choice that
 * reads an earlier choice of its own frame would read the linking form's
 * session, which holds none. HQ's build carries the earlier datum's value in
 * its place (`workflow.py::_replace_session_references_in_stack`), and so
 * does Nova's projection of the link.
 */
import { describe, expect, it } from "vitest";
import {
	formLinkProjectionContext,
	projectAfterSubmit,
} from "@/lib/commcare/formLinkProjection";
import { identityLookupWireNaming } from "@/lib/commcare/lookup/naming";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import { independentChoicesBlueprint } from "@/proof/targeted/documents/independentFormChoices";

describe("a link into a form whose automatic choice reads an earlier one", () => {
	it("carries the earlier choice's value, never a session read the linking form lacks", () => {
		const doc = independentChoicesBlueprint("paired-visits");
		const source = Object.values(doc.forms).find(
			(form) => form.name === "Open the assigned pair",
		);
		if (!source) throw new Error("Missing the linking form");
		const projected = projectAfterSubmit(
			doc,
			formLinkProjectionContext(doc, {
				lookupNaming: identityLookupWireNaming(),
			}),
			source.uuid,
		);
		const children = projected?.links[0]?.children ?? [];
		const value = (id: string) => {
			const child = children.find(
				(one) => one.type === "datum" && one.id === id,
			);
			if (child?.type !== "datum") throw new Error(`No datum ${id}`);
			return serializeWire(child.value, { target: "suite" }).text;
		};
		const worker = value("case_id_worker");
		expect(worker).toContain("hq_user_id");
		// The raw choice reads the worker record's id, which this frame pushes
		// first: it takes that value, as HQ's build writes it.
		expect(value("case_id_raw")).toBe(worker);
		expect(value("case_id_raw")).not.toContain("session/data/case_id_worker");
	});
});
