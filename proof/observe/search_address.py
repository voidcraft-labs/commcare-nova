"""Stock HQ setup and wire checks shared by the address-default witnesses."""

from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile

from lxml import etree

from proof.hq import operations
from proof.observe import casedata


def enable_address_search(config):
    return replace(
        config, privileges=config.privileges | {"CLOUDCARE", "GEOCODER"},
        flags=config.flags | {"CASE_SEARCH_ADVANCED"},
    )


def save_address_default(project, change):
    """Use the matrix's exact non-excluded prompt, with no attached receiver."""
    from corehq.apps.app_manager.models.case_search import CaseSearchProperty

    app = operations.held_app(project.unit, project.app_id)
    menu = app.modules[0]
    assert change["pointer"] == "/modules/0/search_config/properties/1"
    assert menu.search_config.properties[1].name == "village"
    menu.search_config.properties[1] = CaseSearchProperty.wrap(dict(change["value"]))
    app.cloudcare_enabled = True
    app.save()
    return menu.unique_id


def address_default_database(document):
    database = casedata.document_case_database(document)
    original = next(case for case in database.cases if case.case_type == "client")
    properties = dict(original.properties)
    properties.update(client_name="Amina", last_visit="2025-12-01")
    return replace(database, cases=(replace(original, name="Amina", properties=tuple(properties.items())),))


def built_address_default(archive):
    with ZipFile(BytesIO(archive)) as zipped:
        suite = etree.fromstring(zipped.read("suite.xml"))
    prompts = suite.xpath(".//query/prompt[@key='village'][@input='address']")
    assert prompts, "HQ emitted no address picker for the saved Village field"
    held = {(prompt.getparent().get("storage-instance"), prompt.get("default"), prompt.get("exclude")) for prompt in prompts}
    (storage, default, exclude), = held
    assert default == "'Old address'" and exclude is None, held
    assert storage
    return {"storage": storage, "default": default, "exclude": exclude}
