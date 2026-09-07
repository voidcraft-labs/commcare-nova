package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.expr.FunctionUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Actual suite definitions and forms, with native cases and explicit runtime inputs. */
public class NavigationRuntimeTest {
    private static final class ReadOnlyParser extends SuiteParser {
        ReadOnlyParser(InputStream stream) throws IOException { super(stream, null, "nova-navigation", null, true, true, false); }
    }
    private Suite suite(String name) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/" + name + ".suite.xml")) {
            assertNotNull(name, input);
            return new ReadOnlyParser(input).parse();
        }
    }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private static class RuntimeData extends TestInstanceInitializer {
        final MockUserDataSandbox sandbox;
        final String role;
        final String exclusions;
        final Map<String, String> inputs;
        RuntimeData(String role, String exclusions, Map<String, String> inputs) {
            this(MockDataUtils.getStaticStorage(), role, exclusions, inputs);
        }
        private RuntimeData(MockUserDataSandbox sandbox, String role, String exclusions, Map<String, String> inputs) {
            super(sandbox);
            this.sandbox = sandbox;
            this.role = role;
            this.exclusions = exclusions;
            this.inputs = inputs;
            for (int i = 1; i <= 5; i++) {
                Case c = new Case("Patient " + i, "patient");
                c.setCaseId("patient-" + i);
                c.setUserId(i == 4 ? "" : "owner-" + (char)('a' + i - 1));
                c.setClosed(i == 5);
                c.setProperty("notes", "Saved note");
                sandbox.getCaseStorage().write(c);
            }
            Case worker = new Case("Worker", "commcare-user");
            worker.setCaseId("worker-case");
            worker.setProperty("hq_user_id", "worker-1");
            worker.setProperty("role", role);
            sandbox.getCaseStorage().write(worker);
        }
        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            String id = instance.getInstanceId();
            TreeElement root;
            if ("commcaresession".equals(id)) {
                root = node("session", null);
                TreeElement context = node("context", null);
                for (String key : new String[]{"deviceid", "username", "appversion"}) context.addChild(node(key, "fixture-" + key));
                context.addChild(node("userid", "worker-1"));
                context.addChild(node("drift", "0"));
                root.addChild(context);
                TreeElement data = node("data", null);
                data.addChild(node("case_id", "patient-1"));
                data.addChild(node("case_id_new_patient_0", "new-patient"));
                root.addChild(data);
                TreeElement user = node("user", null);
                TreeElement userData = node("data", null);
                userData.addChild(node("role", role));
                userData.addChild(node("excluded_owners", exclusions));
                user.addChild(userData);
                root.addChild(user);
            } else if ("search-input:results".equals(id)) {
                root = node("input", null);
                int index = 0;
                for (Map.Entry<String, String> input : inputs.entrySet()) {
                    TreeElement field = new TreeElement("field", index++);
                    field.setAttribute(null, "name", input.getKey());
                    field.setValue(new StringData(input.getValue()));
                    root.addChild(field);
                }
            } else return super.generateRoot(instance);
            InstanceUtils.setUpInstanceRoot(root, id, instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
        EvaluationContext context(Hashtable<String, DataInstance> instances) {
            for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(this, id));
            return new EvaluationContext(null, instances);
        }
        FormDef form(String file) throws Exception {
            FormDef form = new FormParseInit("/" + file).getFormDef();
            form.initialize(true, this);
            return form;
        }
    }

    @Test public void savedValueOverridesAuthoredDefaultOnBothPaths() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String saved : new String[]{"Saved note", ""}) {
            RuntimeData data = new RuntimeData("worker", "", Collections.emptyMap());
            Case c = data.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
            c.setProperty("notes", saved);
            data.sandbox.getCaseStorage().write(c);
            FormDef form = data.form("base.0" + (hq ? ".hq.xml" : ".xml"));
            assertEquals(saved, ExprEvalUtils.xpathEval(form.getEvaluationContext(), "string(/data/answer)"));
        }
    }

    @Test public void ordinaryRegistrationStoresNormalizedExternalIdOnBothPaths() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            RuntimeData data = new RuntimeData("worker", "", Collections.emptyMap());
            FormDef form = data.form("base.1" + (hq ? ".hq.xml" : ".xml"));
            form.postProcessInstance();
            byte[] submission = new XFormSerializingVisitor().serializeInstance(form.getMainInstance());
            XmlFormRecordProcessor.process(data.sandbox, new ByteArrayInputStream(submission));
            Case c = data.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "new-patient");
            assertNotNull(c);
            assertEquals("patient", c.getTypeId());
            assertEquals("Default name", c.getName());
            assertEquals("Ext-1", c.getExternalId());
            assertEquals("worker-1", c.getUserId());
        }
    }

    @Test public void ownerAvailabilityPreservesUnassignedAndUsesWhitespaceTokens() throws Exception {
        for (String exclusions : new String[]{"", " \towner-a \n owner-b\r "}) {
            RuntimeData data = new RuntimeData("worker", exclusions, Collections.emptyMap());
            Entry entry = suite("owner").getEntry("m0-f0");
            EvaluationContext context = data.context(entry.getInstances(null));
            EntityDatum selected = (EntityDatum)entry.getSessionDataReqs().firstElement();
            Set<String> ids = new TreeSet<>();
            for (TreeReference ref : context.expandReference(selected.getNodeset())) {
                ids.add((String)context.resolveReference(ref).getAttribute(null, "case_id").getValue().getValue());
            }
            assertEquals(new TreeSet<>(exclusions.isEmpty() ? Arrays.asList("patient-1", "patient-2", "patient-3", "patient-4") : Arrays.asList("patient-3", "patient-4")), ids);
        }
    }

    @Test public void moduleAndCaseConditionsUseTheirDeclaredInstances() throws Exception {
        for (String role : new String[]{"worker", "supervisor"}) {
            RuntimeData data = new RuntimeData(role, "", Collections.emptyMap());
            Suite suite = suite("conditions");
            Menu menu = suite.getMenus().firstElement();
            assertEquals(role.equals("supervisor"), FunctionUtils.toBoolean(menu.getMenuRelevance().eval(data.context(menu.getInstances(null)))));
            for (boolean closed : new boolean[]{false, true}) {
                Case c = data.sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID, "patient-1");
                c.setClosed(closed);
                data.sandbox.getCaseStorage().write(c);
                EvaluationContext context = data.context(suite.getEntry("m0-f0").getInstances(null));
                assertEquals(!closed, FunctionUtils.toBoolean(menu.getCommandRelevance(0).eval(context)));
            }
        }
    }

    @Test public void conditionalLinkAndFallbackChooseTheNativeFrame() throws Exception {
        for (String role : new String[]{"worker", "supervisor"}) {
            RuntimeData data = new RuntimeData(role, "", Collections.emptyMap());
            Entry entry = suite("links").getEntry("m0-f0");
            EvaluationContext context = data.context(entry.getInstances(null));
            List<List<String>> active = new ArrayList<>();
            for (StackOperation op : entry.getPostEntrySessionOperations()) {
                assertEquals(StackOperation.OPERATION_CREATE, op.getOp());
                if (!op.isOperationTriggered(context)) continue;
                List<String> commands = new ArrayList<>();
                for (StackFrameStep step : op.getStackFrameSteps()) commands.add(step.evaluateValue(context));
                active.add(commands);
            }
            assertEquals(Collections.singletonList(role.equals("supervisor") ? Arrays.asList("m0", "m0-f1") : Collections.singletonList("m0")), active);
        }
    }

    @Test public void evaluatesSearchPayloadsForNativeHqConsumption() throws Exception {
        List<String> output = new ArrayList<>();
        for (String scenario : new String[]{"legacy", "date-add", "datetime-add", "day-range"}) {
            for (boolean supplied : new boolean[]{false, true}) {
                Map<String, String> inputs = new LinkedHashMap<>();
                if (supplied) for (String name : scenario.equals("day-range") ? new String[]{"visit_date", "last_seen", "date_opened"} : new String[]{"base_date"}) inputs.put(name, "2024-02-29");
                RuntimeData data = new RuntimeData("worker", "", inputs);
                Entry entry = suite("search-" + scenario).getEntry("search_command.m0");
                assertNotNull(entry);
                RemoteQueryDatum query = (RemoteQueryDatum)entry.getSessionDataReqs().firstElement();
                Hashtable<String, DataInstance> instances = entry.getInstances(null);
                // The Search engine supplies this dynamic instance after collecting prompts.
                instances.put("search-input:results", new ExternalDataInstance("jr://instance/search-input:results", "search-input:results"));
                EvaluationContext context = data.context(instances);
                List<String> queries = new ArrayList<>();
                for (QueryData value : query.getHiddenQueryValues()) if ("_xpath_query".equals(value.getKey())) for (String text : value.getValues(context)) queries.add(text);
                assertEquals(scenario.equals("legacy") ? 0 : scenario.equals("day-range") ? 3 : 1, queries.size());
                if (!supplied) for (String text : queries) assertEquals("match-all()", text);
                else if (scenario.equals("date-add")) assertEquals(Collections.singletonList("visit_date = date-add(\"2024-02-29\", 'days', 7)"), queries);
                else if (scenario.equals("datetime-add")) assertEquals(Collections.singletonList("last_seen = datetime-add(datetime(\"2024-02-29\"), 'hours', 1)"), queries);
                else if (scenario.equals("day-range")) assertEquals(Arrays.asList(
                    "visit_date >= date(\"2024-02-29\") and visit_date < date-add(date(\"2024-02-29\"), 'days', 1)",
                    "last_seen >= datetime(\"2024-02-29\") and last_seen < datetime(date-add(date(\"2024-02-29\"), 'days', 1))",
                    "date_opened >= datetime(\"2024-02-29\") and date_opened < datetime(date-add(date(\"2024-02-29\"), 'days', 1))"), queries);
                for (String text : queries) output.add(scenario + "\t" + supplied + "\t" + text);
            }
        }
        assertEquals(10, output.size());
        Files.write(Paths.get("build/nova-search-payloads.tsv"), output, StandardCharsets.UTF_8);
    }
}
