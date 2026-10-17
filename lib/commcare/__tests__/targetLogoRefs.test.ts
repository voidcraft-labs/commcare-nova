/**
 * Which `logo_refs` an update sends, by the shape of the dict the target
 * holds. Pure; what HQ's import, uploader and linked-app pull do with the
 * result is the proof lane's (`proof/hq/test_logos.py`,
 * `proof/views/test_linked_logos.py`).
 */
import { describe, expect, it } from "vitest";
import { withoutPathOnlyLogoRefs } from "../targetLogoRefs";

/** The ten keys HQ's uploader stores for a slot
 * (`hqmedia/models.py::CommCareImage.get_media_info`). */
function uploaderEntry(path: string) {
	return {
		path,
		uid: "a1b2c3",
		m_id: "e9f8d7c6b5a4",
		url: "/hq/multimedia/file/CommCareImage/e9f8d7c6b5a4/",
		updated: false,
		original_path: null,
		icon_class: "fa fa-picture-o",
		media_type: "Image",
		humanized_content_length: "4.2 KB",
		image_size: "64 x 64",
	};
}

describe("withoutPathOnlyLogoRefs", () => {
	it("takes out every entry when the dict holds path-only entries alone", () => {
		expect(
			withoutPathOnlyLogoRefs({
				hq_logo_web_apps: { path: "jr://file/commcare/abc.png" },
			}),
		).toEqual({});
	});

	it("leaves the key out when the dict holds uploader entries alone", () => {
		expect(
			withoutPathOnlyLogoRefs({
				hq_logo_web_apps: uploaderEntry("jr://file/commcare/logo/data/w.png"),
				hq_logo_android_home: uploaderEntry(
					"jr://file/commcare/logo/data/h.png",
				),
			}),
		).toBeNull();
	});

	it("keeps every uploader entry whole beside a path-only entry it takes out", () => {
		const home = uploaderEntry("jr://file/commcare/logo/data/h.png");
		expect(
			withoutPathOnlyLogoRefs({
				hq_logo_web_apps: { path: "jr://file/commcare/abc.png" },
				hq_logo_android_home: home,
			}),
		).toEqual({ hq_logo_android_home: home });
	});

	it("leaves the key out when the dict is empty", () => {
		expect(withoutPathOnlyLogoRefs({})).toBeNull();
	});

	it("takes out a path-only entry in an Android slot", () => {
		const web = uploaderEntry("jr://file/commcare/logo/data/w.png");
		expect(
			withoutPathOnlyLogoRefs({
				hq_logo_web_apps: web,
				hq_logo_android_login: { path: "jr://file/commcare/abc.png" },
			}),
		).toEqual({ hq_logo_web_apps: web });
	});
});
