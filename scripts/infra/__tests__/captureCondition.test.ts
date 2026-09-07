import { CelScalar, celEnv, celMethod, parse, plan } from "@bufbuild/cel";
import { describe, expect, test } from "vitest";
import { captureCleanupIamCondition } from "../capture-storage-policy.mjs";

// IAM adds extract() to CEL. This generic extension follows Google's template
// contract and its examples below; it contains no Nova object-key policy.
// https://docs.cloud.google.com/iam/docs/conditions-attribute-reference#extract
const extract = celMethod(
	"extract",
	CelScalar.STRING,
	[CelScalar.STRING],
	CelScalar.STRING,
	function (template) {
		const parts = /^([^{}]*)\{[A-Za-z0-9_]+\}([^{}]*)$/.exec(template);
		if (!parts) throw new Error("Invalid IAM extraction template");
		const [, prefix, suffix] = parts;
		const match = this.indexOf(prefix);
		if (match < 0) return "";
		const start = match + prefix.length;
		const end = suffix === "" ? this.length : this.indexOf(suffix, start);
		return end < 0 ? "" : this.slice(start, end);
	},
);
const environment = celEnv({ funcs: [extract] });
const expression = parse(captureCleanupIamCondition("nova-multimedia-prod"));
const evaluate = plan(environment, expression);

describe("emitted capture IAM condition", () => {
	test.each([
		["captures-staged/project-a/attachment.png", true],
		["captures-staged/_health/probe-id.probe", true],
		["projects/project-a/captures/attachment.png", true],
		["projects/project-b/captures/attachment.wav", true],
		["projects/project-a/captures/attachment/thumb.png", true],
		["pending/project-a/media-id.png", false],
		["projects/project-a/content-hash.png", false],
		["projects/project-a/content-hash.requirements.md", false],
		["projects/project-a/captures-not/attachment.png", false],
		["projects/project-a/captures/", false],
		["projects/project-a/captures/attachment/", false],
		["projects/project-a/captures//attachment.png", false],
		["projects/project-a/captures/attachment//thumb.png", false],
		["projects/project-a/nested/captures/attachment.png", false],
		["projects//captures/attachment.png", false],
		["captures-staged/", false],
		["captures-staged//attachment.png", false],
		["captures-staged/project-a//attachment.png", false],
		["captures/project-a/attachment.png", false],
	])("the actual CEL rule decides object %s as %s", (key, allowed) => {
		expect(
			evaluate({
				resource: {
					type: "storage.googleapis.com/Object",
					name: `projects/_/buckets/nova-multimedia-prod/objects/${key}`,
				},
			}),
		).toBe(allowed);
	});

	test("the condition is limited to objects in the selected bucket", () => {
		const name =
			"projects/_/buckets/nova-multimedia-prod/objects/captures-staged/project-a/attachment.png";
		expect(
			evaluate({ resource: { name, type: "storage.googleapis.com/Object" } }),
		).toBe(true);
		expect(
			evaluate({ resource: { name, type: "storage.googleapis.com/Bucket" } }),
		).toBe(false);
		expect(
			evaluate({
				resource: {
					name: name.replace("nova-multimedia-prod", "foreign"),
					type: "storage.googleapis.com/Object",
				},
			}),
		).toBe(false);
	});

	test("the parsed expression uses only IAM's supported resource-name operations", () => {
		// A general CEL engine supports more functions than Google IAM permits
		// on resource.name. Check the real parsed AST, not source substrings.
		function inspect(node: typeof expression.expr): void {
			const kind = node.exprKind;
			switch (kind.case) {
				case "callExpr":
					expect([
						"_&&_",
						"_||_",
						"!_",
						"_==_",
						"_!=_",
						"startsWith",
						"endsWith",
						"extract",
					]).toContain(kind.value.function);
					if (
						["startsWith", "endsWith", "extract"].includes(kind.value.function)
					) {
						expect(kind.value.target?.exprKind).toMatchObject({
							case: "selectExpr",
							value: {
								field: "name",
								operand: {
									exprKind: { case: "identExpr", value: { name: "resource" } },
								},
							},
						});
						expect(kind.value.args).toHaveLength(1);
						expect(kind.value.args[0].exprKind).toMatchObject({
							case: "constExpr",
							value: { constantKind: { case: "stringValue" } },
						});
					}
					if (kind.value.target) inspect(kind.value.target);
					for (const arg of kind.value.args) inspect(arg);
					return;
				case "selectExpr":
					expect(["name", "type"]).toContain(kind.value.field);
					expect(kind.value.operand?.exprKind).toMatchObject({
						case: "identExpr",
						value: { name: "resource" },
					});
					return;
				case "constExpr":
					expect(["stringValue", "boolValue"]).toContain(
						kind.value.constantKind.case,
					);
					return;
				default:
					throw new Error(`Unsupported IAM expression node: ${kind.case}`);
			}
		}
		inspect(expression.expr);
	});

	test.each(["", "bucket' || true", "bucket/path", "bucket\nname"])(
		"invalid bucket input cannot become condition code: %j",
		(bucket) => {
			expect(() => captureCleanupIamCondition(bucket)).toThrow(
				"Invalid storage bucket",
			);
		},
	);
});

test("the IAM extract extension matches the provider's independent template examples", () => {
	const evaluateExtract = plan(environment, parse("value.extract(template)"));
	const value =
		"projects/_/buckets/acme-orders-aaa/objects/data_lake/orders/order_date=2019-11-03/aef87g87ae0876";
	for (const [template, expected] of [
		["/order_date={date}/", "2019-11-03"],
		["buckets/{name}/", "acme-orders-aaa"],
		["/orders/{empty}order_date", ""],
		["{start}/objects/data_lake", "projects/_/buckets/acme-orders-aaa"],
		["orders/{end}", "order_date=2019-11-03/aef87g87ae0876"],
		["{all}", value],
		["/orders/{none}/order_date=", ""],
		["/orders/order_date=2019-11-03/{id}/data_lake", ""],
	]) {
		expect(evaluateExtract({ value, template }), template).toBe(expected);
	}
});
