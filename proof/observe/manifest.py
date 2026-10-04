"""What HQ and Core make of every export Nova sends for a document, for the manifest check.

The manifest check (``proof.checks.manifest_usage``) holds Nova's exports to
the manifest: every surface item an export uses must be named by an entry.
Which items an export uses is read from its parsed artifacts by the
surface's own rules, and that is the judge's. What a consumer makes of an
artifact is observed here: HQ's question reader, Core's XPath parser and
lexer, the strings a search's CSQL can send, and HQ's CSQL parser.

It is observed once per document, with the document's ``local`` part
(``observe_local``, which ``proof.observe.unit.observe_local`` calls), since
none of it reads HQ's state: an export is used whether or not HQ accepts it.
The record holds:

- ``uploads``: the app JSON each of Nova's publishes sends (the ``app_file``
  field of the captured request), by ``<configuration>/create``,
  ``<configuration>/republish`` and ``edit/<configuration>/update``, each a
  blob;
- ``archives``: the entries of each local archive the manifest reads
  (``read_entry``: the suites, the profile, each language's app strings and
  each form), by archive and entry name, each a blob;
- ``readings``: a blob of what the consumers make of those (``readings``):
  ``questions``, HQ's ``XForm.get_questions`` of each form by the sha256 of
  its bytes (``{"questions": [[type, path], ...]}``, or ``{"unreadable":
  <HQ's refusal>}``); ``expressions``, Core's ``xpathParse`` of every
  attribute value of every form, suite and profile, and of every expression
  the app JSON's expression slots hold (``APP_EXPRESSION_SLOTS``), by its
  text; ``strings``, Core's ``xpathStrings`` of every search's
  ``_xpath_query`` (a suite's query data and the app JSON's default search
  property), by its text; ``csql``, HQ's CSQL parser over each of those
  strings, by the string (with what each comparison holds on either side,
  ``comparison_side``); ``trees``, HQ's XPath grammar's structure of each
  load-time setvalue's value, each repeat count and each bind calculate of
  a form (and each relevance of one that holds a model iteration), each
  expression Core's parse reads a call, step or comparison in whose parts a
  value class reads (``structure_read``), and what a required condition
  Vellum reads is compared with (the ``required`` beside it, the XPath each
  of the form's hashtags stands for), by its text (``expression_tree``,
  ``structure_tables``); ``conditions``, that grammar's structure of each
  ``vellum:requiredCondition``, its hashtags read as Vellum's parser reads
  them (``hashtag_tree``); and ``media``, what each media file a local
  archive holds is, by its path in the archive (``media_facts``);
- ``softAssertions``: every note HQ made while it read them, where it made
  any.

Which attribute values Core parses as XPath is the surface's to say, so every
attribute value is read through Core's parser (its error, where it is no
expression, is recorded by the exception's class alone: Core's messages
hold JVM identity hashes), and the judge reads the ones the surface names.
What this reads beyond the local part's own archives is what ``inputs``
declares: each captured publish request.
"""

from __future__ import annotations

import hashlib
import json
import zipfile
from functools import cache

from lxml import etree

from proof.observe.intent import FORM_FILE

# The query data key whose value HQ's search parses as CSQL (case_search/models.py::CASE_SEARCH_XPATH_QUERY_KEY).
XPATH_QUERY_KEY = "_xpath_query"
# What a CSQL string holds where its expression reads a value only the run time knows: a name, so it stays
# CSQL whether the expression quotes it or not.
CSQL_HOLE = "proofvalue"
# The argument of HQ's within-distance that names its unit (query_functions.py::within_distance).
DISTANCE_FUNCTION, DISTANCE_UNIT_ARGUMENT = "within-distance", 3
RUNTIME_FILES = ("suite.xml", "media_suite.xml", "profile.ccpr")
XFORMS = "http://www.w3.org/2002/xforms"
XHTML = "http://www.w3.org/1999/xhtml"
JAVAROSA = "http://openrosa.org/javarosa"
VELLUM = "http://commcarehq.org/xforms/vellum"
DEADLINE = 120.0


def read_entry(name):
    """Whether the manifest reads an archive entry: a suite, the profile, a language's app strings, or a form."""
    return name in RUNTIME_FILES or name.endswith("/app_strings.txt") or FORM_FILE.fullmatch(name) is not None


def uploads_of(document):
    """Each captured publish request of the document: ``[(key, Captured, its sidecar's path)]``, in key order."""
    found = []
    for name, export in sorted(document.exports.items()):
        for step, captured in (("create", export.create), ("republish", export.republish)):
            found.append((f"{name}/{step}", captured, export.directory / f"{step}.json"))
    if document.edit is not None:
        for name, export in sorted(document.edit.exports.items()):
            found.append((f"edit/{name}/update", export.update, export.directory / "update.json"))
    return found


def _file(document, path):
    return {
        "path": path.relative_to(document.root).as_posix(),
        "digest": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def inputs(document, state):
    """What this observation reads beyond the local part's archives: each captured publish request (its body
    and the sidecar naming its content type)."""
    found = {}
    for key, captured, sidecar in uploads_of(document):
        found[f"{key}.body"] = _file(document, captured.body_path)
        found[f"{key}.json"] = _file(document, sidecar)
    return found


# What the consumers read ------------------------------------------------------------


def _parsed(xml):
    """The XML's root, or None where it is not well-formed (the judge reports that)."""
    try:
        return etree.fromstring(xml, etree.XMLParser(resolve_entities=False, no_network=True))
    except etree.XMLSyntaxError:
        return None


def attribute_values(root, found):
    """Every attribute value in the tree that holds more than white space, into ``found``."""
    for element in root.iter():
        if isinstance(element.tag, str):
            for value in element.attrib.values():
                if value.strip():
                    found.add(value)


def suite_queries(root, found):
    """Each ``_xpath_query`` a suite's search sends (a query's ``data`` element's ``ref``), into ``found``."""
    for element in root.iter():
        if not isinstance(element.tag, str) or etree.QName(element).localname != "data":
            continue
        parent = element.getparent()
        if parent is None or not isinstance(parent.tag, str) or etree.QName(parent).localname != "query":
            continue
        ref = element.get("ref")
        if element.get("key") == XPATH_QUERY_KEY and ref is not None and ref.strip():
            found.add(ref)


def app_queries(value, found):
    """Each ``_xpath_query`` default search property an app JSON holds, at any depth, into ``found``."""
    if isinstance(value, dict):
        default = value.get("defaultValue")
        if value.get("property") == XPATH_QUERY_KEY and isinstance(default, str) and default.strip():
            found.add(default)
        for child in value.values():
            app_queries(child, found)
    elif isinstance(value, list):
        for child in value:
            app_queries(child, found)


def app_forms(app):
    """The XForm source of each form an app JSON's modules hold, as bytes (by its form's ``unique_id``)."""
    if not isinstance(app, dict):
        return []
    sources = app.get("_attachments") or {}
    found = []
    for module in app.get("modules") or []:
        for form in (module or {}).get("forms") or []:
            source = sources.get(f"{(form or {}).get('unique_id')}.xml")
            if isinstance(source, dict):  # a Couch attachment stub carries its data inline
                source = source.get("data")
            if isinstance(source, str) and source:
                found.append(source.encode("utf-8"))
    return found


def question_types(xml: bytes):
    """HQ's reading of a form's questions (``XForm.get_questions`` with groups and triggers, each typed by
    ``_infer_vellum_type``): ``{"questions": [[type, path], ...]}``, or ``{"unreadable": <HQ's refusal>}``."""
    from corehq.apps.app_manager.exceptions import XFormException
    from corehq.apps.app_manager.xform import XForm

    try:
        questions = XForm(xml).get_questions([], include_triggers=True, include_groups=True)
    except XFormException as error:  # XForm's own refusal of a form it cannot read
        return {"unreadable": str(error)}
    return {"questions": [[question.get("type"), str(question.get("value"))] for question in questions]}


def csql_reading(query):
    """What HQ's CSQL parser (``eulxml.xpath.parse``, which ``case_search/filter_dsl.py::build_filter_from_xpath``
    runs) reads in one query string: each function (``["fn", name]``), each operator (``["op", op]``),
    ``within-distance``'s unit (``["unit", unit]``) and each step (``["step", <the step as eulxml serializes
    it>]``), and each comparison with what stands on either side of it (``["cmp", op, left, right]``,
    ``comparison_side``); None where the parser refuses the string."""
    from eulxml.xpath import parse as parse_xpath
    from eulxml.xpath import serialize
    from eulxml.xpath.ast import (
        AbsolutePath,
        BinaryExpression,
        FunctionCall,
        PredicatedExpression,
        Step,
        UnaryExpression,
    )

    try:
        tree = parse_xpath(query)
    except (TypeError, RuntimeError) as error:
        if isinstance(error, RuntimeError):
            # eulxml leaves its parser unusable after a parse error; HQ parses once more to reset it
            # (case_search/filter_dsl.py::build_filter_from_xpath).
            parse_xpath("thisisdumb")
        return None
    found = []

    def visit(node):
        if isinstance(node, FunctionCall):
            found.append(["fn", node.name])
            for index, argument in enumerate(node.args):
                if node.name == DISTANCE_FUNCTION and index == DISTANCE_UNIT_ARGUMENT and isinstance(argument, str):
                    found.append(["unit", argument])
                visit(argument)
        elif isinstance(node, BinaryExpression):
            found.append(["op", node.op])
            if node.op in COMPARISONS:
                found.append(["cmp", node.op, comparison_side(node.left), comparison_side(node.right)])
            visit(node.left)
            visit(node.right)
        elif isinstance(node, UnaryExpression):
            found.append(["op", node.op])
            visit(node.right)
        elif isinstance(node, PredicatedExpression):
            visit(node.base)
            for predicate in node.predicates:
                visit(predicate)
        elif isinstance(node, AbsolutePath):
            visit(node.relative)
        elif isinstance(node, Step):
            found.append(["step", serialize(node)])
            for predicate in node.predicates or ():
                visit(predicate)

    visit(tree)
    return found


# The comparison operators HQ's CSQL reads (case_search/const.py COMPARISON_OPERATORS).
COMPARISONS = frozenset({"=", "!=", "<", "<=", ">", ">="})


def comparison_side(node):
    """What stands on one side of a CSQL comparison, as HQ's comparison reads it
    (``xpath_functions/comparison.py::property_comparison_query``, ``dsl_utils.py::unwrap_value``): ``hole``
    for a value only the run time knows spliced in unquoted (``CSQL_HOLE`` as a step), ``hole-text`` for one
    quoted (``CSQL_HOLE`` as text), ``step:<step>`` for a step,
    ``number`` for a number (a literal, or text ``float`` reads), ``date`` or ``datetime`` for text HQ's own
    parser reads as one (``comparison.py::_parse_date_or_datetime``), ``invalid-date`` for text it refuses as
    a date, ``text`` for any other text, ``function:<name>`` for a call (``XPATH_VALUE_FUNCTIONS`` values
    among them) and ``other`` for anything else."""
    from corehq.apps.case_search.xpath_functions.comparison import _parse_date, _parse_datetime
    from eulxml.xpath import serialize
    from eulxml.xpath.ast import FunctionCall, Step

    if isinstance(node, Step):
        text = serialize(node)
        return "hole" if text == CSQL_HOLE else f"step:{text}"
    if isinstance(node, bool):
        return "other"
    if isinstance(node, (int, float)):
        return "number"
    if isinstance(node, str):
        if node == CSQL_HOLE:
            return "hole-text"
        try:
            float(node)
        except ValueError:
            pass
        else:
            return "number"
        # comparison.py::_parse_date_or_datetime, step by step: a date, else a datetime; a value of either's
        # shape that names no real day raises.
        for kind, parse in (("date", _parse_date), ("datetime", _parse_datetime)):
            try:
                if parse(node) is not None:
                    return kind
            except ValueError:
                return "invalid-date"
        return "text"
    if isinstance(node, FunctionCall):
        return f"function:{node.name}"
    return "other"


def expression_tree(text):
    """An XPath expression's structure, as eulxml's XPath grammar (HQ's XPath parser, ``eulxml.xpath``) reads it,
    with XPath's lexical rule for a name after a comma (``_parser``), for a judge that reads it without a parser of
    its own: ``["number", value]``, ``["text", value]``, ``["binary", op, left, right]``, ``["negative",
    operand]``, ``["call", name, [arguments]]`` (the name with its prefix, ``jr:itext``), ``["path", root, <the
    path as eulxml serializes it>, [each predicate's tree, at any step], [each step]]`` for a location path
    (``root``: ``absolute`` for one from the document's root, ``relative`` for one from the context node,
    ``instance:<id>`` for one from ``instance('<id>')``, ``call:<name>`` for one from another call's value; each
    step after the root, in order, ``[axis, node test, its predicates' count]``: ``child``, ``attribute`` or
    another axis by name, ``.`` as ``self`` and ``..`` as ``parent`` with the test ``node()``, ``//`` as a
    ``descendant-or-self`` step, and a filter on a whole path as ``["filter", None, count]``), or ``["other",
    <serialized>]``; None where the grammar refuses the text."""
    return _parse(text, hashtags=False)


def hashtag_tree(text):
    """An expression Vellum reads with hashtags (``vellum:requiredCondition``), as ``expression_tree`` gives one,
    each hashtag as ``["hashtag", <the hashtag>]`` (``_parser``'s hashtag production); None where the grammar
    refuses the text."""
    return _parse(text, hashtags=True)


class Hashtag:
    """A Vellum hashtag (``#form/q``, ``#case/p``) where an expression's operand stands."""

    def __init__(self, text):
        self.text = text

    def _serialize(self):
        yield self.text


def _parse(text, *, hashtags):
    parser, lexer = _parser(hashtags)
    lexer.last = None  # the lexer reads its previous token to tell an operator from a name
    try:
        tree = parser.parse(text, lexer=lexer)
    except (TypeError, RuntimeError):  # the lexer's refusal, the parser's
        return None
    return _tree(tree)


@cache
def _parser(hashtags):
    """eulxml's XPath lexer and parser rules, built anew for the observation (HQ's own parser object, which its CSQL
    reading shares, is left as it is), with XPath's lexical rule for a name after a comma: XPath reads ``*`` and a
    name after ``,`` as it reads them after ``(`` (XPath 1.0, 3.7 Lexical Structure: they are an operator only after
    a token other than ``@``, ``::``, ``(``, ``[``, ``,`` or an operator), which eulxml's lexer leaves out of its
    ``OPERATOR_FORCERS`` (``eulxml.xpath.core``), so that it refuses a call after a comma (``if(c, concat(a, b),
    '')``), which Core reads. A text eulxml parses is read alike. With ``hashtags``, the grammar also holds the
    hashtag production of Vellum's XPath parser (js-xpath, ``xpath.jisonlex``: ``#`` then a QName and
    slash-separated QNames; ``xpath.jison``: ``expr: hashtag_expr``), lexed as one token, so a hashtag stands where
    an expression may and takes no step or predicate after it, as there."""
    import re
    import types

    from eulxml.xpath import core, lexrules, parserules
    from ply import lex, yacc

    forcers = core.OPERATOR_FORCERS | {"COMMA"}

    class Lexer(core.LexerWrapper):
        def token(self):
            token = lex.Lexer.token(self)
            if token is not None:
                if token.type == "STAR_OP" and self.last is not None and self.last.type not in forcers:
                    token.type = "MULT_OP"
                if token.type == "NCNAME":
                    if self.last is not None and self.last.type not in forcers:
                        token.type = lexrules.operator_names.get(token.value, token.type)
                    else:
                        following = self.peek()
                        if following is not None and following.type == "OPEN_PAREN":
                            token.type = "NODETYPE" if token.value in core.NODE_TYPES else "FUNCNAME"
                        elif following is not None and following.type == "AXIS_SEP":
                            token.type = "AXISNAME"
            self.last = token
            return token

    lexing = types.ModuleType("observation_xpath_lexrules")
    lexing.__dict__.update({name: value for name, value in vars(lexrules).items() if not name.startswith("__")})
    lexing.__file__ = lexrules.__file__
    parsing = types.ModuleType("observation_xpath_parserules")
    parsing.__dict__.update({name: value for name, value in vars(parserules).items() if not name.startswith("__")})
    parsing.__file__ = parserules.__file__
    parsing.start = "Expr"
    if hashtags:
        qname = f"{lexrules.NCNAME_REGEX}(:{lexrules.NCNAME_REGEX})?"

        def t_HASHTAG(t):
            t.value = Hashtag(t.value)
            return t

        t_HASHTAG.__doc__ = f"\\#{qname}(/{qname})*"

        def p_expr_hashtag(p):
            """
            Expr : HASHTAG
            """
            p[0] = p[1]

        lexing.tokens = [*lexrules.tokens, "HASHTAG"]
        lexing.t_HASHTAG = t_HASHTAG
        parsing.tokens = lexing.tokens
        parsing.p_expr_hashtag = p_expr_hashtag
    lexer = lex.lex(module=lexing, reflags=re.UNICODE, errorlog=lex.NullLogger())
    lexer.__class__ = Lexer
    lexer.last = None
    parser = yacc.yacc(module=parsing, write_tables=False, debug=False, errorlog=yacc.NullLogger())
    return parser, lexer


def _tree(tree):
    """The structure of an expression eulxml parsed (``expression_tree``)."""
    from eulxml.xpath import serialize
    from eulxml.xpath.ast import (
        AbbreviatedStep,
        AbsolutePath,
        BinaryExpression,
        FunctionCall,
        NameTest,
        PredicatedExpression,
        Step,
        UnaryExpression,
    )

    def is_path(node):
        if isinstance(node, BinaryExpression):
            return node.op in ("/", "//")
        return isinstance(node, (AbsolutePath, Step, AbbreviatedStep, PredicatedExpression))

    def path_root(node, predicates):
        """A path's root, gathering each predicate along it into ``predicates``."""
        if isinstance(node, AbsolutePath):
            if node.relative is not None:
                path_root(node.relative, predicates)
            return "absolute"
        if isinstance(node, BinaryExpression):
            root = path_root(node.left, predicates)
            path_root(node.right, predicates)
            return root
        if isinstance(node, PredicatedExpression):
            predicates.extend(walk(predicate) for predicate in node.predicates or ())
            return path_root(node.base, predicates)
        if isinstance(node, Step):
            predicates.extend(walk(predicate) for predicate in node.predicates or ())
            return "relative"
        if isinstance(node, AbbreviatedStep):
            return "relative"
        if isinstance(node, FunctionCall):
            predicates.extend(walk(argument) for argument in node.args)
            if node.name == "instance" and len(node.args) == 1 and isinstance(node.args[0], str):
                return f"instance:{node.args[0]}"
            return f"call:{node.name}"
        return "other"

    def path_steps(node, steps):
        """Each step of a path after its root, in order (``expression_tree``)."""
        descendants = ["descendant-or-self", "node()", 0]
        if isinstance(node, AbsolutePath):
            if node.op == "//":
                steps.append(descendants)
            if node.relative is not None:
                path_steps(node.relative, steps)
        elif isinstance(node, BinaryExpression):
            path_steps(node.left, steps)
            if node.op == "//":
                steps.append(descendants)
            path_steps(node.right, steps)
        elif isinstance(node, PredicatedExpression):
            path_steps(node.base, steps)
            steps.append(["filter", None, len(node.predicates or ())])
        elif isinstance(node, Step):
            axis = "attribute" if node.axis == "@" else node.axis or "child"
            test = str(node.node_test) if isinstance(node.node_test, NameTest) else serialize(node.node_test)
            steps.append([axis, test, len(node.predicates or ())])
        elif isinstance(node, AbbreviatedStep):
            steps.append(["self" if node.abbr == "." else "parent", "node()", 0])
        return steps

    def walk(node):
        if isinstance(node, Hashtag):
            return ["hashtag", node.text]
        if isinstance(node, bool):
            return ["other", str(node)]
        if isinstance(node, (int, float)):
            return ["number", node]
        if isinstance(node, str):
            return ["text", node]
        if is_path(node):
            predicates = []
            root = path_root(node, predicates)
            return ["path", root, serialize(node), predicates, path_steps(node, [])]
        if isinstance(node, BinaryExpression):
            return ["binary", node.op, walk(node.left), walk(node.right)]
        if isinstance(node, UnaryExpression):
            return ["negative", walk(node.right)]
        if isinstance(node, FunctionCall):
            name = f"{node.prefix}:{node.name}" if node.prefix else node.name
            return ["call", name, [walk(argument) for argument in node.args]]
        return ["other", serialize(node)]

    return walk(tree)


# The calls whose arguments the value classes read (``jr:itext``'s text id, ``jr:choice-name``'s question), the
# step axis whose place in a path they read (a parent step after a named one, ``XPathPathExpr.getReference``),
# and the expression class whose sides they read (a relational comparison, ``XPathCmpExpr``), each as Core's
# parse names it (``Shapes.collect``).
STRUCTURE_CALLS = frozenset({"jr:itext", "jr:choice-name"})
STRUCTURE_AXES = frozenset({"AXIS_PARENT"})
STRUCTURE_EXPRESSIONS = frozenset({"XPathCmpExpr"})


def structure_read(parsed):
    """Whether the judge reads an expression's structure (``expression_tree``) by what Core's parse holds of it:
    a call to one of ``STRUCTURE_CALLS``, a step on one of ``STRUCTURE_AXES``, an expression of one of
    ``STRUCTURE_EXPRESSIONS``."""
    if "error" in parsed:
        return False
    return bool(
        STRUCTURE_CALLS & set(parsed["functions"])
        or STRUCTURE_AXES & set(parsed["axes"])
        or STRUCTURE_EXPRESSIONS & set(parsed["expressions"])
    )


def tree_texts(root, found):
    """The expressions of a form the judge reads the structure of (``expression_tree``), into ``found``: each
    load-time setvalue's value (``xforms-ready``, which the case preload rows read the order of), each repeat's
    count and each bind calculate, which a count's value and a comparison's side come from, and, in a form that
    holds a model iteration (``vellum:role="Repeat"``), each bind's relevance, which decides whether its rows are
    built (``proof.checks.manifest_value_classes``)."""
    for setvalue in root.iter(f"{{{XFORMS}}}setvalue"):
        value = setvalue.get("value")
        if "xforms-ready" in (setvalue.get("event") or "").split() and value and value.strip():
            found.add(value)
    for repeat in root.iter(f"{{{XFORMS}}}repeat"):
        count = repeat.get(f"{{{JAVAROSA}}}count")
        if count and count.strip():
            found.add(count)
    iterates = any(
        element.get(f"{{{VELLUM}}}role") == "Repeat" for element in root.iter() if isinstance(element.tag, str)
    )
    for bind in root.iter(f"{{{XFORMS}}}bind"):
        calculate, relevant = bind.get("calculate"), bind.get("relevant")
        if calculate and calculate.strip():
            found.add(calculate)
        if iterates and relevant and relevant.strip():
            found.add(relevant)


def vellum_condition_texts(root, conditions, found):
    """What the judge reads of a form's required conditions as Vellum reads them (``vellum:requiredCondition``,
    ``parser.js::parseBindElement``): each condition, into ``conditions`` (read by ``hashtag_tree``), and into
    ``found`` (read by ``expression_tree``) the ``required`` beside it, each XPath the form's
    ``vellum:hashtags`` names, and each hashtag of a condition that the form's ``vellum:hashtagTransforms``
    prefixes make an XPath of (``parser.js::initHashtags``: the prefix's value and the hashtag's last
    segment, after its last ``/``)."""
    head = root.find(f"{{{XHTML}}}head")
    hashtags = _vellum_json(head, "hashtags")
    found.update(value for value in hashtags.values() if isinstance(value, str) and value.strip())
    prefixes = _vellum_json(head, "hashtagTransforms").get("prefixes")
    prefixes = prefixes if isinstance(prefixes, dict) else {}
    for bind in root.iter(f"{{{XFORMS}}}bind"):
        condition = bind.get(f"{{{VELLUM}}}requiredCondition")
        if condition is None:
            continue
        conditions.add(condition)
        if bind.get("required") and bind.get("required").strip():
            found.add(bind.get("required"))
        for hashtag in _hashtags(hashtag_tree(condition)):
            prefix, _, segment = hashtag.rpartition("/")
            value = prefixes.get(f"{prefix}/")
            if isinstance(value, str) and segment:
                found.add(value + segment)


def _vellum_json(head, name):
    """The JSON object a head child in Vellum's namespace holds (``parser.js::initHashtags``), or ``{}``."""
    element = head.find(f"{{{VELLUM}}}{name}") if head is not None else None
    try:
        value = json.loads((element.text or "").strip()) if element is not None else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _hashtags(tree):
    """Each hashtag a ``hashtag_tree`` holds, at any depth."""
    if tree is None:
        return
    kind = tree[0]
    if kind == "hashtag":
        yield tree[1]
    elif kind == "binary":
        yield from _hashtags(tree[2])
        yield from _hashtags(tree[3])
    elif kind == "negative":
        yield from _hashtags(tree[1])
    elif kind == "call":
        for argument in tree[2]:
            yield from _hashtags(argument)
    elif kind == "path":
        for predicate in tree[3]:
            yield from _hashtags(predicate)


def media_facts(data, filename):
    """What a media file is, as the media value classes read it: its MIME type as HQ classifies media by it
    (``hqmedia/models.py::CommCareMultimedia.get_mime_type``, libmagic over the bytes), and for a WAV its
    format code and sample size (``wav``: the ``fmt`` chunk), for an ISO base media file (MP4, M4A, 3GP, MOV)
    its brands and each track's handler and codecs (``iso``: ``ftyp``, each ``trak``'s ``hdlr`` and ``stsd``
    entries), and for an Ogg file whether a stream is Theora."""
    from corehq.apps.hqmedia.models import CommCareMultimedia

    facts = {"mime": CommCareMultimedia.get_mime_type(data, filename=filename)}
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        facts["wav"] = _wav_format(data)
    elif data[4:8] == b"ftyp":
        facts["iso"] = _iso_tracks(data)
    elif data[:4] == b"OggS":
        facts["ogg"] = {"theora": b"\x80theora" in data[:4096]}
    return facts


def _wav_format(data):
    """A WAV's ``fmt`` chunk: its format code (the extensible format's subformat where it is extensible) and
    bits per sample, or None where it has none."""
    import struct

    offset = 12
    while offset + 8 <= len(data):
        chunk, size = data[offset : offset + 4], struct.unpack("<I", data[offset + 4 : offset + 8])[0]
        body = data[offset + 8 : offset + 8 + size]
        if chunk == b"fmt " and len(body) >= 16:
            code, bits = struct.unpack("<H", body[0:2])[0], struct.unpack("<H", body[14:16])[0]
            if code == 0xFFFE and len(body) >= 26:
                code = struct.unpack("<H", body[24:26])[0]
            return {"format": code, "bits": bits}
        offset += 8 + size + (size & 1)
    return None


ISO_CONTAINERS = frozenset({b"moov", b"trak", b"mdia", b"minf", b"stbl"})


def _iso_tracks(data):
    """An ISO base media file's ``ftyp`` brands and each track's handler type and sample entry types."""
    import struct

    found = {"brand": None, "compatible": [], "tracks": []}

    def boxes(start, end):
        offset = start
        while offset + 8 <= end:
            size, kind = struct.unpack(">I", data[offset : offset + 4])[0], data[offset + 4 : offset + 8]
            header = 8
            if size == 1 and offset + 16 <= end:
                size, header = struct.unpack(">Q", data[offset + 8 : offset + 16])[0], 16
            elif size == 0:
                size = end - offset
            if size < header:
                return
            yield kind, offset + header, min(offset + size, end)
            offset += size

    def walk(start, end, track):
        for kind, body, stop in boxes(start, end):
            if kind == b"ftyp":
                found["brand"] = data[body : body + 4].decode("latin-1")
                found["compatible"] = [data[at : at + 4].decode("latin-1") for at in range(body + 8, stop - 3, 4)]
            elif kind == b"trak":
                inner = {"handler": None, "codecs": []}
                found["tracks"].append(inner)
                walk(body, stop, inner)
            elif kind in ISO_CONTAINERS:
                walk(body, stop, track)
            elif kind == b"hdlr" and track is not None:
                track["handler"] = data[body + 8 : body + 12].decode("latin-1")
            elif kind == b"stsd" and track is not None:
                track["codecs"] += [entry.decode("latin-1") for entry, _, _ in boxes(body + 8, stop)]

    walk(0, len(data), None)
    return found


# The app JSON's expression slots, by schema class: each holds XPath an HQ build or runtime parses, which the
# judge reads through Core's parser like a form's or suite's (Form.form_filter, Module.module_filter,
# Detail.filter, a calculated DetailColumn.field, FormLink.xpath, FormDatum.xpath and a default search
# property's defaultValue).
APP_EXPRESSION_SLOTS = (
    ("form_filter", None),
    ("module_filter", None),
    ("filter", None),
    ("field", "useXpathExpression"),
    ("xpath", None),
    ("defaultValue", None),
)


def app_expressions(value, found):
    """Each expression an app JSON's expression slots hold, at any depth, into ``found``."""
    if isinstance(value, dict):
        for slot, when in APP_EXPRESSION_SLOTS:
            text = value.get(slot)
            if isinstance(text, str) and text.strip() and (when is None or value.get(when)):
                found.add(text)
        for child in value.values():
            app_expressions(child, found)
    elif isinstance(value, list):
        for child in value:
            app_expressions(child, found)


def _settled(result):
    """A runner result as a record holds it: an error by the exception's class alone (Core's messages hold JVM
    identity hashes, so they differ from run to run)."""
    if "error" in result:
        return {"error": str(result["error"]).split(":", 1)[0]}
    return result


def _runner_reading(core_runner, op, texts, **args):
    """The runner's ``op`` over ``texts`` (one request), by text."""
    if not texts:
        return {}
    results = core_runner.request(op, deadline=DEADLINE, expressions=texts, **args)["results"]
    return {text: _settled(result) for text, result in zip(texts, results, strict=True)}


def readings(core_runner, *, forms=(), runtimes=(), apps=(), media=()):
    """What HQ and Core make of the given artifacts: ``forms`` (XForm bytes), ``runtimes`` (suite and profile
    bytes), ``apps`` (app JSON values, whose forms are among ``forms``) and ``media`` (``{path: bytes}``, each
    local archive's media files). HQ is booted for its readers."""
    from proof.hq.boot import boot

    boot()
    texts, queries, questions, roots = set(), set(), {}, []
    for xml in forms:
        digest = hashlib.sha256(xml).hexdigest()
        root = _parsed(xml)
        if root is None or digest in questions:
            continue  # a form that is not well-formed is the judge's to report, as it walks it
        questions[digest] = question_types(xml)
        attribute_values(root, texts)
        roots.append(root)
    for xml in runtimes:
        root = _parsed(xml)
        if root is not None:
            attribute_values(root, texts)
            suite_queries(root, queries)
    for app in apps:
        app_queries(app, queries)
        app_expressions(app, texts)
    strings = _runner_reading(core_runner, "xpathStrings", sorted(queries), hole=CSQL_HOLE)
    sent = sorted({string for result in strings.values() for string in result.get("strings", ())})
    expressions = _runner_reading(core_runner, "xpathParse", sorted(texts))
    trees, conditions = structure_tables(roots, expressions)
    return {
        "questions": questions,
        "expressions": expressions,
        "strings": strings,
        "csql": {string: csql_reading(string) for string in sent},
        "trees": trees,
        "conditions": conditions,
        "media": {name: media_facts(data, name.rsplit("/", 1)[-1]) for name, data in sorted(dict(media).items())},
    }


def structure_tables(roots, expressions):
    """The ``trees`` and ``conditions`` readings: the structure of each expression the judge reads it of, by its
    text, from the forms (``roots``: each form's parsed root; ``tree_texts``, ``vellum_condition_texts``) and from
    Core's parse of every expression (``expressions``, ``structure_read``)."""
    found, conditions = set(), set()
    for root in roots:
        tree_texts(root, found)
        vellum_condition_texts(root, conditions, found)
    found.update(text for text, parsed in expressions.items() if structure_read(parsed))
    return (
        {text: expression_tree(text) for text in sorted(found)},
        {text: hashtag_tree(text) for text in sorted(conditions)},
    )


# The hook the unit calls ----------------------------------------------------------------


def observe_local(ctx) -> dict:
    """The manifest's observation of every export of the document (``ctx``: ``proof.observe.unit.LocalContext``):
    what each publish sends and each archive holds, and what HQ and Core make of them."""
    from proof.hq.boot import soft_assertions
    from proof.hq.operations import upload_field

    uploads, apps, forms, runtimes = {}, [], [], []
    for key, captured, _ in uploads_of(ctx.document):
        body = upload_field(captured.upload(), "app_file")
        uploads[key] = ctx.blobs.put(body)
        try:
            app = json.loads(body)
        except ValueError:
            continue  # the judge reports an app file that is not JSON
        apps.append(app)
        forms += app_forms(app)
    archives, media = {}, {}
    for name, path in ctx.archives.items():
        with zipfile.ZipFile(path) as archive:
            entries = {entry: archive.read(entry) for entry in sorted(archive.namelist()) if read_entry(entry)}
            for entry in sorted(archive.namelist()):
                if not read_entry(entry) and not entry.endswith("/") and entry not in media:
                    media[entry] = archive.read(entry)
        archives[name] = {entry: ctx.blobs.put(content) for entry, content in entries.items()}
        forms += [content for entry, content in entries.items() if FORM_FILE.fullmatch(entry)]
        runtimes += [content for entry, content in entries.items() if entry in RUNTIME_FILES]
    with soft_assertions() as notes:
        table = readings(ctx.core_runner, forms=forms, runtimes=runtimes, apps=apps, media=media)
    record = {"uploads": uploads, "archives": archives, "readings": ctx.blobs.put_json(table)}
    if notes:
        record["softAssertions"] = [
            {"message": note.message, "value": note.value, "where": note.where, "line": note.line} for note in notes
        ]
    return record
