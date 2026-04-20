/**
 * FormEngine tests — domain-shaped fixtures only.
 *
 * The engine consumes a `FormEngineInput` (form + fields map + fieldOrder) —
 * the same domain shape produced by the normalized doc store. These tests
 * build fixtures directly in that shape via the `dTree` helper so no legacy
 * `Question`/`BlueprintForm` wire types appear.
 */
import { describe, expect, it } from "vitest";
import type {
	CaseType,
	Field,
	FieldKind,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { FormEngine, type FormEngineInput } from "../formEngine";

/** Convenience type for building field subtrees in test fixtures. The engine
 *  itself works on flat maps — this nested shape is purely for readability at
 *  the call site and is flattened by `dTree()` before construction. */
interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	hint?: string;
	required?: string;
	relevant?: string;
	calculate?: string;
	default_value?: string;
	validate?: string;
	validate_msg?: string;
	case_property?: string;
	options?: Array<{ value: string; label: string }>;
	children?: DField[];
}

/**
 * Build a `FormEngineInput` from a nested test-fixture tree.
 *
 * Walks the nested `DField` tree and emits (1) a Form entity, (2) a flat
 * `fields` map keyed by uuid, and (3) a `fieldOrder` adjacency map. UUIDs
 * are deterministic — derived from the field's position path — so assertion
 * failures are reproducible and nothing in a test depends on
 * `crypto.randomUUID`.
 */
function dTree(
	fields: DField[],
	formType: FormType = "registration",
): FormEngineInput {
	const formUuid = asUuid("test-form-uuid");
	const form: Form = {
		uuid: formUuid,
		id: "test-form",
		name: "Test Form",
		type: formType,
	};
	const fieldMap: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};

	// Walk depth-first; the uuid is a stable deterministic path like
	// "form.groupId.childId" so each fixture position always maps to the
	// same uuid, keeping test IDs reproducible.
	function walk(nodes: DField[], parentUuid: Uuid, pathPrefix: string) {
		const order: Uuid[] = [];
		for (const n of nodes) {
			const uuid = asUuid(`${pathPrefix}.${n.id}`);
			order.push(uuid);
			const { children, ...rest } = n;
			fieldMap[uuid as string] = {
				uuid,
				...rest,
			} as Field;
			// Containers get an entry in fieldOrder even when empty — the engine's
			// tree builder treats the presence of an entry as the signal to recurse.
			if (n.kind === "group" || n.kind === "repeat") {
				walk(children ?? [], uuid, `${pathPrefix}.${n.id}`);
			}
		}
		fieldOrder[parentUuid as string] = order;
	}

	walk(fields, formUuid, "form");
	return { form, formUuid, fields: fieldMap, fieldOrder };
}

const sampleCaseTypes: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Full Name" },
			{ name: "age", label: "Age", data_type: "int" },
			{
				name: "risk_level",
				label: "Risk Level",
				data_type: "single_select",
				options: [
					{ value: "low", label: "Low" },
					{ value: "high", label: "High" },
				],
			},
		],
	},
];

describe("FormEngine", () => {
	it("initializes with field states", () => {
		const input = dTree([
			{ id: "name", kind: "text", label: "Name" },
			{ id: "age", kind: "int", label: "Age" },
		]);
		const engine = new FormEngine(input, null);

		expect(engine.getState("/data/name").visible).toBe(true);
		expect(engine.getState("/data/name").value).toBe("");
		expect(engine.getState("/data/age").visible).toBe(true);
	});

	it("sets and gets values", () => {
		const input = dTree([{ id: "name", kind: "text", label: "Name" }]);
		const engine = new FormEngine(input, null);

		engine.setValue("/data/name", "Alice");
		expect(engine.getState("/data/name").value).toBe("Alice");
	});

	describe("relevant (visibility)", () => {
		it("hides questions when relevant evaluates to false", () => {
			const input = dTree([
				{
					id: "has_children",
					kind: "single_select",
					label: "Has children?",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
				{
					id: "num_children",
					kind: "int",
					label: "How many?",
					relevant: '/data/has_children = "yes"',
				},
			]);
			const engine = new FormEngine(input, null);

			// Initially visible (relevant evaluates with empty value → false for comparison)
			expect(engine.getState("/data/num_children").visible).toBe(false);

			engine.setValue("/data/has_children", "yes");
			expect(engine.getState("/data/num_children").visible).toBe(true);

			engine.setValue("/data/has_children", "no");
			expect(engine.getState("/data/num_children").visible).toBe(false);
		});
	});

	describe("calculate", () => {
		it("computes calculated values", () => {
			const input = dTree([
				{ id: "weight", kind: "decimal", label: "Weight (kg)" },
				{ id: "height", kind: "decimal", label: "Height (m)" },
				{
					id: "bmi",
					kind: "hidden",
					calculate: "/data/weight div (/data/height * /data/height)",
				},
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/weight", "70");
			engine.setValue("/data/height", "1.75");

			const bmi = parseFloat(engine.getState("/data/bmi").value);
			expect(bmi).toBeCloseTo(22.86, 1);
		});
	});

	describe("validation", () => {
		it("validates on value change", () => {
			const input = dTree([
				{
					id: "age",
					kind: "int",
					label: "Age",
					validate: ". > 0 and . < 150",
					validate_msg: "Must be 1-149",
				},
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/age").valid).toBe(true);

			engine.setValue("/data/age", "-1");
			expect(engine.getState("/data/age").valid).toBe(false);
			expect(engine.getState("/data/age").errorMessage).toBe("Must be 1-149");
		});
	});

	describe("required", () => {
		it("marks statically required questions", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
				{ id: "notes", kind: "text", label: "Notes" },
			]);
			const engine = new FormEngine(input, null);

			expect(engine.getState("/data/name").required).toBe(true);
			expect(engine.getState("/data/notes").required).toBe(false);
		});
	});

	describe("followup form preloading", () => {
		it("pre-populates case data into the instance", () => {
			const input = dTree(
				[
					{ id: "case_name", kind: "text", case_property: "patient" },
					{ id: "age", kind: "int", case_property: "patient" },
				],
				"followup",
			);

			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(
				input,
				sampleCaseTypes,
				"patient",
				caseData,
			);

			expect(engine.getState("/data/case_name").value).toBe("Alice");
			expect(engine.getState("/data/age").value).toBe("30");
		});
	});

	describe("default_value", () => {
		it("applies default values on init", () => {
			const input = dTree([
				{
					id: "visit_date",
					kind: "date",
					label: "Visit Date",
					default_value: "today()",
				},
			]);
			const engine = new FormEngine(input, null);

			expect(engine.getState("/data/visit_date").value).toMatch(
				/^\d{4}-\d{2}-\d{2}$/,
			);
		});

		it("overrides preloaded case data with default_value on followup forms", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: "Name",
						case_property: "patient",
						default_value: "concat(#case/age, ' - ', #case/case_name)",
					},
				],
				"followup",
			);
			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(
				input,
				sampleCaseTypes,
				"patient",
				caseData,
			);

			// default_value should win over case preload
			expect(engine.getState("/data/case_name").value).toBe("30 - Alice");
		});

		it("overrides preloaded case data after reset()", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: "Name",
						case_property: "patient",
						default_value: "concat(#case/age, ' - ', #case/case_name)",
					},
				],
				"followup",
			);
			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(
				input,
				sampleCaseTypes,
				"patient",
				caseData,
			);

			engine.setValue("/data/case_name", "user typed this");
			engine.reset();
			expect(engine.getState("/data/case_name").value).toBe("30 - Alice");
		});
	});

	describe("restoreValues", () => {
		it("restores only user-touched values, preserving new defaults", () => {
			// Simulate engine recreation: old engine had a default, user touched a different field
			const input = dTree([
				{
					id: "greeting",
					kind: "text",
					label: "Greeting",
					default_value: "'hello'",
				},
				{ id: "name", kind: "text", label: "Name" },
			]);
			const engine = new FormEngine(input, null);
			expect(engine.getState("/data/greeting").value).toBe("hello");

			// User types in the name field (touched), doesn't touch greeting
			engine.setValue("/data/name", "Alice");
			engine.touch("/data/name");
			const snapshot = engine.getValueSnapshot();

			// Simulate engine recreation with updated default
			const updatedInput = dTree([
				{
					id: "greeting",
					kind: "text",
					label: "Greeting",
					default_value: "'goodbye'",
				},
				{ id: "name", kind: "text", label: "Name" },
			]);
			const newEngine = new FormEngine(updatedInput, null);
			expect(newEngine.getState("/data/greeting").value).toBe("goodbye");

			// Restore snapshot — only touched values restored, new default kept
			newEngine.restoreValues(snapshot);
			expect(newEngine.getState("/data/name").value).toBe("Alice");
			expect(newEngine.getState("/data/greeting").value).toBe("goodbye");
		});

		it("does not overwrite new defaults with stale untouched values", () => {
			const input = dTree([
				{
					id: "status",
					kind: "text",
					label: "Status",
					default_value: "'active'",
				},
			]);
			const engine = new FormEngine(input, null);
			expect(engine.getState("/data/status").value).toBe("active");

			// Snapshot includes the default-computed value but field was never touched
			const snapshot = engine.getValueSnapshot();
			expect(snapshot.values.get("/data/status")).toBe("active");
			expect(snapshot.touched.has("/data/status")).toBe(false);

			// New engine with different default
			const updatedInput = dTree([
				{
					id: "status",
					kind: "text",
					label: "Status",
					default_value: "'archived'",
				},
			]);
			const newEngine = new FormEngine(updatedInput, null);
			newEngine.restoreValues(snapshot);

			// New default should win — stale 'active' should not overwrite 'archived'
			expect(newEngine.getState("/data/status").value).toBe("archived");
		});
	});

	describe("groups", () => {
		it("handles nested group questions", () => {
			const input = dTree([
				{
					id: "demographics",
					kind: "group",
					label: "Demographics",
					children: [
						{ id: "name", kind: "text", label: "Name" },
						{ id: "age", kind: "int", label: "Age" },
					],
				},
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/demographics/name", "Bob");
			expect(engine.getState("/data/demographics/name").value).toBe("Bob");
		});
	});

	describe("touch (blur validation)", () => {
		it("marks field as touched — required validation deferred to submit", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
			]);
			const engine = new FormEngine(input, null);

			// Not touched yet — valid despite being empty
			expect(engine.getState("/data/name").touched).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(true);

			// Touch marks as touched but does NOT run required validation (deferred to submit)
			engine.touch("/data/name");
			expect(engine.getState("/data/name").touched).toBe(true);
			expect(engine.getState("/data/name").valid).toBe(true);

			// Submit triggers required validation
			expect(engine.validateAll()).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(false);
			expect(engine.getState("/data/name").errorMessage).toBe(
				"This field is required",
			);

			// Filling the value clears the error
			engine.setValue("/data/name", "Alice");
			expect(engine.validateAll()).toBe(true);
			expect(engine.getState("/data/name").valid).toBe(true);
		});

		it("runs validation on touch when field has a value", () => {
			const input = dTree([
				{
					id: "age",
					kind: "int",
					label: "Age",
					validate: ". > 0",
					validate_msg: "Must be positive",
				},
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/age", "-5");
			// setValue runs validation, so it's already invalid
			expect(engine.getState("/data/age").valid).toBe(false);

			// But touch also runs it
			engine.touch("/data/age");
			expect(engine.getState("/data/age").touched).toBe(true);
			expect(engine.getState("/data/age").valid).toBe(false);
			expect(engine.getState("/data/age").errorMessage).toBe(
				"Must be positive",
			);
		});
	});

	describe("validateAll (submit validation)", () => {
		it("marks all visible required empty fields as invalid", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
				{ id: "email", kind: "text", label: "Email", required: "true()" },
				{ id: "notes", kind: "text", label: "Notes" },
			]);
			const engine = new FormEngine(input, null);

			const valid = engine.validateAll();
			expect(valid).toBe(false);
			expect(engine.getState("/data/name").valid).toBe(false);
			expect(engine.getState("/data/name").touched).toBe(true);
			expect(engine.getState("/data/email").valid).toBe(false);
			expect(engine.getState("/data/notes").valid).toBe(true);
		});

		it("returns true when all required fields are filled", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/name", "Alice");
			expect(engine.validateAll()).toBe(true);
		});

		it("skips hidden (not visible) fields", () => {
			const input = dTree([
				{
					id: "toggle",
					kind: "single_select",
					label: "Show?",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
				{
					id: "conditional",
					kind: "text",
					label: "Details",
					required: "true()",
					relevant: '/data/toggle = "yes"',
				},
			]);
			const engine = new FormEngine(input, null);

			// conditional is not visible (toggle is empty) so it should not cause validation failure
			engine.setValue("/data/toggle", "no");
			expect(engine.validateAll()).toBe(true);
		});
	});

	describe("Zustand store reactivity", () => {
		it("updates store state on value change", () => {
			const input = dTree([{ id: "name", kind: "text", label: "Name" }]);
			const engine = new FormEngine(input, null);

			let called = false;
			engine.store.subscribe(() => {
				called = true;
			});

			engine.setValue("/data/name", "Test");
			expect(called).toBe(true);
			expect(engine.store.getState()["/data/name"]?.value).toBe("Test");
		});

		it("allows unsubscribing from store", () => {
			const input = dTree([{ id: "name", kind: "text", label: "Name" }]);
			const engine = new FormEngine(input, null);

			let callCount = 0;
			const unsub = engine.store.subscribe(() => {
				callCount++;
			});

			engine.setValue("/data/name", "A");
			expect(callCount).toBe(1);

			unsub();
			engine.setValue("/data/name", "B");
			expect(callCount).toBe(1);
		});

		it("only creates new state objects for changed paths", () => {
			const input = dTree([
				{ id: "age", kind: "text", label: "Age" },
				{ id: "name", kind: "text", label: "Name" },
			]);
			const engine = new FormEngine(input, null);

			/* Capture state references before the change */
			const nameBefore = engine.store.getState()["/data/name"];
			const ageBefore = engine.store.getState()["/data/age"];

			engine.setValue("/data/age", "25");

			/* The changed path gets a new object */
			const ageAfter = engine.store.getState()["/data/age"];
			expect(ageAfter).not.toBe(ageBefore);
			expect(ageAfter?.value).toBe("25");

			/* The unchanged path keeps the same reference — Zustand selectors
			 * using Object.is would correctly skip re-rendering this path. */
			const nameAfter = engine.store.getState()["/data/name"];
			expect(nameAfter).toBe(nameBefore);
		});
	});

	describe("hashtag refs in labels", () => {
		it("resolves hashtag refs in labels with #case refs", () => {
			const input = dTree(
				[
					{
						id: "case_name",
						kind: "text",
						label: "Name",
						case_property: "patient",
					},
					{
						id: "greeting",
						kind: "label",
						label: "Hello, #case/case_name!",
					},
				],
				"followup",
			);
			const caseData = new Map([["case_name", "John Smith"]]);
			const engine = new FormEngine(
				input,
				sampleCaseTypes,
				"patient",
				caseData,
			);

			expect(engine.getState("/data/greeting").resolvedLabel).toBe(
				"Hello, John Smith!",
			);
		});

		it("resolves hashtag refs referencing form fields", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name" },
				{ id: "summary", kind: "label", label: "You entered: #form/name" },
			]);
			const engine = new FormEngine(input, null);

			// Initially empty
			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"You entered: ",
			);

			// After setting a value, the label updates reactively
			engine.setValue("/data/name", "Alice");
			expect(engine.getState("/data/summary").resolvedLabel).toBe(
				"You entered: Alice",
			);
		});

		it("resolves multiple hashtag refs in one label", () => {
			const input = dTree([
				{ id: "first", kind: "text", label: "First" },
				{ id: "last", kind: "text", label: "Last" },
				{ id: "display", kind: "label", label: "#form/first #form/last" },
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/first", "Jane");
			engine.setValue("/data/last", "Doe");
			expect(engine.getState("/data/display").resolvedLabel).toBe("Jane Doe");
		});

		it("resolves hashtag refs in hints", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name" },
				{ id: "age", kind: "int", label: "Age", hint: "Age for #form/name" },
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/name", "Bob");
			expect(engine.getState("/data/age").resolvedHint).toBe("Age for Bob");
		});

		it("cascades through calculated fields into hashtag refs", () => {
			const input = dTree([
				{ id: "age", kind: "int", label: "Age" },
				{
					id: "status",
					kind: "hidden",
					calculate: "if(/data/age > 18, 'Adult', 'Minor')",
				},
				{ id: "info", kind: "label", label: "Status: #form/status" },
			]);
			const engine = new FormEngine(input, null);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Adult");

			engine.setValue("/data/age", "10");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Minor");
		});

		it("does not set resolvedLabel when no hashtag refs present", () => {
			const input = dTree([{ id: "name", kind: "text", label: "Plain label" }]);
			const engine = new FormEngine(input, null);

			expect(engine.getState("/data/name").resolvedLabel).toBeUndefined();
		});
	});
});
