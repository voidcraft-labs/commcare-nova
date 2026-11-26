import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import type { MenuBadge } from "@/lib/domain/menuBadge";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function menuBadges() {
	const id = "targeted-menu-badges";
	const uuid = (value: string) => targetedUuid(id, value);
	const examples = [
		["No badge", undefined],
		["Zero", { kind: "text", text: "0" }],
		["Padded zero", { kind: "text", text: "0000" }],
		[
			"Visits due",
			{
				kind: "calculation",
				expression: { kind: "term", term: { kind: "literal", value: 1234 } },
			},
		],
		["Long number", { kind: "text", text: "2147483648" }],
		["Word", { kind: "text", text: "Équipe" }],
	] satisfies [string, MenuBadge | undefined][];
	const form = (name: string) => ({
		uuid: uuid(name),
		name,
		type: "survey" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`note-${name}`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	});
	const doc = buildDoc({
		appId: id,
		appName: "Field rounds",
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visit forms",
				forms: examples.map(([name]) => form(name)),
			},
			{ uuid: uuid("notes"), name: "Notes", forms: [form("Field note")] },
		],
	});
	const visitMenu = doc.modules[uuid("visits")];
	if (!visitMenu) throw new Error("Missing Visit forms menu.");
	visitMenu.badge = { kind: "text", text: "New" };
	for (const [name, badge] of examples) {
		const held = doc.forms[uuid(name)];
		if (!held) throw new Error(`Missing ${name} form.`);
		if (badge) held.badge = badge;
	}
	return targetedDocument({
		id,
		rows: ["Menu and form badges"],
		doc,
		expected: {
			intent: [
				answerHeld("visit-saved", uuid("Visits due"), "/data/note", "Seen"),
			],
		},
	});
}
