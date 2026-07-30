import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { blueprintDocSchema } from "../blueprint";
import { proseText } from "../prose";

const MODULE = testUuid("topology-module");
const MODULE_2 = testUuid("topology-module-2");
const FORM = testUuid("topology-form");
const FORM_2 = testUuid("topology-form-2");
const FIELD = testUuid("topology-field");
const GROUP = testUuid("topology-group");
const GROUP_2 = testUuid("topology-group-2");
const UNKNOWN = testUuid("topology-unknown");
const PROPERTY = testUuid("topology-property");

function emptyDoc() {
	return {
		appId: "topology-app",
		appName: "Topology",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
	};
}

function module(uuid = MODULE) {
	return { uuid, id: "module", name: "Module" };
}

function form(uuid = FORM) {
	return {
		uuid,
		id: "form",
		name: "Form",
		type: "survey" as const,
	};
}

function textField(uuid = FIELD) {
	return {
		uuid,
		id: "answer",
		kind: "text" as const,
		label: proseText("Answer"),
	};
}

function groupField(uuid = GROUP) {
	return {
		uuid,
		id: "group",
		kind: "group" as const,
		label: proseText("Group"),
	};
}

function oneFormDoc() {
	return {
		...emptyDoc(),
		modules: { [MODULE]: module() },
		forms: { [FORM]: form() },
		moduleOrder: [MODULE],
		formOrder: { [MODULE]: [FORM] },
		fieldOrder: { [FORM]: [] },
	};
}

function messages(input: unknown): string[] {
	const result = blueprintDocSchema.safeParse(input);
	expect(result.success).toBe(false);
	return result.success
		? []
		: result.error.issues.map((issue) => issue.message);
}

describe("closed blueprint topology", () => {
	it("accepts the exact empty and runnable shapes", () => {
		expect(blueprintDocSchema.safeParse(emptyDoc()).success).toBe(true);
		expect(blueprintDocSchema.safeParse(oneFormDoc()).success).toBe(true);
	});

	it("requires strict UUID record keys", () => {
		const doc = {
			...emptyDoc(),
			modules: { "not-a-uuid": module() },
		};
		expect(messages(doc)).toContain("Expected a canonical lowercase RFC UUID.");
	});

	it("requires every record key to equal its embedded UUID", () => {
		const doc = {
			...emptyDoc(),
			modules: { [MODULE_2]: module() },
			moduleOrder: [MODULE_2],
			formOrder: { [MODULE_2]: [] },
		};
		expect(messages(doc)).toContain(
			`modules record key ${MODULE_2} must equal embedded uuid ${MODULE}.`,
		);
	});

	it("rejects authored UUID collisions across entity records", () => {
		const doc = {
			...oneFormDoc(),
			forms: { [MODULE]: form(MODULE) },
			formOrder: { [MODULE]: [MODULE] },
			fieldOrder: { [MODULE]: [] },
		};
		expect(messages(doc)).toContain(
			`Authored uuid ${MODULE} appears in both modules and forms.`,
		);
	});

	it.each([
		{
			name: "duplicate module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [MODULE, MODULE];
			},
			message: `moduleOrder contains duplicate member ${MODULE}.`,
		},
		{
			name: "unknown module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [MODULE, UNKNOWN];
			},
			message: `moduleOrder member ${UNKNOWN} does not exist in modules.`,
		},
		{
			name: "missing module membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.moduleOrder = [];
			},
			message: `modules member ${MODULE} is absent from moduleOrder.`,
		},
		{
			name: "stray form-order parent",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				Object.assign(doc.formOrder, { [UNKNOWN]: [] });
			},
			message: `formOrder key ${UNKNOWN} is not a module.`,
		},
		{
			name: "missing form-order parent",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.formOrder = {};
			},
			message: `Module ${MODULE} has no formOrder membership array.`,
		},
		{
			name: "unknown form membership",
			edit: (doc: ReturnType<typeof oneFormDoc>) => {
				doc.formOrder = { [MODULE]: [FORM, UNKNOWN] };
			},
			message: `formOrder member ${UNKNOWN} does not exist in forms.`,
		},
	])("rejects $name", ({ edit, message }) => {
		const doc = oneFormDoc();
		edit(doc);
		expect(messages(doc)).toContain(message);
	});

	it("requires each form under exactly one module", () => {
		const doc = {
			...oneFormDoc(),
			modules: {
				[MODULE]: module(),
				[MODULE_2]: module(MODULE_2),
			},
			moduleOrder: [MODULE, MODULE_2],
			formOrder: {
				[MODULE]: [FORM],
				[MODULE_2]: [FORM],
			},
		};
		expect(messages(doc)).toContain(
			`Form ${FORM} appears under both ${MODULE} and ${MODULE_2}.`,
		);
	});

	it("requires every form to have a field-order root", () => {
		const doc = oneFormDoc();
		doc.fieldOrder = {};
		expect(messages(doc)).toContain(
			`Field parent ${FORM} has no fieldOrder membership array.`,
		);
	});

	it("rejects field-order keys for non-container fields", () => {
		const doc = {
			...oneFormDoc(),
			fields: { [FIELD]: textField() },
			fieldOrder: { [FORM]: [FIELD], [FIELD]: [] },
		};
		expect(messages(doc)).toContain(
			`fieldOrder key ${FIELD} is neither a form nor a container field.`,
		);
	});

	it("requires each field under exactly one form or container", () => {
		const doc = {
			...oneFormDoc(),
			forms: {
				[FORM]: form(),
				[FORM_2]: form(FORM_2),
			},
			formOrder: { [MODULE]: [FORM, FORM_2] },
			fields: { [FIELD]: textField() },
			fieldOrder: {
				[FORM]: [FIELD],
				[FORM_2]: [FIELD],
			},
		};
		expect(messages(doc)).toContain(
			`Field ${FIELD} appears under both ${FORM} and ${FORM_2}.`,
		);
	});

	it("rejects container membership cycles", () => {
		const doc = {
			...oneFormDoc(),
			fields: {
				[GROUP]: groupField(),
				[GROUP_2]: groupField(GROUP_2),
			},
			fieldOrder: {
				[FORM]: [],
				[GROUP]: [GROUP_2],
				[GROUP_2]: [GROUP],
			},
		};
		expect(messages(doc)).toContain(`Field membership cycle reaches ${GROUP}.`);
	});

	it("closes optional flat records and sequences together", () => {
		const doc = {
			...emptyDoc(),
			userProperties: {
				[PROPERTY]: {
					uuid: PROPERTY,
					slug: "region",
					label: "Region",
				},
			},
		};
		expect(messages(doc)).toContain(
			`userProperties member ${PROPERTY} is absent from userPropertyOrder.`,
		);
	});
});
