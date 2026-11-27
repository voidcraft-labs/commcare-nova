"""Core's implicit numeric ordering and explicit number() in one hidden calculation."""

from collections import Counter, defaultdict

from proof.rules import SpellingRule
from proof.rules._xforms import XFORMS, body, model, tag


def _unwrapped(node):
    if node[:2] == ("call", "number") and len(node[2]) == 1:
        return node[2][0], True
    return node, False


def _quoted(value):
    return f'"{value}"' if "'" in value else f"'{value}'"


def _ordered(text):
    # Imports lazily since the lexer lives inside the rule registry.
    from proof.checks.xpath_tree import tree

    call = tree(text)
    if call is None or call[:2] != ("call", "if") or len(call[2]) != 3:
        return None
    condition, early, late = call[2]
    if condition[0] != "LT" or early[0] != "str" or late[0] != "str":
        return None
    left, left_explicit = _unwrapped(condition[1])
    right, right_explicit = _unwrapped(condition[2])
    if left_explicit != right_explicit or left[:3] != ("path", "SLASH", None) or right[0] != "str":
        return None
    steps = left[3]
    if len(steps) != 2 or any(step[:2] != ("step", "child") or step[3] for step in steps):
        return None
    source = "/" + "/".join(step[2] for step in steps)
    return source, f"if(number({source}) < number({_quoted(right[1])}), {_quoted(early[1])}, {_quoted(late[1])})"


def rewritten(root):
    """Yield exact root hidden binds and their numeric spelling, with their independent text input evidence."""
    form_model, form_body = model(root), body(root)
    if form_model is None or form_body is None:
        return
    data = form_model.find(f"{tag(XFORMS, 'instance')}/*")
    if data is None:
        return
    data_name = data.tag.rsplit("}", 1)[-1]
    children = Counter(f"/{data_name}/{child.tag.rsplit('}', 1)[-1]}" for child in data if isinstance(child.tag, str))
    binds = defaultdict(list)
    for bind in form_model.findall(tag(XFORMS, "bind")):
        binds[bind.get("nodeset")].append(bind)
    controls = defaultdict(list)
    for control in form_body.iter():
        if ref := control.get("ref") or control.get("nodeset"):
            controls[ref].append(control.tag)
    for target, nodes in binds.items():
        if len(nodes) != 1 or children[target] != 1 or target in controls:
            continue
        bind, = nodes
        if not (text := bind.get("calculate")) or not (candidate := _ordered(text)):
            continue
        source, explicit = candidate
        inputs = binds.get(source, ())
        if (children[source] != 1 or len(inputs) != 1
                or inputs[0].get("type") not in ("xsd:string", "string")
                or controls[source] != [tag(XFORMS, "input")]):
            continue
        yield target, bind, explicit


def normalize(root):
    for _, bind, explicit in rewritten(root):
        bind.set("calculate", explicit)
    return root


RULE = SpellingRule(
    "hidden-text-number-order",
    ("form:*", "*/form:*"),
    "A root hidden calculation ordering one root text input against a literal performs the same two numeric"
    " conversions with explicit number() (XPathCmpExpr and XPathNumberFunc).",
    normalize,
)
