"""Native HQ locale precedence for an app-owned image override."""

from proof.checks.compare.app_strings import parse_app_strings
from proof.rules.conftest import edited, published


KEY = "modules.m0.icon"
ORIGINAL = "jr://file/commcare/image/original.png"
OVERRIDE = "jr://file/commcare/image/translated.png"


def test_generated_icon_override_keeps_the_unmodified_map_and_named_fallback(hq, documents):
    def configure(body):
        body["langs"] = ["en", "fra", "es"]
        body["build_profiles"] = {
            "field": {"name": "Field", "langs": ["fra", "es"]}
        }
        body["modules"][0]["media_image"] = {"en": ORIGINAL, "fra": ""}
        body["translations"].setdefault("en", {})[KEY] = OVERRIDE

    with published(documents["case-list-inline"], None, configuration="maximum") as app:
        with app.unit.fork():
            app._write(edited(configure))
            native = app._app()
            assert native.modules[0].media_image == {"en": ORIGINAL, "fra": ""}
            assert native.translations["en"][KEY] == OVERRIDE
            assert parse_app_strings(native.create_app_strings("en"))[KEY] == OVERRIDE
            assert not parse_app_strings(native.create_app_strings("fra")).get(KEY)
            assert not parse_app_strings(native.create_app_strings("es")).get(KEY)
            default = parse_app_strings(native.create_app_strings("default"))
            assert default[KEY] == OVERRIDE
            selected = parse_app_strings(native.create_app_strings("default", "field"))
            assert KEY not in selected
            assert not native.modules[0].uses_image("field")
            assert ORIGINAL in native.all_media_paths(lang="en")
            assert OVERRIDE not in native.all_media_paths()


def test_the_override_file_reaches_hq_media_only_through_its_ordinary_carrier(hq, documents):
    def configure(body):
        body["modules"][0]["media_image"] = {"en": ORIGINAL}
        body["modules"][0]["forms"][0]["media_image"] = {"en": OVERRIDE}
        body["translations"].setdefault("en", {})[KEY] = OVERRIDE

    with published(documents["case-list-inline"], None, configuration="maximum") as app:
        with app.unit.fork():
            app._write(edited(configure))
            native = app._app()
            assert parse_app_strings(native.create_app_strings("en"))[KEY] == OVERRIDE
            assert {ORIGINAL, OVERRIDE} <= native.all_media_paths(lang="en")



def test_named_packages_follow_exact_paths_even_when_hq_maps_them_to_one_file(hq, documents):
    def configured(ordinary_language):
        def configure(body):
            body["langs"] = ["en", "fr"]
            body["modules"][0]["media_image"] = {"en": ORIGINAL}
            body["modules"][0]["forms"][0]["media_image"] = (
                {} if ordinary_language is None else {ordinary_language: OVERRIDE}
            )
            body["translations"].setdefault("en", {})[KEY] = OVERRIDE
            body["multimedia_map"] = {
                path: {
                    "doc_type": "HQMediaMapItem",
                    "media_type": "CommCareImage",
                    "multimedia_id": "a" * 32,
                    "unique_id": character * 32,
                    "version": None,
                }
                for path, character in ((ORIGINAL, "b"), (OVERRIDE, "c"))
            }
        return edited(configure)

    with published(documents["case-list-inline"], None, configuration="maximum") as app:
        for ordinary_language in (None, "fr", "en"):
            with app.unit.fork():
                app._write(configured(ordinary_language))
                native = app._app()
                assert native.multimedia_map[ORIGINAL].multimedia_id == native.multimedia_map[OVERRIDE].multimedia_id
                assert parse_app_strings(native.create_app_strings("en"))[KEY] == OVERRIDE
                needed = native.all_media_paths(lang="en")
                assert ORIGINAL in needed
                assert (OVERRIDE in needed) == (ordinary_language == "en")
                assert (OVERRIDE in native.all_media_paths()) == (ordinary_language is not None)
