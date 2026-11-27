"""Check the actual HQ media package for a translated menu recording."""

from lxml import etree

from proof.checks.compare.app_strings import parse_app_strings


def test_a_menu_audio_override_needs_an_ordinary_carrier(hq, webapps_documents, evidence):
    """HQ keeps the English locale's file name while pruning an unused recording."""
    from proof.hq import operations
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.webapps import hq as webapps_hq

    document = webapps_documents["hq-media"]
    key = "modules.m0.audio"
    path = "jr://file/commcare/audio/data/animal_name.mp3"
    observed = {}
    for carrier in [None, "en", "fr"]:
        with webapps_hq.authored_project(document, "A") as project:
            author = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
            registry.named_change("menu_audio_override_with_only_a_map_entry")(author, project.app_id)
            if carrier is not None:
                ops.set_json(author, project.app_id, "/langs", ["en", "fr"])
                ops.set_json(author, project.app_id, "/modules/0/forms/0/media_audio", {carrier: path})
            native = operations.held_app(project.unit, project.app_id)
            locale = parse_app_strings(native.create_app_strings("en"))[key]
            mapped_kind = native.multimedia_map[path].media_type
            media_suite = etree.fromstring(native.create_media_suite())
            packaged = any(
                location.endswith("/data/animal_name.mp3")
                for location in media_suite.xpath("./media/resource/location/text()")
            )
            observed[str(carrier)] = {
                "locale": locale,
                "packaged": packaged,
                "mapping": mapped_kind,
            }
            assert mapped_kind == "CommCareAudio"
            assert locale == path
            assert packaged == (carrier is not None), observed
    evidence("ordinary-nav-audio-carrier", observed)
