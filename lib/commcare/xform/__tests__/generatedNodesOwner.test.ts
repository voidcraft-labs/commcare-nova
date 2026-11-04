/**
 * The owner node of an advanced open action: which creates have one (the
 * rows of HQ's `autoset_owner_id_for_advanced_action` where the stated owner
 * is not the one HQ would set), its scope (the form root or the create's
 * repeat row), its place after every other name of that scope, and the
 * usual suffix. Catches a carried extension case left owned by no one, an
 * unowned child that HQ hands to the worker, an owner node that renames a
 * container or a question's sibling when it appears, and one named in the
 * wrong element.
 */
import { describe, expect, it } from "vitest";
import {
	advancedOwnerNodeValue,
	planGeneratedNodes,
} from "@/lib/commcare/xform/generatedNodes";
import type { CaseOperation } from "@/lib/domain";
import { unowned } from "@/lib/domain/expression/builders";
import {
	childCreate,
	OP,
	OWN,
	own,
	ownCaseLink,
	placementFixture,
	read,
} from "../../__tests__/placementFixture";
import { FormPath } from "../formPath";

const extensionCreate = (
	key: string,
	extra: Partial<CaseOperation> & { repeat?: string } = {},
): CaseOperation =>
	childCreate(key, "followup", {
		links: [ownCaseLink("followup", "extension")],
		...extra,
	});

describe("advancedOwnerNodeValue", () => {
	it.each([
		[
			"no owner, no link",
			childCreate("a", "followup", { links: [] }),
			undefined,
		],
		["no owner, a child link", childCreate("a", "followup"), undefined],
		["no owner, only extension links", extensionCreate("a"), "acting-user"],
		[
			"the worker, only extension links",
			extensionCreate("a", { owner: { kind: "acting-user" } }),
			"acting-user",
		],
		[
			"unowned, no link",
			childCreate("a", "followup", { links: [], owner: unowned() }),
			"unowned",
		],
		[
			"unowned, a child link",
			childCreate("a", "followup", { owner: unowned() }),
			"unowned",
		],
		[
			"unowned, a child and an extension link",
			childCreate("a", "followup", {
				owner: unowned(),
				links: [
					ownCaseLink("followup", "extension"),
					{ ...ownCaseLink("followup"), identifier: "host" },
				],
			}),
			"unowned",
		],
		[
			"unowned, only extension links",
			extensionCreate("a", { owner: unowned() }),
			undefined,
		],
		[
			"an owner read from a question",
			extensionCreate("a", { owner: read("name") }),
			undefined,
		],
		[
			"a create keyed by an answer",
			extensionCreate("a", { target: { kind: "new", idFrom: OP("x") } }),
			undefined,
		],
	] as const)("%s", (_, operation, expected) => {
		expect(advancedOwnerNodeValue("followup", operation)).toBe(expected);
	});

	it("reads a registration's own case and no other form's", () => {
		const unownedOwn = own({ owner: unowned() });
		expect(advancedOwnerNodeValue("registration", unownedOwn)).toBe("unowned");
		expect(advancedOwnerNodeValue("registration", own())).toBeUndefined();
		expect(advancedOwnerNodeValue("followup", unownedOwn)).toBeUndefined();
	});

	it("gives an update or a close none", () => {
		const update = {
			uuid: OP("u"),
			id: "u",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			owner: unowned(),
		} as CaseOperation;
		expect(advancedOwnerNodeValue("followup", update)).toBeUndefined();
	});
});

describe("the owner node's name", () => {
	it("is nova_owner_<operation id> at the root, after the containers", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [own(), extensionCreate("ext")],
			// A question that takes the containers' and the owner's bases.
			extraRoot: [
				{ kind: "text", id: "nova_operations" },
				{ kind: "text", id: "nova_owner_ext" },
			],
		});
		const plan = planGeneratedNodes(doc, formUuid);
		expect(plan.owner(OP("ext"))).toBe("nova_owner_ext_1");
		expect(plan.operations(FormPath.root())).toBe("nova_operations_1");
		const purposes = plan.nodes.map((node) => node.purpose);
		expect(purposes.at(-1)).toBe("owner");
		expect(plan.nodes.at(-1)).toEqual({
			purpose: "owner",
			name: "nova_owner_ext_1",
			owner: OP("ext"),
		});
	});

	it("is allocated in the create's repeat row", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [
				own(),
				extensionCreate("ext", { repeat: "kids" }),
				extensionCreate("root_ext"),
			],
			extraRoot: [{ kind: "text", id: "nova_owner_ext" }],
		});
		const plan = planGeneratedNodes(doc, formUuid);
		// The root question takes nothing from the row's namespace.
		expect(plan.owner(OP("ext"))).toBe("nova_owner_ext");
		expect(plan.owner(OP("root_ext"))).toBe("nova_owner_root_ext");
	});

	it("names every other node as it would without the owner node", () => {
		const operations = (owner: boolean) => () => [
			own(),
			extensionCreate("ext", {
				condition: read("flag"),
				...(owner ? {} : { owner: unowned() }),
			}),
		];
		const withNode = placementFixture("followup", {
			operations: operations(true),
		});
		const without = placementFixture("followup", {
			operations: operations(false),
		});
		const rest = (fixture: typeof withNode) =>
			planGeneratedNodes(fixture.doc, fixture.formUuid).nodes.filter(
				(node) => node.purpose !== "owner",
			);
		expect(rest(withNode)).toEqual(rest(without));
		expect(
			planGeneratedNodes(without.doc, without.formUuid).nodes.some(
				(node) => node.purpose === "owner",
			),
		).toBe(false);
	});

	it("names a registration's unowned own case", () => {
		const { doc, formUuid } = placementFixture("registration", {
			operations: () => [own({ name: read("name"), owner: unowned() })],
		});
		expect(planGeneratedNodes(doc, formUuid).owner(OWN)).toBe(
			"nova_owner_patient",
		);
	});

	it("refuses a lookup for an operation that has no owner node", () => {
		const { doc, formUuid } = placementFixture("followup", {
			operations: () => [own(), childCreate("kid", "followup")],
		});
		expect(() => planGeneratedNodes(doc, formUuid).owner(OP("kid"))).toThrow(
			/holds none/,
		);
	});
});
