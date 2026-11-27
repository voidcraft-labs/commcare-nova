"""Check the actual HQ media package for a translated menu recording."""

from lxml import etree

from proof.checks.compare.app_strings import parse_app_strings


def test_a_menu_audio_override_needs_an_ordinary_carrier(hq, webapps_documents, evidence):
    """HQ keeps the English locale's file name while pruning an unused recording."""
    from dataclasses import replace

    from corehq import privileges
    from corehq.apps.accounting import utils as accounting

    from proof.hq import operations
    from proof.matrix import ops, registry
    from proof.matrix.authoring import Authoring
    from proof.webapps import hq as webapps_hq

    document = webapps_documents["hq-media"]
    key = "modules.m0.audio"
    path = "jr://file/commcare/audio/data/animal_name.mp3"
    observed = {}

    def with_build_profiles(configuration):
        return replace(configuration, privileges=configuration.privileges | {"BUILD_PROFILES"})

    for carrier in [None, "en", "fr"]:
        with webapps_hq.authored_project(document, "A", configure=with_build_profiles) as project:
            assert accounting.domain_has_privilege(project.unit.domain, privileges.BUILD_PROFILES)
            author = Authoring(project.unit, {}, document.id, operation=project.unit.operation)
            registry.named_change("menu_audio_override_with_only_a_map_entry")(author, project.app_id)
            if carrier is not None:
                ops.set_json(author, project.app_id, "/langs", ["en", "fr"])
                ops.set_json(author, project.app_id, "/modules/0/forms/0/media_audio", {carrier: path})
            profiles = {
                "both": {"doc_type": "BuildProfile", "name": "Both", "langs": ["en", "fr"]},
                "english": {"doc_type": "BuildProfile", "name": "English", "langs": ["en"]},
            }
            if carrier is not None:
                ops.set_json(author, project.app_id, "/build_profiles", profiles)
            native = operations.held_app(project.unit, project.app_id)
            locale = parse_app_strings(native.create_app_strings("en"))[key]
            if carrier is not None:
                for profile, expected in profiles.items():
                    assert native.get_build_langs(profile) == expected["langs"]
                    assert parse_app_strings(native.create_app_strings("en", profile))[key] == path
            # Without BUILD_PROFILES, HQ ignores profile languages when it packs media.
            mapped_kind = native.multimedia_map[path].media_type
            def packaged(profile=None):
                media_suite = etree.fromstring(native.create_media_suite(build_profile_id=profile))
                return any(
                    location.endswith("/data/animal_name.mp3")
                    for location in media_suite.xpath("./media/resource/location/text()")
                )

            included = packaged()
            named_packages = {profile: packaged(profile) for profile in profiles} if carrier else {}
            observed[str(carrier)] = {
                "locale": locale,
                "packaged": included,
                "mapping": mapped_kind,
                "namedPackages": named_packages,
            }
            assert mapped_kind == "CommCareAudio"
            assert locale == path
            assert included == (carrier is not None), observed
            if carrier is not None:
                assert named_packages == {"both": True, "english": carrier == "en"}, observed
    evidence("ordinary-nav-audio-carrier", observed)
