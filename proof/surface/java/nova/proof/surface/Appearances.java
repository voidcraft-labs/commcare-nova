package nova.proof.surface;

import com.github.javaparser.ast.Node;
import com.github.javaparser.ast.body.CallableDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumConstantDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.Parameter;
import com.github.javaparser.ast.body.TypeDeclaration;
import com.github.javaparser.ast.body.VariableDeclarator;
import com.github.javaparser.ast.expr.AssignExpr;
import com.github.javaparser.ast.expr.CastExpr;
import com.github.javaparser.ast.expr.ConditionalExpr;
import com.github.javaparser.ast.expr.EnclosedExpr;
import com.github.javaparser.ast.expr.Expression;
import com.github.javaparser.ast.expr.FieldAccessExpr;
import com.github.javaparser.ast.expr.MethodCallExpr;
import com.github.javaparser.ast.expr.NameExpr;
import com.github.javaparser.ast.expr.ObjectCreationExpr;
import com.github.javaparser.ast.expr.ThisExpr;
import com.github.javaparser.ast.stmt.BreakStmt;
import com.github.javaparser.ast.stmt.ContinueStmt;
import com.github.javaparser.ast.stmt.ExplicitConstructorInvocationStmt;
import com.github.javaparser.ast.stmt.ReturnStmt;
import com.github.javaparser.ast.stmt.Statement;
import com.github.javaparser.ast.stmt.ThrowStmt;
import com.github.javaparser.ast.stmt.YieldStmt;
import com.github.javaparser.ast.stmt.SwitchEntry;
import com.github.javaparser.ast.stmt.SwitchStmt;
import com.github.javaparser.ast.type.Type;
import com.github.javaparser.ast.nodeTypes.NodeWithArguments;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Every place a runtime reads a question's appearance, followed from where the value is read
 * (`getAppearanceHint()`, `getAppearanceAttr()`) through locals, fields, parameters, getters,
 * `Bundle` keys and string transforms to each comparison, recording the token compared with, how
 * it matches (whole string, contained, prefix, suffix, index, regular expression, split) and its
 * case handling. A token held by a parameter or a getter is followed back to the constants its
 * callers pass (an enum constant's arguments included). An intent element's own `appearance`
 * attribute (`getAttributeValue(ns, "appearance")`) is followed the same way and kept apart.
 *
 * Each read also records which form elements it compares the appearance of, where the source says:
 * what holds the value it reads (`holders`: a question's prompt, `FormEntryPrompt` or `QuestionDef`,
 * or a group's `GroupDef`), and the control types and data types of the questions that reach it
 * (`controls`, `datatypes`): the labels of each `switch` on a prompt's `getControlType()` or
 * `getDataType()` the read sits in, in its own method or on the way to it from its method's callers
 * (`WidgetFactory.createWidgetFromPrompt` builds a select's widget only under `CONTROL_SELECT_ONE`
 * and `CONTROL_SELECT_MULTI`), a case's label with those of the cases that fall through into it. A
 * read some way reaches through no such switch (a default case, a method no code calls) is recorded
 * with no such restriction.
 */
final class Appearances {
    private static final Set<String> TRANSFORMS = Set.of("toLowerCase", "toUpperCase", "trim", "strip", "intern",
            "substring", "replace", "replaceAll");
    private static final Map<String, String> SINKS = Map.of(
            "equals", "whole", "contentEquals", "whole", "equalsIgnoreCase", "whole",
            "contains", "contains", "startsWith", "prefix", "endsWith", "suffix",
            "indexOf", "index", "lastIndexOf", "index", "matches", "regex");
    private static final int VALUE_DEPTH = 4;

    private final Code code;
    /**
     * Entity -> taint labels: where the value came from and whether it was lowercased on the way
     * ("control:raw", "control:lower", "attribute:IntentExtensionParser:raw", ...).
     */
    private final Map<String, Set<String>> taint = new HashMap<>();
    private final Map<CallableDeclaration<?>, List<Node>> callSites = new HashMap<>();

    private Appearances(Code code) {
        this.code = code;
    }

    static List<Object> read(Code code) {
        Appearances reader = new Appearances(code);
        reader.indexCallSites();
        boolean changed = true;
        while (changed) {
            changed = reader.propagate();
        }
        return reader.sinks();
    }

    // -- entities ---------------------------------------------------------------------

    private static String key(CallableDeclaration<?> callable) {
        TypeDeclaration<?> type = Code.typeOf(callable);
        return (type == null ? "?" : Code.qualifiedName(type)) + "#" + callable.getDeclarationAsString(false, false, false);
    }

    private static CallableDeclaration<?> callableOf(Node node) {
        Node current = node;
        while (current != null) {
            if (current instanceof CallableDeclaration) {
                return (CallableDeclaration<?>) current;
            }
            if (current instanceof TypeDeclaration) {
                return null;
            }
            current = current.getParentNode().orElse(null);
        }
        return null;
    }

    /** The entity a name reads from where it is used: a local or parameter, else a field. */
    private String nameEntity(String name, Node at) {
        CallableDeclaration<?> callable = callableOf(at);
        if (callable != null) {
            for (Parameter parameter : callable.getParameters()) {
                if (parameter.getNameAsString().equals(name)) {
                    return key(callable) + "#param:" + name;
                }
            }
            for (VariableDeclarator local : callable.findAll(VariableDeclarator.class)) {
                if (local.getNameAsString().equals(name) && !(local.getParentNode().orElse(null) instanceof FieldDeclaration)) {
                    return key(callable) + "#local:" + name;
                }
            }
        }
        return fieldEntity(Code.typeOf(at), name);
    }

    private String fieldEntity(TypeDeclaration<?> context, String name) {
        if (context == null) {
            return null;
        }
        VariableDeclarator field = code.field(context, name);
        if (field == null) {
            return null;
        }
        return Code.qualifiedName(Code.typeOf(field)) + "#field:" + name;
    }

    private boolean add(String entity, Set<String> labels) {
        if (entity == null || labels.isEmpty()) {
            return false;
        }
        return taint.computeIfAbsent(entity, k -> new TreeSet<>()).addAll(labels);
    }

    // -- calls ------------------------------------------------------------------------

    private void indexCallSites() {
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                for (CallableDeclaration<?> target : targets(call)) {
                    callSites.computeIfAbsent(target, k -> new ArrayList<>()).add(call);
                }
            }
            for (ObjectCreationExpr creation : unit.tree.findAll(ObjectCreationExpr.class)) {
                for (CallableDeclaration<?> target : code.callables(code.type(creation.getType().getNameAsString()),
                        null, creation.getArguments().size())) {
                    callSites.computeIfAbsent(target, k -> new ArrayList<>()).add(creation);
                }
            }
            for (ExplicitConstructorInvocationStmt invocation : unit.tree.findAll(ExplicitConstructorInvocationStmt.class)) {
                TypeDeclaration<?> type = Code.typeOf(invocation);
                TypeDeclaration<?> target = invocation.isThis() ? type
                        : Code.superName(type) == null ? null : code.type(Code.superName(type));
                for (CallableDeclaration<?> constructor : code.callables(target, null, invocation.getArguments().size())) {
                    callSites.computeIfAbsent(constructor, k -> new ArrayList<>()).add(invocation);
                }
            }
            for (EnumConstantDeclaration constant : unit.tree.findAll(EnumConstantDeclaration.class)) {
                TypeDeclaration<?> type = Code.typeOf(constant);
                for (CallableDeclaration<?> constructor : code.callables(type, null, constant.getArguments().size())) {
                    callSites.computeIfAbsent(constructor, k -> new ArrayList<>()).add(constant);
                }
            }
        }
    }

    /** The methods a call may reach, from its receiver's declared type where the source states one. */
    private List<CallableDeclaration<?>> targets(MethodCallExpr call) {
        String name = call.getNameAsString();
        int arity = call.getArguments().size();
        if (!call.getScope().isPresent() || call.getScope().get() instanceof ThisExpr) {
            return code.callables(Code.typeOf(call), name, arity);
        }
        String typeName = typeOf(call.getScope().get());
        return typeName == null ? List.of() : code.callables(code.type(typeName), name, arity);
    }

    /** The simple type name an expression is declared with, where the source states it. */
    private String typeOf(Expression expression) {
        Expression inner = expression;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        if (inner instanceof CastExpr) {
            return simple(((CastExpr) inner).getType());
        }
        if (inner instanceof ObjectCreationExpr) {
            return ((ObjectCreationExpr) inner).getType().getNameAsString();
        }
        if (inner instanceof NameExpr) {
            String name = ((NameExpr) inner).getNameAsString();
            CallableDeclaration<?> callable = callableOf(inner);
            if (callable != null) {
                for (Parameter parameter : callable.getParameters()) {
                    if (parameter.getNameAsString().equals(name)) {
                        return simple(parameter.getType());
                    }
                }
                for (VariableDeclarator local : callable.findAll(VariableDeclarator.class)) {
                    if (local.getNameAsString().equals(name)) {
                        return simple(local.getType());
                    }
                }
            }
            VariableDeclarator field = code.field(Code.typeOf(inner), name);
            if (field != null) {
                return simple(field.getType());
            }
            if (code.type(name) != null) {
                return name;
            }
        }
        if (inner instanceof FieldAccessExpr && ((FieldAccessExpr) inner).getScope() instanceof ThisExpr) {
            VariableDeclarator field = code.field(Code.typeOf(inner), ((FieldAccessExpr) inner).getNameAsString());
            return field == null ? null : simple(field.getType());
        }
        return null;
    }

    private static String simple(Type type) {
        String text = type.isClassOrInterfaceType() ? type.asClassOrInterfaceType().getNameAsString() : type.asString();
        return text;
    }

    /** The classes whose appearance a question's or a group's own: a prompt's (`FormEntryPrompt`, built for a
     *  question) and its `QuestionDef`'s, and a `GroupDef`'s (a group or a repeat). */
    private static final Map<String, String> HOLDERS = Map.of(
            "FormEntryPrompt", "question", "QuestionDef", "question", "GroupDef", "group");

    /** What holds the appearance a read of it takes (`question` or `group`), by the declared type of what the
     *  call reads it from, or null where the source does not say (a `FormEntryCaption`, which either is). */
    private String holderOf(MethodCallExpr call) {
        if (!call.getScope().isPresent()) {
            return null;
        }
        Expression scope = call.getScope().get();
        String type = typeOf(scope);
        if (type == null && scope instanceof MethodCallExpr) {
            for (CallableDeclaration<?> target : targets((MethodCallExpr) scope)) {
                if (target instanceof MethodDeclaration) {
                    type = simple(((MethodDeclaration) target).getType());
                }
            }
        }
        return type == null ? null : HOLDERS.get(type);
    }

    // -- taint ------------------------------------------------------------------------

    private Set<String> taintOf(Expression expression) {
        Set<String> labels = new TreeSet<>();
        if (expression == null) {
            return labels;
        }
        if (expression instanceof EnclosedExpr) {
            return taintOf(((EnclosedExpr) expression).getInner());
        }
        if (expression instanceof CastExpr) {
            return taintOf(((CastExpr) expression).getExpression());
        }
        if (expression instanceof ConditionalExpr) {
            labels.addAll(taintOf(((ConditionalExpr) expression).getThenExpr()));
            labels.addAll(taintOf(((ConditionalExpr) expression).getElseExpr()));
            return labels;
        }
        if (expression instanceof NameExpr) {
            String entity = nameEntity(((NameExpr) expression).getNameAsString(), expression);
            return entity == null ? labels : new TreeSet<>(taint.getOrDefault(entity, Set.of()));
        }
        if (expression instanceof FieldAccessExpr && ((FieldAccessExpr) expression).getScope() instanceof ThisExpr) {
            String entity = fieldEntity(Code.typeOf(expression), ((FieldAccessExpr) expression).getNameAsString());
            return entity == null ? labels : new TreeSet<>(taint.getOrDefault(entity, Set.of()));
        }
        if (expression instanceof MethodCallExpr) {
            MethodCallExpr call = (MethodCallExpr) expression;
            String name = call.getNameAsString();
            if ((name.equals("getAppearanceHint") || name.equals("getAppearanceAttr")) && call.getArguments().isEmpty()) {
                String holder = holderOf(call);
                labels.add("control" + (holder == null ? "" : "." + holder) + ":raw");
                return labels;
            }
            if (name.equals("getAttributeValue") && call.getArguments().size() == 2
                    && "appearance".equals(code.constant(call.getArgument(1), Code.typeOf(call)))) {
                labels.add("attribute:" + Code.typeOf(call).getNameAsString() + ":raw");
                return labels;
            }
            if (TRANSFORMS.contains(name) && call.getScope().isPresent()) {
                for (String label : taintOf(call.getScope().get())) {
                    String kind = label.substring(0, label.lastIndexOf(':'));
                    labels.add(name.equals("toLowerCase") ? kind + ":lower" : label);
                }
                return labels;
            }
            if ((name.equals("getString") || name.equals("getStringExtra")) && call.getArguments().size() >= 1) {
                String bundleKey = code.constant(call.getArgument(0), Code.typeOf(call));
                if (bundleKey != null) {
                    labels.addAll(taint.getOrDefault("bundle:" + bundleKey, Set.of()));
                }
            }
            for (CallableDeclaration<?> target : targets(call)) {
                labels.addAll(taint.getOrDefault(key(target) + "#return", Set.of()));
            }
        }
        return labels;
    }

    private boolean propagate() {
        boolean changed = false;
        for (Code.Unit unit : code.units) {
            for (VariableDeclarator variable : unit.tree.findAll(VariableDeclarator.class)) {
                if (variable.getInitializer().isPresent()) {
                    Set<String> labels = taintOf(variable.getInitializer().get());
                    boolean isField = variable.getParentNode().orElse(null) instanceof FieldDeclaration;
                    String entity = isField ? fieldEntity(Code.typeOf(variable), variable.getNameAsString())
                            : nameEntity(variable.getNameAsString(), variable);
                    changed |= add(entity, labels);
                }
            }
            for (AssignExpr assign : unit.tree.findAll(AssignExpr.class)) {
                Set<String> labels = taintOf(assign.getValue());
                Expression target = assign.getTarget();
                if (target instanceof NameExpr) {
                    changed |= add(nameEntity(((NameExpr) target).getNameAsString(), target), labels);
                } else if (target instanceof FieldAccessExpr && ((FieldAccessExpr) target).getScope() instanceof ThisExpr) {
                    changed |= add(fieldEntity(Code.typeOf(target), ((FieldAccessExpr) target).getNameAsString()), labels);
                }
            }
            for (ReturnStmt returned : unit.tree.findAll(ReturnStmt.class)) {
                CallableDeclaration<?> callable = callableOf(returned);
                if (callable != null && returned.getExpression().isPresent()) {
                    changed |= add(key(callable) + "#return", taintOf(returned.getExpression().get()));
                }
            }
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                if ((name.equals("putString") || name.equals("putExtra")) && call.getArguments().size() == 2) {
                    String bundleKey = code.constant(call.getArgument(0), Code.typeOf(call));
                    if (bundleKey != null) {
                        changed |= add("bundle:" + bundleKey, taintOf(call.getArgument(1)));
                    }
                }
            }
        }
        for (Map.Entry<CallableDeclaration<?>, List<Node>> entry : callSites.entrySet()) {
            CallableDeclaration<?> target = entry.getKey();
            for (Node site : entry.getValue()) {
                List<Expression> arguments = arguments(site);
                for (int i = 0; i < arguments.size() && i < target.getParameters().size(); i++) {
                    Set<String> labels = taintOf(arguments.get(i));
                    changed |= add(key(target) + "#param:" + target.getParameter(i).getNameAsString(), labels);
                }
            }
        }
        return changed;
    }

    @SuppressWarnings("unchecked")
    private static List<Expression> arguments(Node site) {
        if (site instanceof NodeWithArguments) {
            return new ArrayList<>(((NodeWithArguments<?>) site).getArguments());
        }
        return List.of();
    }

    // -- values -----------------------------------------------------------------------

    /** The constant strings an expression can hold, following parameters, getters and fields back. */
    private Set<String> values(Expression expression, int depth) {
        Set<String> found = new TreeSet<>();
        if (expression == null || depth > VALUE_DEPTH) {
            return found;
        }
        String constant = code.constant(expression, Code.typeOf(expression));
        if (constant != null) {
            found.add(constant);
            return found;
        }
        if (expression instanceof EnclosedExpr) {
            return values(((EnclosedExpr) expression).getInner(), depth);
        }
        if (expression instanceof NameExpr) {
            String name = ((NameExpr) expression).getNameAsString();
            CallableDeclaration<?> callable = callableOf(expression);
            if (callable != null) {
                for (int i = 0; i < callable.getParameters().size(); i++) {
                    if (callable.getParameter(i).getNameAsString().equals(name)) {
                        for (Node site : callSites.getOrDefault(callable, List.of())) {
                            List<Expression> arguments = arguments(site);
                            if (i < arguments.size()) {
                                found.addAll(values(arguments.get(i), depth + 1));
                            }
                        }
                        return found;
                    }
                }
            }
            return fieldValues(Code.typeOf(expression), name, depth);
        }
        if (expression instanceof FieldAccessExpr && ((FieldAccessExpr) expression).getScope() instanceof ThisExpr) {
            return fieldValues(Code.typeOf(expression), ((FieldAccessExpr) expression).getNameAsString(), depth);
        }
        if (expression instanceof MethodCallExpr) {
            for (CallableDeclaration<?> target : targets((MethodCallExpr) expression)) {
                for (ReturnStmt returned : target.findAll(ReturnStmt.class)) {
                    returned.getExpression().ifPresent(e -> found.addAll(values(e, depth + 1)));
                }
            }
        }
        return found;
    }

    private Set<String> fieldValues(TypeDeclaration<?> context, String name, int depth) {
        Set<String> found = new TreeSet<>();
        VariableDeclarator field = code.field(context, name);
        if (field == null) {
            return found;
        }
        TypeDeclaration<?> owner = Code.typeOf(field);
        field.getInitializer().ifPresent(init -> found.addAll(values(init, depth + 1)));
        for (AssignExpr assign : owner.findAll(AssignExpr.class)) {
            Expression target = assign.getTarget();
            boolean named = (target instanceof NameExpr && ((NameExpr) target).getNameAsString().equals(name))
                    || (target instanceof FieldAccessExpr && ((FieldAccessExpr) target).getScope() instanceof ThisExpr
                    && ((FieldAccessExpr) target).getNameAsString().equals(name));
            if (named && callableOf(assign) instanceof ConstructorDeclaration) {
                found.addAll(values(assign.getValue(), depth + 1));
            }
        }
        return found;
    }

    // -- sinks ------------------------------------------------------------------------

    /** One read's sites, what holds the values it compares and the questions that reach it, over its sites. */
    private static final class Read {
        final Set<String> at = new TreeSet<>();
        final Set<String> holders = new TreeSet<>();
        final Set<String> controls = new TreeSet<>();
        final Set<String> datatypes = new TreeSet<>();
        boolean anyControl;
        boolean anyDatatype;
    }

    private List<Object> sinks() {
        Map<List<String>, Read> found = new TreeMap<>((a, b) -> String.join("\n", a).compareTo(String.join("\n", b)));
        for (Code.Unit unit : code.units) {
            for (MethodCallExpr call : unit.tree.findAll(MethodCallExpr.class)) {
                String name = call.getNameAsString();
                String match = name.equals("split") ? "split" : SINKS.get(name);
                if (match == null || call.getArguments().size() != 1 || !call.getScope().isPresent()) {
                    continue;
                }
                Expression scope = call.getScope().get();
                Expression argument = call.getArgument(0);
                Set<String> scopeTaint = taintOf(scope);
                boolean ignoreCase = name.equals("equalsIgnoreCase");
                if (!scopeTaint.isEmpty()) {
                    record(found, unit, call, scopeTaint, values(argument, 0), match, ignoreCase);
                } else if (match.equals("whole")) {
                    Set<String> argumentTaint = taintOf(argument);
                    if (!argumentTaint.isEmpty()) {
                        record(found, unit, call, argumentTaint, values(scope, 0), match, ignoreCase);
                    }
                }
            }
            for (SwitchStmt choice : unit.tree.findAll(SwitchStmt.class)) {
                Set<String> labels = taintOf(choice.getSelector());
                if (labels.isEmpty()) {
                    continue;
                }
                Set<String> tokens = new TreeSet<>();
                for (SwitchEntry entry : choice.getEntries()) {
                    for (Expression label : entry.getLabels()) {
                        tokens.addAll(values(label, 0));
                    }
                }
                record(found, unit, choice, labels, tokens, "whole", false);
            }
        }
        List<Object> out = new ArrayList<>();
        for (Map.Entry<List<String>, Read> entry : found.entrySet()) {
            Read sites = entry.getValue();
            Map<String, Object> read = new TreeMap<>();
            read.put("reader", entry.getKey().get(0));
            read.put("token", entry.getKey().get(1));
            read.put("match", entry.getKey().get(2));
            read.put("case", entry.getKey().get(3));
            read.put("at", new ArrayList<>(sites.at));
            if (!sites.holders.isEmpty() && !sites.holders.contains("*")) {
                read.put("holders", new ArrayList<>(sites.holders));
            }
            if (!sites.anyControl && !sites.controls.isEmpty()) {
                read.put("controls", new ArrayList<>(sites.controls));
            }
            if (!sites.anyDatatype && !sites.datatypes.isEmpty()) {
                read.put("datatypes", new ArrayList<>(sites.datatypes));
            }
            out.add(read);
        }
        return out;
    }

    private void record(Map<List<String>, Read> found, Code.Unit unit, Node at, Set<String> labels,
                        Set<String> tokens, String match, boolean ignoreCase) {
        String where = code.where(at);
        Set<String> resolved = tokens.isEmpty() ? Set.of("<unresolved>") : tokens;
        Reach reach = reach(at);
        for (String label : labels) {
            String kind = label.substring(0, label.lastIndexOf(':'));
            boolean control = kind.equals("control") || kind.startsWith("control.");
            String holder = kind.startsWith("control.") ? kind.substring("control.".length()) : "*";
            String caseHandling = ignoreCase ? "ignore-case" : label.endsWith(":lower") ? "lowercased" : "exact";
            String reader = control ? unit.platform : unit.platform + "/" + kind;
            for (String token : resolved) {
                Read read = found.computeIfAbsent(List.of(reader, token, match, caseHandling), k -> new Read());
                read.at.add(where);
                read.holders.add(holder);
                read.controls.addAll(reach.controls);
                read.datatypes.addAll(reach.datatypes);
                read.anyControl |= reach.anyControl;
                read.anyDatatype |= reach.anyDatatype;
            }
        }
    }

    // -- reach ------------------------------------------------------------------------

    /** How deep the walk from a read up its callers goes before it takes the read as reached by any question. */
    private static final int REACH_DEPTH = 12;

    /** The control types and data types of the questions a read is reached by; `any` where some way reaches it
     *  through no switch on that. */
    private static final class Reach {
        final Set<String> controls = new TreeSet<>();
        final Set<String> datatypes = new TreeSet<>();
        boolean anyControl;
        boolean anyDatatype;

        void add(Set<String> controlLabels, Set<String> datatypeLabels) {
            if (controlLabels == null || controlLabels.contains("*")) {
                anyControl = true;
            } else {
                controls.addAll(controlLabels);
            }
            if (datatypeLabels == null || datatypeLabels.contains("*")) {
                anyDatatype = true;
            } else {
                datatypes.addAll(datatypeLabels);
            }
        }
    }

    /** Each read site's reach, by the node itself: JavaParser's nodes are equal by their text, and two
     *  sites written alike (`appearance.indexOf('-')` in two methods) are reached apart. */
    private final Map<Node, Reach> reaches = new IdentityHashMap<>();

    /** The questions that reach a read at `node`: each way up from it, through its method's callers, to the
     *  first switch on a prompt's control type and the first on its data type (or to a method no code calls). */
    private Reach reach(Node node) {
        Reach known = reaches.get(node);
        if (known != null) {
            return known;
        }
        Reach reach = new Reach();
        walk(node, null, null, 0, Collections.newSetFromMap(new IdentityHashMap<>()), reach);
        if (!reach.anyControl && reach.controls.isEmpty()) {
            reach.anyControl = true;  // every way up looped back: no switch is known to reach it
        }
        if (!reach.anyDatatype && reach.datatypes.isEmpty()) {
            reach.anyDatatype = true;
        }
        reaches.put(node, reach);
        return reach;
    }

    private void walk(Node node, Set<String> controls, Set<String> datatypes, int depth, Set<CallableDeclaration<?>> visiting,
                      Reach reach) {
        Node current = node;
        while (current != null && !(current instanceof CallableDeclaration) && !(current instanceof TypeDeclaration)) {
            Node parent = current.getParentNode().orElse(null);
            if (current instanceof SwitchEntry && parent instanceof SwitchStmt) {
                SwitchStmt choice = (SwitchStmt) parent;
                String selector = selectorKind(choice.getSelector());
                if ("control".equals(selector) && controls == null) {
                    controls = entryLabels(choice, (SwitchEntry) current);
                } else if ("datatype".equals(selector) && datatypes == null) {
                    datatypes = entryLabels(choice, (SwitchEntry) current);
                }
            }
            current = parent;
        }
        if (controls != null && datatypes != null) {
            reach.add(controls, datatypes);
            return;
        }
        CallableDeclaration<?> callable = current instanceof CallableDeclaration ? (CallableDeclaration<?>) current : null;
        List<Node> sites = callable == null ? List.of() : callSites.getOrDefault(callable, List.of());
        if (sites.isEmpty() || depth >= REACH_DEPTH) {
            reach.add(controls, datatypes);
            return;
        }
        if (!visiting.add(callable)) {
            return;  // a way that loops back adds nothing the way into the loop does not
        }
        for (Node site : sites) {
            walk(site, controls, datatypes, depth + 1, visiting, reach);
        }
        visiting.remove(callable);
    }

    /** Whether a switch chooses by a prompt's control type (`control`), its data type (`datatype`), or neither. */
    private static String selectorKind(Expression selector) {
        Expression inner = selector;
        while (inner instanceof EnclosedExpr) {
            inner = ((EnclosedExpr) inner).getInner();
        }
        if (inner instanceof MethodCallExpr && ((MethodCallExpr) inner).getArguments().isEmpty()) {
            String name = ((MethodCallExpr) inner).getNameAsString();
            if (name.equals("getControlType")) {
                return "control";
            }
            if (name.equals("getDataType")) {
                return "datatype";
            }
        }
        return null;
    }

    /** The labels a case is reached by: its own and those of each case before it that falls through into it
     *  (`*` for `default`). */
    private static Set<String> entryLabels(SwitchStmt choice, SwitchEntry entry) {
        List<SwitchEntry> entries = choice.getEntries();
        int index = -1;
        for (int i = 0; i < entries.size(); i++) {
            if (entries.get(i) == entry) {
                index = i;
            }
        }
        Set<String> labels = new TreeSet<>();
        for (int i = index; i >= 0; i--) {
            SwitchEntry each = entries.get(i);
            if (i < index && !fallsThrough(each)) {
                break;
            }
            if (each.getLabels().isEmpty()) {
                labels.add("*");
            }
            for (Expression label : each.getLabels()) {
                labels.add(label instanceof FieldAccessExpr ? ((FieldAccessExpr) label).getNameAsString()
                        : label instanceof NameExpr ? ((NameExpr) label).getNameAsString() : label.toString());
            }
        }
        return labels;
    }

    private static boolean fallsThrough(SwitchEntry entry) {
        if (entry.getType() != SwitchEntry.Type.STATEMENT_GROUP) {
            return false;
        }
        List<Statement> statements = entry.getStatements();
        if (statements.isEmpty()) {
            return true;
        }
        Statement last = statements.get(statements.size() - 1);
        return !(last instanceof BreakStmt || last instanceof ReturnStmt || last instanceof ThrowStmt
                || last instanceof ContinueStmt || last instanceof YieldStmt);
    }
}
