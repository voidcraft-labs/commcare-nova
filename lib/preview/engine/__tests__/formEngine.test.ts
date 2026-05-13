/**
 * FormEngine tests — domain-shaped fixtures only.
 *
 * The engine consumes a `FormEngineInput` (form + fields map + fieldOrder) —
 * the same domain shape produced by the normalized doc store. These tests
 * build fixtures directly in that shape via the `dTree` helper.
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
	case_property_on?: string;
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

describe("FormEngine", () => {
	it("initializes with field states", () => {
		const input = dTree([
			{ id: "name", kind: "text", label: "Name" },
			{ id: "age", kind: "int", label: "Age" },
		]);
		const engine = new FormEngine(input);

		expect(engine.getState("/data/name").visible).toBe(true);
		expect(engine.getState("/data/name").value).toBe("");
		expect(engine.getState("/data/age").visible).toBe(true);
	});

	it("sets and gets values", () => {
		const input = dTree([{ id: "name", kind: "text", label: "Name" }]);
		const engine = new FormEngine(input);

		engine.setValue("/data/name", "Alice");
		expect(engine.getState("/data/name").value).toBe("Alice");
	});

	describe("relevant (visibility)", () => {
		it("hides fields when relevant evaluates to false", () => {
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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/age").valid).toBe(true);

			engine.setValue("/data/age", "-1");
			expect(engine.getState("/data/age").valid).toBe(false);
			expect(engine.getState("/data/age").errorMessage).toBe("Must be 1-149");
		});
	});

	describe("required", () => {
		it("marks statically required fields", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
				{ id: "notes", kind: "text", label: "Notes" },
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/name").required).toBe(true);
			expect(engine.getState("/data/notes").required).toBe(false);
		});
	});

	describe("followup form preloading", () => {
		it("pre-populates case data into the instance", () => {
			const input = dTree(
				[
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "age", kind: "int", case_property_on: "patient" },
				],
				"followup",
			);

			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

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
			const engine = new FormEngine(input);

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
						case_property_on: "patient",
						default_value: "concat(#case/age, ' - ', #case/case_name)",
					},
				],
				"followup",
			);
			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

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
						case_property_on: "patient",
						default_value: "concat(#case/age, ' - ', #case/case_name)",
					},
				],
				"followup",
			);
			const caseData = new Map([
				["case_name", "Alice"],
				["age", "30"],
			]);
			const engine = new FormEngine(input, "patient", caseData);

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
			const engine = new FormEngine(input);
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
			const newEngine = new FormEngine(updatedInput);
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
			const engine = new FormEngine(input);
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
			const newEngine = new FormEngine(updatedInput);
			newEngine.restoreValues(snapshot);

			// New default should win — stale 'active' should not overwrite 'archived'
			expect(newEngine.getState("/data/status").value).toBe("archived");
		});
	});

	describe("groups", () => {
		it("handles nested group fields", () => {
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
			const engine = new FormEngine(input);

			engine.setValue("/data/demographics/name", "Bob");
			expect(engine.getState("/data/demographics/name").value).toBe("Bob");
		});
	});

	describe("repeats", () => {
		// The engine must publish the live instance count on the repeat's own
		// `FieldState.repeatCount` — that's what makes the preview's Add/Remove
		// buttons reactive. A regression here puts us back to the silent-no-op
		// click that motivated this slot existing.
		it("seeds repeatCount=1 on the repeat's own state", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: "Household members",
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/members").repeatCount).toBe(1);
		});

		it("addRepeat bumps repeatCount and rewrites the FieldState reference", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: "Household members",
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			const before = engine.store.getState()["/data/members"];
			expect(before?.repeatCount).toBe(1);

			const newIndex = engine.addRepeat("/data/members");
			expect(newIndex).toBe(1);

			const after = engine.store.getState()["/data/members"];
			expect(after?.repeatCount).toBe(2);
			// New reference is the reactivity contract Zustand subscribers rely on.
			expect(after).not.toBe(before);
		});

		it("removeRepeat decrements repeatCount and rewrites the FieldState reference", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: "Household members",
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(3);

			const before = engine.store.getState()["/data/members"];
			engine.removeRepeat("/data/members", 1);
			const after = engine.store.getState()["/data/members"];

			expect(after?.repeatCount).toBe(2);
			expect(after).not.toBe(before);
		});

		// `removeRepeat` first writes DEFAULT_ENGINE_STATE for every path under
		// the deleted index, then renumbers higher indices down by writing the
		// shifted state into the same `updates` object. When index 0 is removed
		// from a [0,1] pair, both loops touch `[0]/...` paths — the renumber
		// loop's write must clobber the deletion loop's, otherwise the
		// surviving instance's value disappears. This test pins that ordering
		// invariant as a behavioral contract so a future cleanup can't quietly
		// reorder the loops without a regression.
		it("removeRepeat(0) renumbers higher instances down and preserves their values", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: "Household members",
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.setValue("/data/members[0]/name", "Alice");
			engine.setValue("/data/members[1]/name", "Bob");

			engine.removeRepeat("/data/members", 0);

			expect(engine.getState("/data/members").repeatCount).toBe(1);
			// Bob's value moves down into the [0] slot — renumber loop won.
			expect(engine.getState("/data/members[0]/name").value).toBe("Bob");
			// The vacated [1]/name slot is unplugged to the frozen default.
			expect(engine.getState("/data/members[1]/name").value).toBe("");
		});

		// `repeatCount` rides on the same `FieldState` object that visibility
		// and validation cascades rewrite — so any cascade that re-evaluates
		// the repeat's own path (e.g. its parent's `relevant` toggling) must
		// preserve the count. The engine accomplishes this by spreading
		// `...current` when it builds the new state; this test pins that
		// behaviour as a contract so a future cleanup can't quietly switch
		// to an explicit-keys reconstruction and silently lose the slot.
		it("preserves repeatCount through a relevance-driven cascade", () => {
			const input = dTree([
				{
					id: "show",
					kind: "single_select",
					label: "Show?",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
				{
					id: "members",
					kind: "repeat",
					label: "Members",
					relevant: '/data/show = "yes"',
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.setValue("/data/show", "yes");
			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(2);

			// Toggle the parent's relevance off and back on. Each transition
			// rewrites the repeat's `visible` flag, which forces a fresh
			// FieldState reference for the repeat's path.
			engine.setValue("/data/show", "no");
			engine.setValue("/data/show", "yes");

			expect(engine.getState("/data/members").repeatCount).toBe(2);
		});

		it("removeRepeat is a no-op when only one instance remains", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					label: "Household members",
					children: [{ id: "name", kind: "text", label: "Name" }],
				},
			]);
			const engine = new FormEngine(input);

			const before = engine.store.getState()["/data/members"];
			engine.removeRepeat("/data/members", 0);
			const after = engine.store.getState()["/data/members"];

			expect(after?.repeatCount).toBe(1);
			// Same reference — no spurious re-render fired.
			expect(after).toBe(before);
		});
	});

	describe("touch (blur validation)", () => {
		it("marks field as touched — required validation deferred to submit", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name", required: "true()" },
			]);
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

			// conditional is not visible (toggle is empty) so it should not cause validation failure
			engine.setValue("/data/toggle", "no");
			expect(engine.validateAll()).toBe(true);
		});
	});

	describe("Zustand store reactivity", () => {
		it("updates store state on value change", () => {
			const input = dTree([{ id: "name", kind: "text", label: "Name" }]);
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

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
						case_property_on: "patient",
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
			const engine = new FormEngine(input, "patient", caseData);

			expect(engine.getState("/data/greeting").resolvedLabel).toBe(
				"Hello, John Smith!",
			);
		});

		it("resolves hashtag refs referencing form fields", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name" },
				{ id: "summary", kind: "label", label: "You entered: #form/name" },
			]);
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

			engine.setValue("/data/first", "Jane");
			engine.setValue("/data/last", "Doe");
			expect(engine.getState("/data/display").resolvedLabel).toBe("Jane Doe");
		});

		it("resolves hashtag refs in hints", () => {
			const input = dTree([
				{ id: "name", kind: "text", label: "Name" },
				{ id: "age", kind: "int", label: "Age", hint: "Age for #form/name" },
			]);
			const engine = new FormEngine(input);

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
			const engine = new FormEngine(input);

			engine.setValue("/data/age", "25");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Adult");

			engine.setValue("/data/age", "10");
			expect(engine.getState("/data/info").resolvedLabel).toBe("Status: Minor");
		});

		it("does not set resolvedLabel when no hashtag refs present", () => {
			const input = dTree([{ id: "name", kind: "text", label: "Plain label" }]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/name").resolvedLabel).toBeUndefined();
		});
	});

	// computeSubmissionMutation walks the engine's template tree, fans
	// repeats out per instance, buckets fields by destination case type,
	// and emits a typed `SubmissionMutation` per form type. Each test
	// constructs a real engine, drives values through the public API,
	// and asserts the emitted mutation shape directly.
	describe("computeSubmissionMutation", () => {
		const patientCaseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
				{ name: "weight", label: "Weight", data_type: "decimal" },
				{ name: "tags", label: "Tags", data_type: "multi_select" },
				{ name: "notes", label: "Notes", data_type: "text" },
				// String-passthrough data types — the coercion layer
				// returns the raw string for each. Declared on the
				// canonical `patient` case-type so the per-type coercion
				// tests below match a real property declaration rather
				// than tripping the unknown-property fallthrough.
				{ name: "dob", label: "DOB", data_type: "date" },
				{ name: "last_seen", label: "Last seen", data_type: "datetime" },
				{ name: "wake_time", label: "Wake time", data_type: "time" },
				{
					name: "home_location",
					label: "Home",
					data_type: "geopoint",
				},
				{
					name: "priority",
					label: "Priority",
					data_type: "single_select",
				},
			],
		};
		const visitCaseType: CaseType = {
			name: "visit",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" },
				{ name: "visit_date", label: "Date", data_type: "date" },
				{ name: "summary", label: "Summary", data_type: "text" },
			],
		};
		const meditationCaseType: CaseType = {
			name: "medication",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" },
				{ name: "dosage_mg", label: "Dosage", data_type: "int" },
			],
		};
		const caseTypes = [patientCaseType, visitCaseType, meditationCaseType];

		describe("registration", () => {
			it("emits primary properties for fields bound to the module's case type", () => {
				const input = dTree([
					{
						id: "case_name",
						kind: "text",
						case_property_on: "patient",
					},
					{ id: "age", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "30");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation).toEqual({
					kind: "registration",
					primary: {
						caseType: "patient",
						caseName: "Alice",
						properties: { age: 30 },
					},
					children: [],
				});
			});

			it("buckets fields whose case_property_on names a different case type into a child case", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "age", kind: "int", case_property_on: "patient" },
					{
						id: "first_visit_date",
						kind: "date",
						case_property_on: "visit",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "30");
				engine.setValue("/data/first_visit_date", "2026-05-01");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary).toEqual({
					caseType: "patient",
					caseName: "Alice",
					properties: { age: 30 },
				});
				expect(mutation.children).toEqual([
					{
						caseType: "visit",
						properties: { first_visit_date: "2026-05-01" },
					},
				]);
				// Registration children carry NO parentCaseId — the case-store
				// threads the primary's generated id at write time.
				const child = mutation.children[0];
				expect(child).toBeDefined();
				expect("parentCaseId" in (child ?? {})).toBe(false);
			});

			it("keeps two distinct child case types in separate children buckets", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "first_visit_date",
						kind: "date",
						case_property_on: "visit",
					},
					{
						id: "dosage_mg",
						kind: "int",
						case_property_on: "medication",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/first_visit_date", "2026-05-01");
				engine.setValue("/data/dosage_mg", "200");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toEqual([
					{ caseType: "visit", properties: { first_visit_date: "2026-05-01" } },
					{ caseType: "medication", properties: { dosage_mg: 200 } },
				]);
			});

			it("fans repeats out into one child per instance per destination case type", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "visit_date",
								kind: "date",
								case_property_on: "visit",
							},
							{
								id: "summary",
								kind: "text",
								case_property_on: "visit",
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/visit_date", "2026-05-01");
				engine.setValue("/data/visits[0]/summary", "first");
				engine.addRepeat("/data/visits");
				engine.setValue("/data/visits[1]/visit_date", "2026-05-02");
				engine.setValue("/data/visits[1]/summary", "second");
				engine.addRepeat("/data/visits");
				engine.setValue("/data/visits[2]/visit_date", "2026-05-03");
				engine.setValue("/data/visits[2]/summary", "third");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toHaveLength(3);
				expect(mutation.children[0]).toEqual({
					caseType: "visit",
					properties: { visit_date: "2026-05-01", summary: "first" },
				});
				expect(mutation.children[1]).toEqual({
					caseType: "visit",
					properties: { visit_date: "2026-05-02", summary: "second" },
				});
				expect(mutation.children[2]).toEqual({
					caseType: "visit",
					properties: { visit_date: "2026-05-03", summary: "third" },
				});
			});

			it("plucks a child-case `case_name` field into the child's caseName slot", () => {
				// A child-bound `case_name` field routes to the child's
				// top-level column, parallel to the primary's behaviour.
				// Distinct child case-types each get their own caseName.
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "case_name",
								kind: "text",
								case_property_on: "visit",
							},
							{
								id: "visit_date",
								kind: "date",
								case_property_on: "visit",
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/case_name", "First visit");
				engine.setValue("/data/visits[0]/visit_date", "2026-05-01");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({});
				expect(mutation.children).toEqual([
					{
						caseType: "visit",
						caseName: "First visit",
						properties: { visit_date: "2026-05-01" },
					},
				]);
			});

			it("emits a child case with only a caseName when no other child fields contribute", () => {
				// A registration form whose only contribution to a child
				// case is the display name still emits the child — the
				// platform defaults handle the rest.
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "visits",
						kind: "repeat",
						children: [
							{
								id: "case_name",
								kind: "text",
								case_property_on: "visit",
							},
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/visits[0]/case_name", "First visit");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toEqual([
					{ caseType: "visit", caseName: "First visit", properties: {} },
				]);
			});

			it("omits the primary caseName slot when no `case_name` field has a value", () => {
				// When no `case_name` field contributes a value, the primary
				// emits without the `caseName` slot — distinguishable from
				// `caseName: ""` which would be a contract violation
				// (`cases.case_name` carries `length(case_name) > 0`).
				const input = dTree([
					{ id: "age", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/age", "30");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect("caseName" in mutation.primary).toBe(false);
				expect(mutation.primary.properties).toEqual({ age: 30 });
			});

			it("throws when registration reaches the engine without a moduleCaseType", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input);

				expect(() => engine.computeSubmissionMutation({ caseTypes })).toThrow(
					/registration form reached the engine method without a `moduleCaseType`/,
				);
			});
		});

		describe("followup", () => {
			it("emits a primary patch and binds children to the supplied caseId", () => {
				const input = dTree(
					[
						{ id: "case_name", kind: "text", case_property_on: "patient" },
						{ id: "notes", kind: "text", case_property_on: "patient" },
						{
							id: "visit_date",
							kind: "date",
							case_property_on: "visit",
						},
					],
					"followup",
				);
				const caseData = new Map([["case_name", "Alice"]]);
				const engine = new FormEngine(input, "patient", caseData);

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/notes", "follow-up note");
				engine.setValue("/data/visit_date", "2026-05-02");

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-123",
					caseTypes,
				});
				expect(mutation).toEqual({
					kind: "followup",
					caseId: "case-id-123",
					patch: {
						caseName: "Alice",
						properties: { notes: "follow-up note" },
					},
					children: [
						{
							caseType: "visit",
							properties: { visit_date: "2026-05-02" },
							parentCaseId: "case-id-123",
						},
					],
				});
			});

			it("throws when no caseId is supplied", () => {
				const input = dTree(
					[{ id: "notes", kind: "text", case_property_on: "patient" }],
					"followup",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "hello");
				expect(() => engine.computeSubmissionMutation({ caseTypes })).toThrow(
					/form type `followup` requires a bound `caseId`/,
				);
			});

			it("emits an empty primary patch when no fields target the module's case type", () => {
				// Followup forms whose every leaf field targets a child case
				// type still emit the discriminator + bound caseId so the
				// consumer can dispatch to the case-store update arm. The
				// patch's `properties` object is structurally empty.
				const input = dTree(
					[
						{
							id: "visit_date",
							kind: "date",
							case_property_on: "visit",
						},
					],
					"followup",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/visit_date", "2026-05-02");
				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					caseTypes,
				});
				expect(mutation).toEqual({
					kind: "followup",
					caseId: "case-id-1",
					patch: { properties: {} },
					children: [
						{
							caseType: "visit",
							properties: { visit_date: "2026-05-02" },
							parentCaseId: "case-id-1",
						},
					],
				});
			});
		});

		describe("close", () => {
			it("emits a close-discriminated mutation with the patch + children", () => {
				const input = dTree(
					[
						{ id: "notes", kind: "text", case_property_on: "patient" },
						{
							id: "discharge_date",
							kind: "date",
							case_property_on: "visit",
						},
					],
					"close",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "discharged");
				engine.setValue("/data/discharge_date", "2026-05-03");

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-456",
					caseTypes,
				});
				expect(mutation).toEqual({
					kind: "close",
					caseId: "case-id-456",
					patch: { properties: { notes: "discharged" } },
					children: [
						{
							caseType: "visit",
							properties: { discharge_date: "2026-05-03" },
							parentCaseId: "case-id-456",
						},
					],
				});
			});

			it("throws when no caseId is supplied", () => {
				const input = dTree(
					[{ id: "notes", kind: "text", case_property_on: "patient" }],
					"close",
				);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/notes", "hello");
				expect(() => engine.computeSubmissionMutation({ caseTypes })).toThrow(
					/form type `close` requires a bound `caseId`/,
				);
			});

			it("emits empty primary properties for close-only forms", () => {
				// A close form whose only action is the closure stamp itself
				// carries no scalar property writes. The patch is structurally
				// empty; the consumer's close arm runs `caseStore.close` after
				// the (no-op) update lands.
				const input = dTree(
					[{ id: "case_name", kind: "text", case_property_on: "patient" }],
					"close",
				);
				const engine = new FormEngine(input, "patient");
				// `case_name` left empty — the close form has no writes to
				// contribute beyond the closure stamp.

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					caseTypes,
				});
				expect(mutation).toEqual({
					kind: "close",
					caseId: "case-id-1",
					patch: { properties: {} },
					children: [],
				});
			});
		});

		describe("survey", () => {
			it("emits the survey marker without walking the tree", () => {
				const input = dTree([{ id: "name", kind: "text" }], "survey");
				const engine = new FormEngine(input);

				engine.setValue("/data/name", "Alice");
				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation).toEqual({ kind: "survey" });
			});

			it("emits the survey marker even when caseId is provided", () => {
				const input = dTree([{ id: "name", kind: "text" }], "survey");
				const engine = new FormEngine(input);

				const mutation = engine.computeSubmissionMutation({
					caseId: "case-id-1",
					caseTypes,
				});
				expect(mutation).toEqual({ kind: "survey" });
			});
		});

		describe("data_type coercion", () => {
			// Mirrors the `caseTypeToJsonSchema` mapping the case-store's
			// AJV validator runs against. A failed numeric parse falls
			// through as the raw string so AJV surfaces the type
			// mismatch rather than silently coercing to NaN / 0.
			it("coerces text to string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "notes", kind: "text", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/notes", "hello");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({ notes: "hello" });
			});

			it("coerces int to integer", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "age", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "42");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.age).toBe(42);
			});

			it("coerces decimal to number", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "weight", kind: "decimal", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/weight", "72.5");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.weight).toBe(72.5);
			});

			it("coerces multi_select to a string array, splitting on whitespace", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "tags",
						kind: "multi_select",
						case_property_on: "patient",
						options: [
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
							{ value: "c", label: "C" },
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/tags", "a b c");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.tags).toEqual(["a", "b", "c"]);
			});

			it("falls through unparseable int values as the raw string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "age", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "not-a-number");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.age).toBe("not-a-number");
			});

			// String-passthrough data types: `date`, `datetime`, `time`,
			// `geopoint`, and `single_select` all return the raw string
			// from the coercion layer (verbatim from `caseTypeToJsonSchema`'s
			// type-mapping). The wire shape is the user-typed value;
			// AJV's `format` keyword validates it at insert time. These
			// tests pin the per-type contract so a future coercion-layer
			// change that accidentally unboxes one of them surfaces here.
			it("coerces date to its raw string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "dob", kind: "date", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/dob", "1995-03-12");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.dob).toBe("1995-03-12");
			});

			it("coerces datetime to its raw string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "last_seen",
						kind: "datetime",
						case_property_on: "patient",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/last_seen", "2026-05-06T12:34:56Z");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.last_seen).toBe(
					"2026-05-06T12:34:56Z",
				);
			});

			it("coerces time to its raw string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "wake_time",
						kind: "time",
						case_property_on: "patient",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/wake_time", "07:30:00");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.wake_time).toBe("07:30:00");
			});

			it("coerces geopoint to its raw string", () => {
				// Geopoint wire shape is the canonical CommCare
				// `"lat lon alt acc"` string; the coercion layer never
				// parses it. PostGIS conversion happens at the case-list
				// query layer (`within-distance`), not at write time.
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "home_location",
						kind: "geopoint",
						case_property_on: "patient",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/home_location", "37.7749 -122.4194 0 5");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.home_location).toBe(
					"37.7749 -122.4194 0 5",
				);
			});

			it("coerces single_select to its raw string", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "priority",
						kind: "single_select",
						case_property_on: "patient",
						options: [
							{ value: "low", label: "Low" },
							{ value: "high", label: "High" },
						],
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/priority", "high");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.priority).toBe("high");
			});
		});

		describe("coercion fallthrough", () => {
			// When the case-types lookup misses (the case type isn't in
			// the supplied array, or the property isn't declared on the
			// matched case type), the value passes through as text rather
			// than being dropped. The coercion layer's contract is
			// "coerce when you can; pass through when you can't".
			it("passes unknown-case-type values through as text", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "age", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/age", "42");

				// Empty caseTypes — `age` falls through as text. `case_name`
				// is plucked into the column slot regardless of lookup state
				// because the field-id discriminator runs first.
				const mutation = engine.computeSubmissionMutation({ caseTypes: [] });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({ age: "42" });
			});

			it("passes unknown-property values through as text when the case type is matched but the property isn't declared", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					// `extra` isn't declared on `patientCaseType`.
					{ id: "extra", kind: "int", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/extra", "42");

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.properties.extra).toBe("42");
			});
		});

		describe("empty-value filtering", () => {
			// The walker's contract: filter on emptiness only. Missing
			// paths and `""` reads both drop. `state.visible` is NOT
			// consulted — hidden fields with non-empty values land in
			// the mutation.
			it("excludes empty fields from the mutation", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{ id: "notes", kind: "text", case_property_on: "patient" },
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				// `notes` left empty.

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.primary.caseName).toBe("Alice");
				expect(mutation.primary.properties).toEqual({});
				expect("notes" in mutation.primary.properties).toBe(false);
			});

			it("includes hidden fields with non-empty values (visibility is NOT consulted)", () => {
				const input = dTree([
					{
						id: "show",
						kind: "single_select",
						options: [
							{ value: "yes", label: "Yes" },
							{ value: "no", label: "No" },
						],
					},
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "notes",
						kind: "text",
						case_property_on: "patient",
						relevant: '/data/show = "yes"',
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				engine.setValue("/data/show", "yes");
				engine.setValue("/data/notes", "secret note");
				// Toggle visibility off — the value stays.
				engine.setValue("/data/show", "no");
				expect(engine.getState("/data/notes").visible).toBe(false);

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				// `notes` is hidden but the value is non-empty — it lands.
				expect(mutation.primary.properties.notes).toBe("secret note");
			});

			it("excludes child-case fields whose only contributor is empty (no zero-property bucket)", () => {
				const input = dTree([
					{ id: "case_name", kind: "text", case_property_on: "patient" },
					{
						id: "first_visit_date",
						kind: "date",
						case_property_on: "visit",
					},
				]);
				const engine = new FormEngine(input, "patient");

				engine.setValue("/data/case_name", "Alice");
				// `first_visit_date` left empty — no `visit` bucket should land.

				const mutation = engine.computeSubmissionMutation({ caseTypes });
				expect(mutation.kind).toBe("registration");
				if (mutation.kind !== "registration") return;
				expect(mutation.children).toEqual([]);
			});
		});
	});

	// `FieldState.repeatCount` is the load-bearing signal for repeat
	// sizing — `computeSubmissionMutation` reads instance counts off the
	// `DataInstance` directly via `getRepeatCount`, but the rendered UI
	// reads off the FieldState. This invariant pins the two readings in
	// sync so a future repeat-mutating path (case-data preload that
	// seeds N instances, replay, etc.) can't silently drift one without
	// the other and produce wrong child-case counts.
	describe("repeat-count invariant", () => {
		it("matches FieldState.repeatCount with DataInstance.getRepeatCount on init", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after addRepeat", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after removeRepeat", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.removeRepeat("/data/members", 0);
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after setValue (a leaf write should not touch repeat count)", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.setValue("/data/members[1]/name", "Bob");
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});

		it("matches after reset", () => {
			const input = dTree([
				{
					id: "members",
					kind: "repeat",
					children: [{ id: "name", kind: "text" }],
				},
			]);
			const engine = new FormEngine(input);

			engine.addRepeat("/data/members");
			engine.addRepeat("/data/members");
			engine.reset();
			expect(engine.getState("/data/members").repeatCount).toBe(
				engine.getRepeatCount("/data/members"),
			);
		});
	});
});
