/**
 * Carrier-shape coverage for the multimedia slots added to field /
 * option / module / form / blueprint schemas. Confirms:
 *
 *   - Docs without any media slots still parse (additive change).
 *   - Each new optional slot round-trips when populated.
 *   - The kind-discriminator narrowing still picks the right per-
 *     kind shape after the extension.
 */

import { describe, expect, it } from "vitest";
import {
	blueprintDocSchema,
	fieldSchema,
	formSchema,
	moduleSchema,
	selectOptionSchema,
} from "@/lib/domain";
import { opaqueXPathExpression } from "../xpath";

const NEUTRAL_MEDIA = {
	image: "00000000-0000-4000-8000-000000000001",
	audio: "00000000-0000-4000-8000-000000000002",
};

describe("field schema — media slots", () => {
	it("text field parses with label_media + hint_media", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "patient_name",
			label: "Patient name",
			label_media: { image: "00000000-0000-4000-8000-000000000001" },
			hint_media: { audio: "00000000-0000-4000-8000-000000000002" },
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toEqual({
				image: "00000000-0000-4000-8000-000000000001",
			});
			expect(parsed.hint_media).toEqual({
				audio: "00000000-0000-4000-8000-000000000002",
			});
		}
	});

	it("text field parses with the new help text + media slot", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "patient_name",
			label: "Patient name",
			help: "Enter the legal name shown on their ID document.",
			help_media: { image: "00000000-0000-4000-8000-000000000001" },
			required: opaqueXPathExpression("true()"),
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.help).toBe(
				"Enter the legal name shown on their ID document.",
			);
			expect(parsed.help_media?.image).toBe(
				"00000000-0000-4000-8000-000000000001",
			);
		}
	});

	it("text field still parses without ANY media slots (additive change)", () => {
		const parsed = fieldSchema.parse({
			kind: "text",
			uuid: "10000000-0000-4000-8000-000000000001",
			id: "name",
			label: "Name",
		});
		expect(parsed.kind).toBe("text");
		if (parsed.kind === "text") {
			expect(parsed.label_media).toBeUndefined();
			expect(parsed.hint_media).toBeUndefined();
			expect(parsed.help).toBeUndefined();
			expect(parsed.help_media).toBeUndefined();
		}
	});

	it("group container parses with optional label_media", () => {
		const parsed = fieldSchema.parse({
			kind: "group",
			uuid: "10000000-0000-4000-8000-000000000004",
			id: "screening",
			label: "Screening section",
			label_media: { image: "00000000-0000-4000-8000-000000000001" },
		});
		expect(parsed.kind).toBe("group");
	});

	it("validate_msg_media parses alongside existing validate_msg", () => {
		const parsed = fieldSchema.parse({
			kind: "int",
			uuid: "10000000-0000-4000-8000-000000000005",
			id: "age",
			label: "Age",
			validate: opaqueXPathExpression(". >= 0 and . <= 120"),
			validate_msg: "Enter a realistic age (0–120).",
			validate_msg_media: { audio: "00000000-0000-4000-8000-000000000009" },
		});
		expect(parsed.kind).toBe("int");
		if (parsed.kind === "int") {
			expect(parsed.validate_msg_media?.audio).toBe(
				"00000000-0000-4000-8000-000000000009",
			);
		}
	});
});

describe("selectOption schema — media slot", () => {
	it("round-trips an option with attached image+audio", () => {
		const parsed = selectOptionSchema.parse({
			uuid: "90000000-0000-4000-8000-000000000001",
			value: "fever",
			label: "Fever",
			media: NEUTRAL_MEDIA,
		});
		expect(parsed.media).toEqual(NEUTRAL_MEDIA);
	});

	it("rejects unknown extra keys (strict)", () => {
		expect(() =>
			selectOptionSchema.parse({
				uuid: "90000000-0000-4000-8000-000000000002",
				value: "fever",
				label: "Fever",
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

	it("module still parses without icon/audioLabel (additive)", () => {
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

	it("blueprint still parses without a logo (additive)", () => {
		const parsed = blueprintDocSchema.parse({
			appId: "app-1",
			appName: "Test app",
			connectType: null,
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
