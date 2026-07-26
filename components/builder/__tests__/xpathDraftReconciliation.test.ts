import { describe, expect, it } from "vitest";
import { reconcileXPathDraft } from "@/components/builder/xpathDraftReconciliation";

describe("reconcileXPathDraft", () => {
	it("projects a peer rename through an unsaved local addition", () => {
		const base = "#user/region = 'north'";
		const draft = "#user/region = 'north' and #form/active = 'yes'";
		const incoming = "#user/district = 'north'";

		expect(reconcileXPathDraft({ base, draft, incoming })).toEqual({
			base: incoming,
			draft: "#user/district = 'north' and #form/active = 'yes'",
			conflict: false,
		});
	});

	it("adopts a peer projection immediately when the editor is clean", () => {
		const base = "#user/region = 'north'";
		const incoming = "#user/district = 'north'";

		expect(reconcileXPathDraft({ base, draft: base, incoming })).toEqual({
			base: incoming,
			draft: incoming,
			conflict: false,
		});
	});

	it("preserves the local draft and reports a conflict when both edits replace the same text", () => {
		const base = "#user/region = 'north'";
		const draft = "#user/local_region = 'north'";
		const incoming = "#user/district = 'north'";

		expect(reconcileXPathDraft({ base, draft, incoming })).toEqual({
			base: incoming,
			draft,
			conflict: true,
		});
	});
});
