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
            assert selected[KEY] == ORIGINAL
