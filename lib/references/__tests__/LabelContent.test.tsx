// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { ProseTemplate } from "@/lib/domain";
import { textWithChips } from "../LabelContent";
import { ReferenceProvider } from "../provider";

const FORM = testUuid("label-form");
const FIELD = testUuid("label-field");

const label: ProseTemplate = {
	parts: [
		{ kind: "text", text: "Hello " },
		{ kind: "field-ref", uuid: FIELD },
	],
};

describe("LabelContent reference projection", () => {
	it("renders a resolved reference through its current friendly path", () => {
		const provider = new ReferenceProvider(() => ({
			formUuid: FORM,
			validPaths: new Set(["/data/first_name"]),
			reachableCaseTypes: undefined,
			formEntries: [
				{
					uuid: FIELD,
					path: "first_name",
					label: "First name",
					kind: "text",
				},
			],
			formType: "registration",
		}));

		const html = renderToStaticMarkup(textWithChips(label, provider, FORM));
		expect(html).toContain('data-ref-raw="#form/first_name"');
		const container = document.createElement("div");
		container.innerHTML = html;
		expect(container.textContent).toBe("Hello first_name");
		expect(html).not.toContain(FIELD);
	});

	it("renders an explicit repair chip without leaking a dangling UUID", () => {
		const provider = new ReferenceProvider(() => ({
			formUuid: FORM,
			validPaths: new Set(),
			reachableCaseTypes: undefined,
			formEntries: [],
			formType: "registration",
		}));

		const html = renderToStaticMarkup(textWithChips(label, provider, FORM));
		expect(html).toContain('data-reference-repair="field-ref"');
		const container = document.createElement("div");
		container.innerHTML = html;
		expect(container.textContent).toBe("Hello Reference needs repair");
		expect(
			container.querySelector("[role=img]")?.getAttribute("aria-label"),
		).toBe("Form field reference needs repair");
		expect(html).not.toContain(FIELD);
	});
});
