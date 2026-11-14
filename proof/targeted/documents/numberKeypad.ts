/**
 * The Phone Number question: a Text question with a number keypad.
 *
 * `targeted-number-keypad` is one menu of clients whose registration asks
 * the client's name and a phone number on a number keypad
 * (`keypad: "numbers"`), saves the number to the property `phone` and shows
 * it in a Phone column. Nova writes the question as
 * `<input appearance="numeric">` with the bind every Text question has,
 * `xsd:string` (`lib/commcare/xform/appearance.ts::fieldAppearance`), the
 * one shape HQ's form builder reads as its Phone Number or Numeric ID
 * question (Vellum `src/parser.js::buildControlNodeAdaptorMap`, a bind of
 * type `string` and the whole appearance `numeric`) and writes back
 * unchanged. Web Apps draws `PhoneEntry` for it
 * (`form_entry/entries.js::getEntry`) and Android `StringNumberWidget`
 * (`WidgetFactory.java::buildBasicWidget`); the answer is text on Core
 * either way. The document declares both platforms.
 *
 * Fixed values: the answer is text, so a leading zero and a plus sign are
 * kept: `0712` and `+254712` are held as given.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { phoneColumn, plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld, type HeldSession } from "./echo";

const ID = "targeted-number-keypad";
const uuid = (name: string) => targetedUuid(ID, name);
/** The registration's entry, with the id its new case is made under. */
const REGISTER_SESSION: HeldSession = {
	command: "m0-f0",
	data: { case_id_new_client_0: "targeted-new-client" },
};

export function numberKeypad() {
	const register = uuid("register");
	const doc = buildDoc({
		appId: ID,
		appName: "Client phones",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "phone", label: proseText("Phone"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
					phoneColumn(uuid("phone-column"), "phone", "Phone"),
				]),
				forms: [
					{
						uuid: register,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "text",
								uuid: uuid("phone"),
								id: "phone",
								label: proseText("Phone number"),
								keypad: "numbers",
								caseWrite: { caseType: "client", property: "phone" },
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["questions, the Phone Number question"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"leading-zero-held",
					register,
					"/data/phone",
					"0712",
					"local",
					REGISTER_SESSION,
				),
				answerHeld(
					"plus-sign-held",
					register,
					"/data/phone",
					"+254712",
					"local",
					REGISTER_SESSION,
				),
			],
		},
	});
}
