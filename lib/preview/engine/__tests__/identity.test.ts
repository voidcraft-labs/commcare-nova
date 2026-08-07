// lib/preview/engine/__tests__/identity.test.ts
//
// The ResolvedPreviewIdentity contract: the separation of the authorizing
// member from the acting worker, both providers' derivations and refusal
// arms, the two wire projections (`session/user/data` vs the usercase),
// the honesty rules about values Nova cannot know, the anonymous
// projection, and the material-equality comparator that keeps re-derived
// identities from rebuilding evaluation state.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { UserCollections } from "@/lib/domain";
import {
	previewAsMe,
	previewAsPersona,
	previewSessionValues,
	samePreviewIdentity,
} from "../identity";

const FULL_USER = {
	id: "worker-42",
	name: "Amina Diallo",
	email: "amina@example.org",
};

const REGION = testUuid("11111111-1111-4111-8111-111111111111");
const CADRE = testUuid("22222222-2222-4222-8222-222222222222");
const CHW = testUuid("33333333-3333-4333-8333-333333333333");
const ASHA = testUuid("44444444-4444-4444-8444-444444444444");
const NORTH = testUuid("55555555-5555-4555-8555-555555555551");
const CLINIC = testUuid("55555555-5555-4555-8555-555555555552");

const DOC: UserCollections = {
	userProperties: {
		[REGION]: { uuid: REGION, slug: "region", label: "Region" },
		[CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" },
	},
	userTypes: {
		[CHW]: {
			uuid: CHW,
			name: "CHW",
			values: { [REGION]: "north", [CADRE]: "community" },
		},
	},
	personas: {
		[ASHA]: {
			uuid: ASHA,
			name: "Asha Kumar",
			userTypeUuid: CHW,
			values: { [REGION]: "south" },
		},
	},
};

const ASHA_PERSONA = DOC.personas?.[ASHA];
if (ASHA_PERSONA === undefined) throw new Error("fixture persona missing");

/**
 * The security invariant of this unit, written to fail loudly rather than
 * to describe shape: `actorUserId` authorizes and is always a real Nova
 * account, while `ownerId` is authored blueprint content. Collapsing the
 * two would let an app choose whose data a preview request may read.
 */
describe("the authorizing member and the acting worker are separate", () => {
	it("previewing as a persona keeps the signed-in member as the actor", () => {
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.actorUserId).toBe(FULL_USER.id);
		expect(identity?.ownerId).toBe(ASHA);
		expect(identity?.actorUserId).not.toBe(identity?.ownerId);
		expect(identity?.personaUuid).toBe(ASHA);
	});

	it("no authored persona value can become the actor", () => {
		const identity = previewAsPersona(
			FULL_USER,
			{ ...ASHA_PERSONA, name: "someone-elses-user-id" },
			DOC,
		);
		expect(identity?.actorUserId).toBe(FULL_USER.id);
	});

	it("refuses without a persisted member, whatever the persona says", () => {
		expect(previewAsPersona(null, ASHA_PERSONA, DOC)).toBeNull();
		expect(previewAsPersona(undefined, ASHA_PERSONA, DOC)).toBeNull();
		expect(previewAsPersona({ id: "   " }, ASHA_PERSONA, DOC)).toBeNull();
	});

	it("previewing as yourself makes the two the same identity", () => {
		const identity = previewAsMe(FULL_USER, DOC);
		expect(identity?.actorUserId).toBe(FULL_USER.id);
		expect(identity?.ownerId).toBe(FULL_USER.id);
		expect(identity?.personaUuid).toBeUndefined();
	});
});

describe("previewAsMe", () => {
	it("projects the signed-in user into the session vocabulary", () => {
		const identity = previewAsMe(FULL_USER);
		expect(identity).not.toBeNull();
		expect(identity?.ownerId).toBe("worker-42");
		expect(identity?.session.context).toEqual({
			userid: "worker-42",
			username: "amina@example.org",
			deviceid: "nova-preview",
			appversion: "preview",
		});
	});

	it("prefers email over name over id for the username", () => {
		expect(
			previewAsMe({ id: "u1", name: "Only Name" })?.session.context.username,
		).toBe("Only Name");
		expect(previewAsMe({ id: "u1" })?.session.context.username).toBe("u1");
	});

	it("refuses a missing user or an unpersisted (blank) id", () => {
		expect(previewAsMe(null)).toBeNull();
		expect(previewAsMe(undefined)).toBeNull();
		expect(previewAsMe({ id: "" })).toBeNull();
		expect(previewAsMe({ id: "   ", name: "Ghost" })).toBeNull();
	});

	it("carries no authored worker data — a member is not a worker", () => {
		// Every DECLARED property is still present-and-empty (see below); the
		// member simply has no values of their own to layer over them.
		const identity = previewAsMe(FULL_USER, DOC);
		expect(identity?.session.user.region).toBe("");
		expect(identity?.session.user.cadre).toBe("");
	});
});

describe("session values are honest", () => {
	it("layers a persona's overrides over its role's defaults", () => {
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.session.user.region).toBe("south");
		expect(identity?.session.user.cadre).toBe("community");
	});

	it("gives a declared property with no value a present, empty slot", () => {
		// HQ's `user_data.py::UserData.to_dict` seeds every schema field to ''
		// before layering authored values, so a declared-but-unset property is
		// present-and-empty on the wire while an undeclared key is absent.
		const identity = previewAsMe(FULL_USER, DOC);
		expect(identity?.session.user.region).toBe("");
		expect(identity?.session.user).not.toHaveProperty("undeclared_thing");
	});

	it("leaves the SESSION project slug absent while no deployment names one", () => {
		// `get_user_session_data` is the sole injector of the session copy,
		// and Nova will not invent a slug to make a condition pass.
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.session.user).not.toHaveProperty("commcare_project");
	});

	it("carries the USERCASE project slug once Nova knows it, and omits it until then", () => {
		/* `sync_usercase.py::_get_user_case_fields` ends with an
		 * unconditional `fields.update({... 'commcare_project': domain})`, so
		 * this IS a usercase property in a way it is not a session key. But
		 * the domain is never empty on a device, so an empty string here is a
		 * value no worker can hold: `#user/commcare_project = ''` would fire
		 * in Preview and never in the field. Absent is the honest shape —
		 * unlike `language`, which HQ genuinely writes as `''`. */
		const without = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(without?.usercase).not.toHaveProperty("commcare_project");
		expect(without?.usercase.language).toBe("");

		const withTarget = previewAsPersona(
			FULL_USER,
			ASHA_PERSONA,
			DOC,
			"rhi-bihar",
		);
		expect(withTarget?.usercase.commcare_project).toBe("rhi-bihar");
		expect(withTarget?.session.user.commcare_project).toBe("rhi-bihar");
	});

	it("names the worker under `case_name`, never `name`", () => {
		/* `_get_user_case_fields` does put `name` in its dict, but both
		 * writers pop it back out into the case's name
		 * (`create_usercase`: `case_name=fields.pop('name', None)`), so it
		 * never lands as a case property. The device reads the casedb's own
		 * `case_name` node. Emitting `name` would make `#user/name` work in
		 * Preview and read blank in the field. */
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.usercase.case_name).toBe("Asha Kumar");
		expect(identity?.usercase).not.toHaveProperty("name");
	});

	it("keeps HQ's unconditional profile keys present even when their values are empty", () => {
		const persona = {
			uuid: testUuid("66666666-6666-4666-8666-666666666666"),
			name: "Asha",
		};
		const identity = previewAsPersona(FULL_USER, persona, DOC);
		expect(identity?.session.user.commcare_first_name).toBe("Asha");
		expect(identity?.session.user.commcare_last_name).toBe("");
		expect(identity?.session.user.commcare_phone_number).toBe("");
		expect(identity?.usercase.first_name).toBe("Asha");
		expect(identity?.usercase.last_name).toBe("");
		expect(identity?.usercase.email).toBe("");
		expect(identity?.usercase.phone_number).toBe("");
		// Neither copy invents a project space. `commcare_profile` is the
		// contrast: HQ really does write that slot empty for every worker.
		expect(identity?.session.user).not.toHaveProperty("commcare_project");
		expect(identity?.usercase).not.toHaveProperty("commcare_project");
		expect(identity?.usercase.commcare_profile).toBe("");
	});

	it("marks an ordinary worker standard, not demo — and never absent", () => {
		// HQ sends `user_type` only for a practice user, but the CLIENT seeds
		// it: every `User.java` constructor calls `setUserType(STANDARD)`, a
		// plain `properties.put`, and `UserXmlParser::parse` builds the User
		// before applying any `<data key>`. So the device always has the key,
		// and a condition on it must behave the same in Preview.
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.session.user.user_type).toBe("standard");
		expect(identity?.session.user.user_type).not.toBe("demo");
	});

	it("leaves location keys absent from the SESSION block while nobody is assigned", () => {
		// `get_user_session_data` writes all three or none.
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		for (const key of [
			"commcare_location_id",
			"commcare_location_ids",
			"commcare_primary_case_sharing_id",
		]) {
			expect(identity?.session.user).not.toHaveProperty(key);
		}
	});

	it("carries the location keys EMPTY on the usercase, where HQ writes them unconditionally", () => {
		// The asymmetry that is easy to get backwards:
		// `_get_user_case_fields` takes an `else` branch to `''` for all three
		// rather than omitting them, so the usercase has the keys and the
		// session block does not.
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		for (const key of [
			"commcare_location_id",
			"commcare_location_ids",
			"commcare_primary_case_sharing_id",
		]) {
			expect(identity?.usercase[key]).toBe("");
		}
	});

	it("projects assigned places primary-first into both location vocabularies", () => {
		const assigned = {
			...ASHA_PERSONA,
			locations: {
				primaryUuid: CLINIC,
				additionalUuids: [NORTH],
			},
		};
		const identity = previewAsPersona(FULL_USER, assigned, DOC);
		for (const projection of [identity?.session.user, identity?.usercase]) {
			expect(projection?.commcare_location_id).toBe(CLINIC);
			expect(projection?.commcare_location_ids).toBe(`${CLINIC} ${NORTH}`);
			expect(projection?.commcare_primary_case_sharing_id).toBe(CLINIC);
		}
	});

	it("supplies the two framework keys it genuinely knows", () => {
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		expect(identity?.session.user.commcare_user_type).toBe("commcare");
		expect(identity?.session.user.commcare_profile).toBe("");
	});

	it("binds session/context/userid to the acting worker", () => {
		expect(
			previewAsPersona(FULL_USER, ASHA_PERSONA, DOC)?.session.context.userid,
		).toBe(ASHA);
		expect(previewAsMe(FULL_USER, DOC)?.session.context.userid).toBe(
			FULL_USER.id,
		);
	});
});

describe("the session block and the usercase are two projections", () => {
	it("shares the authored data and differs in built-in keys", () => {
		const identity = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		// The same worker's authored data, either way.
		expect(identity?.session.user.region).toBe("south");
		expect(identity?.usercase.region).toBe("south");
		// The registration block prefixes its own keys; the usercase does not.
		expect(identity?.session.user.commcare_first_name).toBe("Asha");
		expect(identity?.session.user).not.toHaveProperty("first_name");
		expect(identity?.usercase.first_name).toBe("Asha");
		expect(identity?.usercase.last_name).toBe("Kumar");
		expect(identity?.usercase).not.toHaveProperty("commcare_first_name");
		expect(identity?.usercase.hq_user_id).toBe(ASHA);
	});

	it("preserves valid prototype-named slugs as own data properties", () => {
		const propertyProto = testUuid("property-proto");
		const propertyConstructor = testUuid("property-constructor");
		const roleUuid = testUuid("constructor");
		const persona = {
			uuid: testUuid("persona-hostile-slugs"),
			name: "Asha",
			userTypeUuid: roleUuid,
		};
		const doc: UserCollections = {
			userProperties: Object.fromEntries([
				[
					propertyProto,
					{ uuid: propertyProto, slug: "__proto__", label: "Prototype" },
				],
				[
					propertyConstructor,
					{
						uuid: propertyConstructor,
						slug: "constructor",
						label: "Constructor",
					},
				],
			]),
			userTypes: Object.fromEntries([
				[
					roleUuid,
					{
						uuid: roleUuid,
						name: "Constructor role",
						values: Object.fromEntries([
							[propertyProto, "proto value"],
							[propertyConstructor, "constructor value"],
						]),
					},
				],
			]),
		};

		const identity = previewAsPersona(FULL_USER, persona, doc);
		for (const projection of [identity?.session.user, identity?.usercase]) {
			expect(Object.hasOwn(projection ?? {}, "__proto__")).toBe(true);
			expect(
				Object.getOwnPropertyDescriptor(projection ?? {}, "__proto__")?.value,
			).toBe("proto value");
			expect(Object.hasOwn(projection ?? {}, "constructor")).toBe(true);
			expect(projection?.constructor).toBe("constructor value");
		}
	});
});

describe("previewSessionValues", () => {
	it("projects an identity to its session values", () => {
		const identity = previewAsMe(FULL_USER);
		expect(previewSessionValues(identity)).toBe(identity?.session);
	});

	it("yields the anonymous projection without an identity", () => {
		const anonymous = previewSessionValues(null);
		expect(anonymous.context).toEqual({
			deviceid: "nova-preview",
			appversion: "preview",
		});
		expect(anonymous.user).toEqual({});
	});
});

describe("samePreviewIdentity", () => {
	it("treats a re-derived identity from the same user as identical", () => {
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER }),
			),
		).toBe(true);
	});

	it("distinguishes a different worker or changed profile", () => {
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER, id: "worker-43" }),
			),
		).toBe(false);
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER),
				previewAsMe({ ...FULL_USER, name: "Amina D." }),
			),
		).toBe(false);
	});

	it("distinguishes two personas of the same member", () => {
		const asha = previewAsPersona(FULL_USER, ASHA_PERSONA, DOC);
		const bimal = previewAsPersona(
			FULL_USER,
			{ uuid: testUuid("55555555-5555-4555-8555-555555555555"), name: "Bimal" },
			DOC,
		);
		expect(samePreviewIdentity(asha, bimal)).toBe(false);
		expect(
			samePreviewIdentity(asha, previewAsPersona(FULL_USER, ASHA_PERSONA, DOC)),
		).toBe(true);
	});

	it("distinguishes previewing as yourself from previewing as a persona", () => {
		expect(
			samePreviewIdentity(
				previewAsMe(FULL_USER, DOC),
				previewAsPersona(FULL_USER, ASHA_PERSONA, DOC),
			),
		).toBe(false);
	});

	it("treats null as equal only to null", () => {
		expect(samePreviewIdentity(null, null)).toBe(true);
		expect(samePreviewIdentity(previewAsMe(FULL_USER), null)).toBe(false);
		expect(samePreviewIdentity(null, previewAsMe(FULL_USER))).toBe(false);
	});
});
