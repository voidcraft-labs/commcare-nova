/** Individual carrier schema admission, including shapes before contextual
 * document validation. Asset existence/kind and wire compatibility belong to
 * the media admission and native emission suites. */

import { describe, expect, it } from "vitest";
import {
	blueprintDocSchema,
	fieldSchema,
	formSchema,
	moduleSchema,
	selectOptionSchema,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { opaqueXPathExpression } from "../xpath";

const NEUTRAL_MEDIA = {
	image: "00000000-0000-4000-8000-000000000001",
	audio: "00000000-0000-4000-8000-000000000002",
};

describe("field schema — media slots", () => {
	it("text field parses with label_media", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "patient_name",
			label: proseText("Patient name"),
			label_media: { image: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toEqual({
				image: "00000000-0000-4000-8000-000000000001",
			});
		}
	});

	it("text field parses with help text and its media slot", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "patient_name",
			label: proseText("Patient name"),
			help: proseText("Enter the legal name shown on their ID document."),
			help_media: { image: "00000000-0000-4000-8000-000000000001" },
			required: opaqueXPathExpression("true()"),
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.help).toEqual(
				proseText("Enter the legal name shown on their ID document."),
			);
			expect(parsed.help_media?.image).toBe(
				"00000000-0000-4000-8000-000000000001",
			);
		}
	});

	it("text field still parses without authored media", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "name",
			label: proseText("Name"),
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toBeUndefined();
			expect(parsed.help).toBeUndefined();
			expect(parsed.help_media).toBeUndefined();
		}
	});

	it("refuses media on a hint, a validation message and a container's label on every kind that had it", () => {
		const text = {
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "name",
			label: proseText("Name"),
			hint: proseText("Full name"),
			validate: opaqueXPathExpression(". != ''"),
			validate_msg: proseText("Write a name."),
		};
		expect(fieldSchema.safeParse(text).success).toBe(true);
		const validatable = [
			"text",
			"int",
			"decimal",
			"date",
			"time",
			"datetime",
			"secret",
			"barcode",
		];
		for (const kind of validatable) {
			for (const slot of ["hint_media", "validate_msg_media"]) {
				expect(
					fieldSchema.safeParse({ ...text, kind, [slot]: NEUTRAL_MEDIA })
						.success,
					`${kind} ${slot}`,
				).toBe(false);
			}
		}
		const select = {
			...text,
			optionsSource: {
				kind: "inline",
				options: [
					{
						uuid: "90000000-0000-4000-8000-000000000001",
						value: "a",
						label: proseText("A"),
					},
					{
						uuid: "90000000-0000-4000-8000-000000000002",
						value: "b",
						label: proseText("B"),
					},
				],
			},
		};
		for (const kind of ["single_select", "multi_select"]) {
			expect(fieldSchema.safeParse({ ...select, kind }).success).toBe(true);
			for (const slot of ["hint_media", "validate_msg_media"]) {
				expect(
					fieldSchema.safeParse({ ...select, kind, [slot]: NEUTRAL_MEDIA })
						.success,
					`${kind} ${slot}`,
				).toBe(false);
			}
		}
		const group = {
			kind: "group",
			uuid: "10000000-0000-4000-8000-000000000004",
			id: "screening",
			label: proseText("Screening"),
		};
		const repeat = {
			...group,
			kind: "repeat",
			repeat_mode: "user_controlled",
		};
		for (const container of [group, repeat]) {
			expect(fieldSchema.safeParse(container).success).toBe(true);
			for (const slot of [
				"label_media",
				"hint_media",
				"help_media",
				"validate_msg_media",
				"required_msg_media",
			]) {
				expect(
					fieldSchema.safeParse({ ...container, [slot]: NEUTRAL_MEDIA })
						.success,
					`${container.kind} ${slot}`,
				).toBe(false);
			}
		}
	});
});

describe("selectOption schema — media slot", () => {
	it("round-trips an option with attached image+audio", () => {
		const parsed = selectOptionSchema.parse({
			uuid: "90000000-0000-4000-8000-000000000001",
			value: "fever",
			label: proseText("Fever"),
			media: NEUTRAL_MEDIA,
		});
		expect(parsed.media).toEqual(NEUTRAL_MEDIA);
	});

	it("rejects unknown extra keys (strict)", () => {
		expect(() =>
			selectOptionSchema.parse({
				uuid: "90000000-0000-4000-8000-000000000002",
				value: "fever",
				label: proseText("Fever"),
				icon: "00000000-0000-4000-8000-000000000001",
			}),
		).toThrow();
	});
});

describe("module schema — icon + audioLabel", () => {
	it("module parses with icon + audioLabel", () => {
		const parsed = moduleSchema.parse({
			uuid: "20000000-0000-4000-8000-000000000001",
			id: "patient_registration",
			name: "Patient registration",
			icon: "00000000-0000-4000-8000-000000000001",
			audioLabel: "00000000-0000-4000-8000-000000000002",
		});
		expect(parsed.icon).toBe("00000000-0000-4000-8000-000000000001");
		expect(parsed.audioLabel).toBe("00000000-0000-4000-8000-000000000002");
	});

	it("module still parses without menu media", () => {
		const parsed = moduleSchema.parse({
			uuid: "20000000-0000-4000-8000-000000000001",
			id: "patient_registration",
			name: "Patient registration",
		});
		expect(parsed.icon).toBeUndefined();
	});

	it("caseListConfig parses with icon + audioLabel", () => {
		const parsed = moduleSchema.parse({
			uuid: "20000000-0000-4000-8000-000000000001",
			id: "patient_registration",
			name: "Patient registration",
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [],
				icon: "00000000-0000-4000-8000-000000000003",
				audioLabel: "00000000-0000-4000-8000-000000000004",
			},
		});
		expect(parsed.caseListConfig?.icon).toBe(
			"00000000-0000-4000-8000-000000000003",
		);
		expect(parsed.caseListConfig?.audioLabel).toBe(
			"00000000-0000-4000-8000-000000000004",
		);
	});
});

describe("form schema — icon + audioLabel", () => {
	it("form parses with icon + audioLabel", () => {
		const parsed = formSchema.parse({
			uuid: "30000000-0000-4000-8000-000000000001",
			id: "intake",
			name: "Intake",
			type: "registration",
			icon: "00000000-0000-4000-8000-000000000001",
			audioLabel: "00000000-0000-4000-8000-000000000002",
		});
		expect(parsed.icon).toBe("00000000-0000-4000-8000-000000000001");
		expect(parsed.audioLabel).toBe("00000000-0000-4000-8000-000000000002");
	});
});

describe("blueprint schema — logo", () => {
	it("blueprint parses with the web-apps logo set", () => {
		const parsed = blueprintDocSchema.parse({
			appId: "app-1",
			appName: "Test app",
			connectType: null,
			appSettings: { showSavedForms: false, showIncompleteForms: false },
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			logo: "00000000-0000-4000-8000-000000000010",
		});
		expect(parsed.logo).toBe("00000000-0000-4000-8000-000000000010");
	});

	it("blueprint still parses without a logo", () => {
		const parsed = blueprintDocSchema.parse({
			appId: "app-1",
			appName: "Test app",
			connectType: null,
			appSettings: { showSavedForms: false, showIncompleteForms: false },
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
		});
		expect(parsed.logo).toBeUndefined();
	});
});
