import fc from "fast-check";
import { expect, it } from "vitest";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { blueprintDocArbitrary } from "@/lib/commcare/__tests__/xformDocArbitrary";
import type { BlueprintDoc } from "@/lib/domain";
import {
	builtinIconRef,
	FORM_ICON_SLUGS,
	MODULE_ICON_SLUGS,
} from "@/lib/domain/builtinIcons";

// Finite seeded corpus, with shrinking enabled. Reading is total over admitted
// apps: whatever the commit gate accepts, every structural read prints, and it
// prints as authored content. The populated-app sweep beside this file proves
// named features; this looks for the combination nobody thought to name.

/** The generator mints uploaded-media icons. Half the tiles take a built-in
 * instead, the identity an ordinary built app carries. */
const docWithBuiltinIcons = fc
	.tuple(blueprintDocArbitrary, fc.infiniteStream(fc.nat()))
	.map(([doc, picks]): BlueprintDoc => {
		const next = structuredClone(doc);
		const pick = () => picks.next().value;
		for (const module of Object.values(next.modules))
			if (pick() % 2 === 0)
				module.icon = builtinIconRef(
					MODULE_ICON_SLUGS[pick() % MODULE_ICON_SLUGS.length],
				);
		for (const form of Object.values(next.forms))
			if (pick() % 2 === 0)
				form.icon = builtinIconRef(
					FORM_ICON_SLUGS[pick() % FORM_ICON_SLUGS.length],
				);
		return next;
	});

it("reads every module, form and operation list of any admitted app as authored content", async () => {
	await fc.assert(
		fc.asyncProperty(docWithBuiltinIcons, async (doc) => {
			const h = makeAuthoringHarness({}, expectAdmittedDoc(doc));
			for (const moduleUuid of doc.moduleOrder) {
				const reads: [string, unknown][] = [
					["getModule", { moduleUuid }],
					...doc.formOrder[moduleUuid].flatMap(
						(formUuid): [string, unknown][] => [
							["getForm", { moduleUuid, formUuid }],
							["getCaseOperations", { moduleUuid, formUuid }],
						],
					),
				];
				for (const [name, input] of reads) {
					const result = await h.call(name, input);
					expect(result, name).not.toHaveProperty("error");
					const printed = JSON.stringify(result);
					expect(printed, name).not.toContain("nova-icon:");
					expect(printed, name).not.toContain('"parts":');
				}
			}
		}),
		{ seed: 20260919, numRuns: 150 },
	);
}, 120_000);
