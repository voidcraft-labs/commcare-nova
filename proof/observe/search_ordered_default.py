"""The stock HQ prompt and saved query used by both native worker witnesses."""

from dataclasses import replace
from io import BytesIO
from zipfile import ZipFile

from lxml import etree

from proof.hq import operations
from proof.matrix import ops, registry
from proof.matrix.authoring import Authoring
from proof.observe.search_address import address_default_database

USERNAME = "instance('commcaresession')/session/context/username"
LITERAL = "'south'"
COERCED = f"if(number({USERNAME}) > number('m'), 'north', 'south')"
SOUTH = "ordered-default-south"
NORTH = "ordered-default-north"


def ordered_default_variant():
    return next(
        row for row in registry.load_variants()
        if row.id == "hq-search/starting-value-of-an-ordered-text"
    )


def save_ordered_default(project, variant, expression):
    author = Authoring(project.unit, {}, project.document.id, operation=project.unit.operation)
    ops.set_json(
        author, project.app_id, variant.change["pointer"],
        {**variant.change["value"], "default_value": expression},
    )
    app = operations.held_app(project.unit, project.app_id)
    app.cloudcare_enabled = True
    app.save()


def query_scope(archive, expression):
    with ZipFile(BytesIO(archive)) as release:
        suite = etree.fromstring(release.read("suite.xml"))
    prompts = suite.xpath(".//query/prompt[@key='village'][@default=$default]", default=expression)
    assert prompts, expression
    return [
        {
            "default": prompt.get("default"),
            "instance": prompt.getparent().get("storage-instance"),
            "declared": prompt.xpath("ancestor::entry//instance/@id"),
        }
        for prompt in prompts
    ]


def ordered_default_database(document):
    database = address_default_database(document)
    source, = database.cases
    cases = tuple(
        replace(source, case_id=case_id, properties=tuple({**dict(source.properties), "village": region}.items()))
        for case_id, region in ((SOUTH, "south"), (NORTH, "north"))
    )
    return replace(database, cases=cases)
