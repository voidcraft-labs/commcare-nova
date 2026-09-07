package nova.compatibility;

import java.io.*;
import java.util.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.instance.utils.TreeUtilities;
import org.junit.Test;
import static org.junit.Assert.*;

public class CsqlFunctionRuntimeTest {
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-prompts", null, true, true, false); }
    }
    private InputStream resource(String name) {
        InputStream stream = getClass().getResourceAsStream("/" + name);
        assertNotNull(name, stream);
        return stream;
    }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private final class Data extends TestInstanceInitializer {
        final TreeElement role = node("role", "clinician");
        Data() { super(MockDataUtils.getStaticStorage()); }
        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            String id = instance.getInstanceId();
            if (id.startsWith("search-input:")) return new ConcreteInstanceRoot(null);
            TreeElement root;
            if (id.equals("commcaresession")) {
                root = node("session", null);
                TreeElement user = node("user", null), data = node("data", null);
                data.addChild(role); user.addChild(data); root.addChild(user);
            } else if (id.equals("item-list:search_values")) {
                try (InputStream stream = resource("search-values.fixture.xml")) {
                    root = TreeUtilities.xmlStreamToTreeElement(stream, id).getChild("search_values_list", 0);
                } catch (Exception e) { throw new RuntimeException(e); }
            } else return super.generateRoot(instance);
            InstanceUtils.setUpInstanceRoot(root, id, instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
    }
    private RemoteQuerySessionManager manager(String scenario, boolean hq, Data data) throws Exception {
        Suite suite;
        try (InputStream stream = resource(scenario + (hq ? ".hq-suite.xml" : ".suite.xml"))) { suite = new Parser(stream).parse(); }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        session.setCommand("search_command.m0");
        Hashtable<String, DataInstance> instances = suite.getEntry("search_command.m0").getInstances(null);
        for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(data, id));
        RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(session, new EvaluationContext(null, instances), Arrays.asList("date", "daterange", "select", "select1"));
        assertNotNull(manager);
        return manager;
    }
    @Test public void nativeFunctionsReceiveLookupValuesAtEveryDepth() throws Exception {
        List<String> payloads = new ArrayList<>();
        for (boolean hq : new boolean[]{false, true}) {
            Data data = new Data();
            RemoteQuerySessionManager manager = manager("nested-lookup", hq, data);
            List<String> expected = Arrays.asList(
                "visit_date = date(\"2024-02-28\")",
                "last_seen = datetime(\"2024-02-28T10:30:00Z\")",
                "score = double(\"19.5\")",
                "visit_date = date-add(date(\"2024-02-28\"), 'days', (double(\"2\")))",
                "score = double(\"19.5\")"
            );
            List<String> actual = new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query"));
            assertEquals(expected, actual);
            for (int i = 0; i < actual.size(); i++) payloads.add((hq ? "hq" : "local") + "-clinician\t" + i + "\t" + actual.get(i));
            data.role.setValue(new StringData("other"));
            manager.refreshInputDependentState();
            List<String> other = new ArrayList<>(expected);
            other.set(4, "score = double(\"0\")");
            actual = new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query"));
            assertEquals(other, actual);
            for (int i = 0; i < actual.size(); i++) payloads.add((hq ? "hq" : "local") + "-other\t" + i + "\t" + actual.get(i));
        }
        Files.write(Paths.get("build/nova-function-payloads.tsv"), payloads, StandardCharsets.UTF_8);
    }
    @Test public void laterArgumentsRetainNestedFunctionNodes() throws Exception {
        List<String> payloads = new ArrayList<>();
        for (boolean hq : new boolean[]{false, true}) {
            RemoteQuerySessionManager manager = manager("function-arguments", hq, new Data());
            List<String> actual = new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query"));
            assertEquals(6, actual.size());
            for (int i = 0; i < actual.size(); i++) payloads.add((hq ? "hq" : "local") + "\t" + i + "\t" + actual.get(i));
        }
        Files.write(Paths.get("build/nova-function-arguments.tsv"), payloads, StandardCharsets.UTF_8);
    }

}
