"""HQ's side of the native proofs, on the harness's shared boot, state and seams.

``native_check`` opens one ``proof.hq.check.hq_check`` for a project space
the proof names: its domain, the flags and privileges HQ answers on, and the
CommCare version HQ builds at (``NATIVE_COMMCARE_VERSION``, which HQ reads as
its default build through the check's build configuration). Everything else
HQ reads from outside its state goes through the seams ``hq_check`` opens:
every flag not named is off, every privilege not named is refused,
Formplayer's form validation is the Core runner, Elasticsearch is HQ's own
server held to the unit (``proof.hq.elasticsearch``), and Couch, Redis and the
network are the harness's.

The rest are HQ's own calls the proofs share: importing an app the way
``Application.from_source`` does, regenerating a form's case and meta blocks,
and the suite contributors the proofs assemble by hand.
"""

import hashlib
import json
import subprocess
from contextlib import ExitStack, contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from proof.hq.boot import HQ_ROOT
from proof.hq.check import hq_check
from proof.hq.configuration import Configuration
from proof.hq.state import FORMPLAYER

# The CommCare version the native proofs build Nova's exports at (HQ's
# default build spec for the check's project space).
NATIVE_COMMCARE_VERSION = "2.53.0"
# The server Nova's exports target. HQ writes its own address into the remote
# requests it builds (view_utils.absolute_reverse -> dimagi/utils/web.py::get_url_base).
NOVA_SERVER_ORIGIN = "https://www.commcarehq.org"


@contextmanager
def hq_server_origin(origin: str):
    """HQ's own address (``DEFAULT_PROTOCOL`` and ``BASE_ADDRESS``) is ``origin`` inside the block."""
    from django.test import override_settings

    parts = urlsplit(origin)
    with override_settings(DEFAULT_PROTOCOL=parts.scheme, BASE_ADDRESS=parts.netloc):
        yield


@contextmanager
def native_check(
    domain: str,
    *,
    validate=FORMPLAYER,
    flags=(),
    privileges=(),
    commcare_version: str = NATIVE_COMMCARE_VERSION,
    server_origin: str | None = None,
):
    """One HQ check for the named project space; yields ``(state, record)``."""
    configuration = Configuration(
        flags=frozenset(flags),
        privileges=frozenset(privileges),
        commcare_version=commcare_version,
        domain=domain,
    )
    with hq_check(configuration, validate=validate) as (state, record), ExitStack() as stack:
        if server_origin is not None:
            stack.enter_context(hq_server_origin(server_origin))
        yield state, record


def import_source(raw: bytes, domain: str):
    """The app HQ makes of an exported app source (``Application.from_source``)."""
    from corehq.apps.app_manager.models import Application

    return Application.from_source(json.loads(raw), domain)


def regenerate_form(form, domain: str) -> bytes:
    """The form's source with HQ's case and meta blocks, as HQ's build writes them before rendering."""
    from corehq.apps.app_manager.xform import XForm
    from lxml import etree

    xform = XForm(form.source, domain=domain)
    xform.add_case_and_meta(form)
    xform.strip_vellum_ns_attributes()
    return etree.tostring(xform.xml)


def hand_assembled_suite(app, *, remote_requests: bool = True, endpoints: bool = False) -> bytes:
    """HQ's detail, entry and menu contributors and the post-processors the proofs name, serialized.

    This is part of ``SuiteGenerator.generate_suite``, assembled as the native
    proofs have always assembled it: details, then each module's entries and
    menus, then remote requests (optional), endpoints (optional), workflow and
    instances.
    """
    from corehq.apps.app_manager.suite_xml.generator import SuiteGenerator
    from corehq.apps.app_manager.suite_xml.post_process.endpoints import EndpointsHelper
    from corehq.apps.app_manager.suite_xml.post_process.instances import InstancesHelper
    from corehq.apps.app_manager.suite_xml.post_process.remote_requests import RemoteRequestsHelper
    from corehq.apps.app_manager.suite_xml.post_process.workflow import WorkflowHelper
    from corehq.apps.app_manager.suite_xml.sections.details import DetailContributor
    from corehq.apps.app_manager.suite_xml.sections.entries import EntriesContributor
    from corehq.apps.app_manager.suite_xml.sections.menus import MenuContributor

    generator = SuiteGenerator(app)
    details = generator.add_section(DetailContributor)
    entries = EntriesContributor(generator.suite, app, generator.modules, None)
    menus = MenuContributor(generator.suite, app, generator.modules, None)
    for module in generator.modules:
        generator.suite.entries.extend(entries.get_module_contributions(module))
        generator.suite.menus.extend(menus.get_module_contributions(module, None))
    if remote_requests:
        RemoteRequestsHelper(generator.suite, app, generator.modules).update_suite(details)
    if endpoints:
        EndpointsHelper(generator.suite, app, generator.modules).update_suite()
    WorkflowHelper(generator.suite, app, generator.modules).update_suite()
    InstancesHelper(generator.suite, app, generator.modules).update_suite()
    return generator.suite.serializeDocument(pretty=True)


def known_app_strings(app, lang: str) -> str:
    """HQ's authored app strings for ``lang`` with no stock UI translation catalog."""
    from corehq.apps.app_manager.app_strings import SelectKnownAppStrings

    return SelectKnownAppStrings(lambda *_args, **_kwargs: {}).create_app_strings(app, lang)


XPATH_PARSER = Path(__file__).resolve().parent / "xpath_instances.mjs"
XFORMS = "http://www.w3.org/2002/xforms"


class UnreadableExpression(AssertionError):
    """An XML XPath carrier that HQ's pinned parser cannot read completely."""


def parse_xpaths(values):
    """One deduplicated batch through HQ's parser: each value's structure and instance reads.

    A parse failure or an unhandled parser model fails the comparison. This
    reads the pinned parser's semantic fields; neither Nova's serializer nor
    HQ's XPath printer participates. The only tree normalization is the wire
    rule's ordered same-AND or same-OR operands; mixed Boolean and every
    other operator retain their grouping.
    """
    values = sorted(set(values))
    if not values:
        return {}
    finished = subprocess.run(
        ["node", str(XPATH_PARSER)],
        input=json.dumps(values).encode(),
        capture_output=True,
        timeout=60,
        check=False,
    )
    if finished.returncode != 0:
        raise RuntimeError(
            f"HQ's XPath parser (js-xpath, through {XPATH_PARSER.name}) could not read the XML's XPath values: "
            f"node exited with status {finished.returncode}.\n{finished.stderr.decode(errors='replace')}"
        )
    results = dict(zip(values, json.loads(finished.stdout), strict=True))
    unreadable = {value: result["error"] for value, result in results.items() if "error" in result}
    if unreadable:
        raise UnreadableExpression(
            "HQ's XPath parser (js-xpath) could not completely read these XPath attributes. The comparison "
            "cannot establish their structure or instance reads:\n"
            + "\n".join(f"  {value!r}: {message}" for value, message in sorted(unreadable.items()))
        )
    return results


def xpath_attributes(element):
    """The finite XPath carriers these native comparisons read, from Core's parsers.

    Unknown positions remain exact XML values. In particular, a stack
    query's value is a URL, a datum's maximum is an integer, and instance
    declarations and their data never become XPath. Parent checks keep
    identically named ordinary attributes out of this set.
    """
    tag = element.tag
    parent = element.getparent()
    parent_tag = None if parent is None else parent.tag
    if any(ancestor.tag in {"instance", "fixture", f"{{{XFORMS}}}instance"} for ancestor in element.iterancestors()):
        return {}
    if tag == f"{{{XFORMS}}}bind":
        # XFormParser.parseBind: the reference and the five expression attributes.
        names = {"nodeset", "calculate", "constraint", "relevant", "required", "readonly"}
    elif tag == "xpath" and parent_tag == "text":
        names = {"function"}  # TextParser.parseXPath
    elif tag in {"datum", "instance-datum", "form"} and parent_tag == "session":
        # SessionDatumParser.parse: a function takes precedence over selection.
        names = {"function"} if "function" in element.attrib else {"nodeset", "value"}
    elif tag in {"datum", "instance-datum", "command", "rewind", "mark"} and parent_tag in {"create", "push"}:
        names = {"value"}  # StackFrameStepParser.parseValue; query@value is a URL.
    elif tag in {"create", "push", "clear"} and parent_tag == "stack":
        names = {"if"}  # StackOpParser.parse
    elif tag == "data" and parent_tag in {"query", "post"}:
        names = {"ref", "nodeset", "exclude"}  # QueryDataParser.parse
    elif tag == "prompt" and parent_tag == "query":
        names = {"default", "exclude", "required"}  # QueryPromptParser.parse
    elif tag in {"required", "validation"} and parent_tag == "prompt":
        names = {"test"}  # QueryPromptParser.parseRequiredBlock / parseValidationBlock
    elif tag == "itemset" and parent_tag == "prompt":
        names = {"nodeset"}  # QueryPromptParser.parseItemset
    elif tag in {"label", "value", "sort"} and parent_tag == "itemset":
        names = {"ref"}  # QueryPromptParser.parseItemset
    elif tag == "assert" and parent_tag == "assertions":
        names = {"test"}  # AssertionSetParser.parse
    elif tag == "menu":
        names = {"relevant"}  # MenuParser.parse
    elif tag == "command" and parent_tag == "menu":
        names = {"relevant"}  # MenuParser.parse
    elif tag == "post" and parent_tag in {"entry", "remote-request", "view"}:
        names = {"relevant"}  # EntryParser.parsePost
    elif tag == "detail":
        names = {"nodeset", "relevant"}  # DetailParser.parse
    elif tag == "field" and parent_tag == "detail":
        names = {"relevant"}  # DetailFieldParser.parse
    elif tag == "action" and parent_tag == "detail":
        names = {"relevant", "auto_launch"}  # ActionParser.parse
    elif tag in {"group", "focus"} and parent_tag == "detail":
        names = {"function"}  # DetailGroupParser.parse / DetailParser.parse
    elif parent_tag == "variables" and parent.getparent() is not None and parent.getparent().tag == "detail":
        names = {"function"}  # DetailParser.parse: variables' child names are authored.
    else:
        names = set()
    return {name: value for name, value in element.attrib.items() if name in names}


def parse_xml_xpaths(*roots, values=()):
    """Parse known XML carriers and any directly observed expressions in one batch."""
    return parse_xpaths(
        [
            *values,
            *(value for root in roots for node in root.iter() for value in xpath_attributes(node).values()),
        ]
    )


def attributes(element, parsed):
    """Every attribute, with only known XPath carriers replaced by their complete parse structure."""
    expressions = xpath_attributes(element)
    return {
        name: ("xpath", parsed[value]["structure"]) if name in expressions else value
        for name, value in element.attrib.items()
    }


def shape(element, parsed):
    """An element's complete ordered XML, comparing XPath syntax through HQ's parse tree.

    All ordinary attributes, literal contents, leaf text, meaningful mixed
    text and child order survive. Only attribute order and newline indentation
    in element-only content are ignored. Instance declarations are ordinary
    children: this function never adds, removes or sorts them.
    """
    texts = [element.text or "", *(child.tail or "" for child in element)]
    element_only = len(element) > 0 and all(not text.strip() for text in texts)

    def content(value):
        value = value or ""
        if element_only and not value.strip() and ("\n" in value or "\r" in value):
            return ""
        return value

    return (
        element.tag,
        attributes(element, parsed),
        content(element.text),
        [(shape(child, parsed), content(child.tail)) for child in element],
    )


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hq_commit() -> str:
    return subprocess.check_output(["git", "-C", str(HQ_ROOT), "rev-parse", "HEAD"], text=True).strip()


def hq_source_hashes(paths):
    return {path: sha256((Path(HQ_ROOT) / path).read_bytes()) for path in paths}


def write_evidence(directory: Path, name: str, evidence: dict) -> Path:
    """Write a proof's evidence record (what ran, on which inputs, with which result) beside its artifacts."""
    path = directory / f"{name}.evidence.json"
    path.write_text(json.dumps(evidence, indent=2, default=str) + "\n")
    return path
