package nova.compatibility;

import java.io.InputStream;
import java.io.IOException;
import java.util.*;
import org.commcare.suite.model.*;
import org.commcare.session.SessionFrame;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.util.CommCarePlatform;
import org.commcare.cases.model.Case;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.junit.Test;
import static org.junit.Assert.*;

public class SearchRuntimeTest {
    private static final class ReadOnlyParser extends SuiteParser {
        ReadOnlyParser(InputStream stream) throws IOException { super(stream, null, "nova-search", null, true, true, false); }
    }
    private Suite suite(String name, boolean hq) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/" + name + (hq ? ".hq-suite.xml" : ".suite.xml"))) {
            assertNotNull(name, input);
            return new ReadOnlyParser(input).parse();
        }
    }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private static final class RuntimeData extends TestInstanceInitializer {
        final Set<String> local;
        final List<String> selected;
        RuntimeData(Set<String> local, List<String> selected) {
            this(MockDataUtils.getStaticStorage(), local, selected);
        }
        private RuntimeData(MockUserDataSandbox sandbox, Set<String> local, List<String> selected) {
            super(sandbox);
            this.local = local;
            this.selected = selected;
            for (String id : local) {
                Case c = new Case(id, "patient");
                c.setCaseId(id);
                sandbox.getCaseStorage().write(c);
            }
        }
        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            String id = instance.getInstanceId();
            // Allocate the native instance base without inventing an answered input root.
            if (id.startsWith("search-input:")) return new ConcreteInstanceRoot(null);
            TreeElement root;
            if (id.equals("commcaresession")) {
                root = node("session", null);
                TreeElement data = node("data", null);
                data.addChild(node("case_id", "patient-1"));
                data.addChild(node("search_case_id", "patient-1"));
                data.addChild(node("parent_id", "parent-1"));
                root.addChild(data);
                TreeElement user = node("user", null);
                TreeElement values = node("data", null);
                values.addChild(node("default_name", "Ada"));
                values.addChild(node("excluded_owners", " \towner-a \n owner-b\r "));
                user.addChild(values);
                root.addChild(user);
            } else if (id.equals("selected_cases") || id.equals("search_selected_cases")) {
                root = node("results", null);
                for (int i = 0; i < selected.size(); i++) {
                    TreeElement value = new TreeElement("value", i);
                    value.setValue(new StringData(selected.get(i)));
                    root.addChild(value);
                }
            } else if (id.equals("results") || id.equals("results:inline")) {
                root = node("results", null);
                for (int i = 1; i <= 6; i++) {
                    TreeElement c = new TreeElement("case", i - 1);
                    c.setAttribute(null, "case_id", "patient-" + i);
                    c.setAttribute(null, "case_type", i == 4 ? "other" : "patient");
                    c.setAttribute(null, "status", i == 3 ? "closed" : "open");
                    if (i == 5) c.addChild(node("commcare_is_related_case", "true"));
                    TreeElement index = node("index", null);
                    TreeElement parent = node("parent", i == 2 ? "parent-2" : "parent-1");
                    parent.setAttribute(null, "relationship", i == 6 ? "extension" : "child");
                    index.addChild(parent);
                    c.addChild(index);
                    root.addChild(c);
                }
            } else return super.generateRoot(instance);
            InstanceUtils.setUpInstanceRoot(root, id, instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
        EvaluationContext context(Entry entry) {
            Hashtable<String, DataInstance> instances = entry.getInstances(null);
            for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(this, id));
            return new EvaluationContext(null, instances);
        }
    }
    @Test public void nativeSelectionFiltersTypeRelatedRowsStatusAndParent() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String scenario : new String[]{"inline", "parent", "multiple", "remote", "remote-multiple"}) {
            Entry entry = suite(scenario, hq).getEntry(scenario.startsWith("remote") ? "search_command.m0" : "m0-f0");
            EvaluationContext context = new RuntimeData(Collections.emptySet(), Collections.emptyList()).context(entry);
            EntityDatum selected = (EntityDatum)entry.getSessionDataReqs().lastElement();
            List<String> ids = new ArrayList<>();
            for (TreeReference ref : context.expandReference(selected.getNodeset())) ids.add((String)context.resolveReference(ref).getAttribute(null, "case_id").getValue().getValue());
            // Remote Search returns closed results; the inline form path requires open cases.
            assertEquals(scenario + " hq=" + hq, scenario.equals("parent") ? Arrays.asList("patient-1") : scenario.startsWith("remote") ? Arrays.asList("patient-1", "patient-2", "patient-3", "patient-6") : Arrays.asList("patient-1", "patient-2", "patient-6"), ids);
        }
    }
    @Test public void nativeClaimIncludesOnlyMissingSelectedCases() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String scenario : new String[]{"inline", "parent", "multiple", "remote", "remote-multiple"}) for (boolean allLocal : new boolean[]{false, true}) {
            boolean multiple = scenario.contains("multiple");
            Set<String> local = new HashSet<>(allLocal ? Arrays.asList("patient-1", "patient-2", "parent-1") : Arrays.asList("patient-2", "parent-1"));
            Entry entry = suite(scenario, hq).getEntry(scenario.startsWith("remote") ? "search_command.m0" : "m0-f0");
            EvaluationContext context = new RuntimeData(local, Arrays.asList("patient-1", "patient-2")).context(entry);
            PostRequest post = entry.getPostRequest();
            assertEquals(scenario + " hq=" + hq, !allLocal, post.isRelevant(context));
            // A single selection stays in the body even when the request is irrelevant.
            assertEquals(allLocal && (multiple || scenario.equals("parent")) ? Collections.emptyList() : Arrays.asList("patient-1"), new ArrayList<>(post.getEvaluatedParams(context, false).get("case_id")));
        }
    }
    @Test public void nativeDetailReadsOnlyTheTypedSupportingParent() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (boolean correctType : new boolean[]{false, true}) for (String scenario : new String[]{"multiple", "remote-multiple"}) {
            boolean remote = scenario.startsWith("remote");
            Suite suite = suite(scenario, hq);
            Entry entry = suite.getEntry(remote ? "search_command.m0" : "m0-f0");
            EvaluationContext context = new RuntimeData(Collections.emptySet(), Collections.emptyList()).context(entry);
            TreeElement root = (TreeElement)context.getInstance(remote ? "results" : "results:inline").getRoot();
            TreeElement parent = new TreeElement("case", 6);
            parent.setAttribute(null, "case_id", "parent-1");
            parent.setAttribute(null, "case_type", correctType ? "patient" : "other");
            parent.addChild(node("first_name", "Family"));
            parent.addChild(node("commcare_is_related_case", "true"));
            root.addChild(parent);
            EntityDatum selected = (EntityDatum)entry.getSessionDataReqs().lastElement();
            TreeReference first = context.expandReference(selected.getNodeset()).get(0);
            Detail detail = suite.getDetail(remote ? "m0_search_short" : "m0_case_short");
            assertEquals(2, detail.getFields().length);
            assertEquals(correctType ? "Family" : "", ((Text)detail.getFields()[1].getTemplate()).evaluate(new EvaluationContext(context, first)));
        }
    }
    @Test public void nativeQueryManagerOwnsDefaultsHiddenInputsAndAnswerPayloads() throws Exception {
        for (boolean hq : new boolean[]{false, true}) for (String scenario : new String[]{"automatic", "hidden", "advanced", "remote-defaults"}) {
            Suite suite = suite(scenario, hq);
            CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
            platform.registerSuite(suite);
            CommCareSession session = new CommCareSession(platform);
            String command = scenario.startsWith("remote") ? "search_command.m0" : "m0-f0";
            session.setCommand(command);
            RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(session, new RuntimeData(Collections.emptySet(), Collections.emptyList()).context(suite.getEntry(command)), Arrays.asList("text"));
            assertNotNull(manager);
            assertEquals(scenario.equals("automatic") || scenario.equals("hidden"), manager.doDefaultSearch());
            Map<String, String> expectedAnswers = new HashMap<>();
            if (scenario.equals("hidden")) expectedAnswers.put("search_time", "now");
            if (scenario.equals("remote-defaults")) { expectedAnswers.put("first_name", "Ada"); expectedAnswers.put("echo", "Ada"); }
            assertEquals(expectedAnswers, manager.getUserAnswers());
            com.google.common.collect.Multimap<String, String> expected = com.google.common.collect.ArrayListMultimap.create();
            expected.put("case_type", "patient");
            if (scenario.equals("automatic") && hq || scenario.equals("advanced")) expected.put("_xpath_query", "match-all()");
            if (scenario.equals("remote-defaults")) {
                expected.put("_xpath_query", "first_name = \"Ada\"");
                expected.put("first_name", "Ada");
                expected.put("commcare_blacklisted_owner_ids", "owner-a owner-b");
            }
            assertEquals(scenario + " hq=" + hq, expected, manager.getRawQueryParams(false));
            if (scenario.equals("advanced") || scenario.equals("remote-defaults")) {
                String key = scenario.equals("advanced") ? "note" : "echo";
                manager.answerUserPrompt(key, "Bea");
                expected.replaceValues("_xpath_query", Arrays.asList("first_name = \"Bea\""));
                assertEquals(expected, manager.getRawQueryParams(false));
                manager.answerUserPrompt(key, null);
                expected.replaceValues("_xpath_query", Arrays.asList("match-all()"));
                assertEquals(expected, manager.getRawQueryParams(false));
            }
        }
    }
    private EvaluationContext sourceContext(Entry entry) {
        TestInstanceInitializer initializer = new TestInstanceInitializer(MockDataUtils.getStaticStorage()) {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                if (!"commcaresession".equals(instance.getInstanceId())) return super.generateRoot(instance);
                TreeElement root = node("session", null);
                TreeElement data = node("data", null);
                data.addChild(node("case_id_new_patient_0", "new-patient"));
                root.addChild(data);
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), instance.getBase());
                return new ConcreteInstanceRoot(root);
            }
        };
        Hashtable<String, DataInstance> instances = entry.getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(initializer, id));
        return new EvaluationContext(null, instances);
    }
    @Test public void localHydrationFetchesTheCaseAssignedByTheLink() throws Exception { hydration(false); }
    @Test public void hqHydrationFetchesTheCaseAssignedByTheLink() throws Exception { hydration(true); }
    @Test public void oldManualFrameCannotReadTheFutureSelection() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            Entry entry = suite("before-manual-search-link", hq).getEntry("m1-f0");
            EvaluationContext context = sourceContext(entry);
            List<StackFrameStep> querySteps = new ArrayList<>();
            for (StackFrameStep step : entry.getPostEntrySessionOperations().firstElement().getStackFrameSteps()) {
                if (SessionFrame.STATE_QUERY_REQUEST.equals(step.getType())) querySteps.add(step);
            }
            assertEquals(1, querySteps.size());
            assertThrows(org.javarosa.xpath.XPathTypeMismatchException.class, () -> querySteps.get(0).defineStep(context, null));
        }
    }
    private void hydration(boolean hq) throws Exception {
        for (String scenario : new String[]{"registration-link", "hidden-link"}) {
            Entry entry = suite(scenario, hq).getEntry("m1-f0");
            EvaluationContext context = sourceContext(entry);
            StackOperation operation = entry.getPostEntrySessionOperations().firstElement();
            assertTrue(operation.isOperationTriggered(context));
            List<StackFrameStep> queries = new ArrayList<>();
            List<StackFrameStep> datums = new ArrayList<>();
            for (StackFrameStep step : operation.getStackFrameSteps()) {
                StackFrameStep defined = step.defineStep(context, null);
                if (SessionFrame.STATE_QUERY_REQUEST.equals(step.getType())) queries.add(defined);
                if (SessionFrame.STATE_UNKNOWN.equals(step.getType())) datums.add(defined);
            }
            assertEquals(1, queries.size());
            assertEquals(1, datums.size());
            assertEquals("new-patient", datums.get(0).getValue());
            assertEquals(scenario + " hq=" + hq, Collections.singletonList("new-patient"), new ArrayList<>(queries.get(0).getExtras().get("case_id")));
        }
    }
}
