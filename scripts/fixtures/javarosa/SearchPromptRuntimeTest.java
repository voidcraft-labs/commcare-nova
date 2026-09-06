package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.instance.utils.TreeUtilities;
import org.javarosa.core.services.locale.*;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

public class SearchPromptRuntimeTest {
    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-prompts", null, true, true, false); }
    }
    private InputStream resource(String name) {
        InputStream stream = getClass().getResourceAsStream("/" + name);
        assertNotNull(name, stream);
        return stream;
    }
    private void localize(String scenario) throws Exception {
        Hashtable<String, String> strings = new Hashtable<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource(scenario + ".strings.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                int equals = line.indexOf('=');
                if (equals > 0) strings.put(line.substring(0, equals), line.substring(equals + 1));
            }
        }
        LocalizerManager.init(true);
        Localizer l = LocalizerManager.getGlobalLocalizer();
        l.addAvailableLocale("en");
        l.registerLocaleResource("en", new TableLocaleSource(strings));
        l.setLocale("en");
    }
    @After public void cleanupLocale() { LocalizerManager.clearInstance(); }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private final class Data extends TestInstanceInitializer {
        final TreeElement regionGroup = node("region_group", "A");
        Data() { super(MockDataUtils.getStaticStorage()); }
        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            String id = instance.getInstanceId();
            if (id.startsWith("search-input:")) return new ConcreteInstanceRoot(null);
            TreeElement root;
            if (id.equals("commcaresession")) {
                root = node("session", null);
                TreeElement user = node("user", null), data = node("data", null);
                data.addChild(regionGroup); user.addChild(data); root.addChild(user);
            } else if (id.equals("item-list:regions")) {
                try (InputStream stream = resource("regions.fixture.xml")) {
                    root = TreeUtilities.xmlStreamToTreeElement(stream, id).getChild("regions_list", 0);
                } catch (Exception e) { throw new RuntimeException(e); }
            } else return super.generateRoot(instance);
            InstanceUtils.setUpInstanceRoot(root, id, instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
    }
    private RemoteQuerySessionManager manager(String scenario, boolean hq, Data data) throws Exception {
        localize(scenario);
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
    private static void answer(RemoteQuerySessionManager manager, String key, String value) {
        manager.answerUserPrompt(key, value);
        manager.refreshInputDependentState();
    }
    @Test public void requiredAndCombinedValidationFollowActualAnswers() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            RemoteQuerySessionManager manager = manager("prompt-widgets", hq, new Data());
            Map<String, String> errors = new HashMap<>();
            errors.put("first_name", "Add a name"); errors.put("name_query", "Add either name");
            assertEquals(errors, manager.getErrors());
            assertEquals(new HashSet<>(Arrays.asList("visit_date", "barcode", "region", "hidden")), manager.getUserAnswers().keySet());
            assertEquals("2026-01-31", manager.getUserAnswers().get("visit_date"));
            assertEquals("00123", manager.getUserAnswers().get("barcode"));
            assertEquals("secret", manager.getUserAnswers().get("hidden"));
            answer(manager, "first_name", "Ada");
            assertTrue(manager.getErrors().isEmpty());
            assertFalse(manager.getRequiredPrompts().get("name_query"));
            answer(manager, "name_query", "ada");
            String combined = "Start with a capital letter This search can't use both single and double quotation marks. Remove one kind and try again";
            assertEquals(Collections.singletonMap("name_query", combined), manager.getErrors());
            answer(manager, "name_query", "Ada'\"");
            assertEquals(Collections.singletonMap("name_query", combined), manager.getErrors());
            for (String value : new String[]{"Ada", "Ada'", "Ada\""}) {
                answer(manager, "name_query", value);
                assertTrue(value, manager.getErrors().isEmpty());
            }
            answer(manager, "name_query", null);
            answer(manager, "first_name", null);
            assertEquals(errors, manager.getErrors());
        }
    }
    private static List<String> choices(RemoteQuerySessionManager manager, String key) {
        List<String> choices = new ArrayList<>();
        for (SelectChoice choice : manager.getNeededUserInputDisplays().get(key).getItemsetBinding().getChoices()) choices.add(choice.getValue() + ":" + choice.getLabelInnerText());
        return choices;
    }
    @Test public void lookupChoicesUseEmittedRowsAndDropUnavailableAnswers() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            Data data = new Data();
            RemoteQuerySessionManager manager = manager("prompt-widgets", hq, data);
            assertEquals(Arrays.asList("north:North & coast", "east:East"), choices(manager, "region"));
            assertEquals(choices(manager, "region"), choices(manager, "regions"));
            assertEquals("north", manager.getUserAnswers().get("region"));
            answer(manager, "regions", "north#,#east#,#unknown");
            assertEquals("north#,#east", manager.getUserAnswers().get("regions"));
            assertEquals(Arrays.asList("north", "east"), new ArrayList<>(manager.getRawQueryParams(false).get("regions")));
            assertFalse(manager.getRawQueryParams(false).containsKey("hidden"));
            data.regionGroup.setValue(new StringData("B"));
            manager.refreshInputDependentState();
            assertEquals(Arrays.asList("south:South"), choices(manager, "region"));
            assertFalse(manager.getUserAnswers().containsKey("region"));
            assertFalse(manager.getUserAnswers().containsKey("regions"));
            answer(manager, "region", "south");
            assertEquals(Collections.singletonList("south"), new ArrayList<>(manager.getRawQueryParams(false).get("region")));
        }
    }
    @Test public void computedGuardsFollowSharedValuesWhileLocationGuardsStayIndependent() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            RemoteQuerySessionManager manager = manager("prompt-dataflow", hq, new Data());
            assertTrue(manager.getErrors().isEmpty());
            assertEquals(Arrays.asList("first_name = \"North & coast\"", "match-all()", "match-all()", "match-all()"), new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query")));
            answer(manager, "near_home", "not a location");
            assertEquals(Collections.singleton("near_home"), manager.getErrors().keySet());
            answer(manager, "near_work", "not a location");
            assertEquals(new HashSet<>(Arrays.asList("near_home", "near_work")), manager.getErrors().keySet());
            answer(manager, "near_home", "12 34");
            assertEquals(Collections.singleton("near_work"), manager.getErrors().keySet());
            answer(manager, "near_work", "-12 -34");
            assertTrue(manager.getErrors().isEmpty());
            answer(manager, "first_name", "Ada'");
            assertTrue(manager.getErrors().isEmpty());
            answer(manager, "last_name", "Lovelace\"");
            assertEquals(new HashSet<>(Arrays.asList("first_name", "last_name")), manager.getErrors().keySet());
            answer(manager, "last_name", "Lovelace");
            assertTrue(manager.getErrors().isEmpty());
            assertEquals("case_name = \"Ada' Lovelace\"", new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query")).get(1));
        }
    }
    @Test public void compilerGuardsRejectInvalidNumbersAndBothQuoteDelimiters() throws Exception {
        for (boolean hq : new boolean[]{false, true}) {
            RemoteQuerySessionManager manager = manager("prompt-guards", hq, new Data());
            assertTrue(manager.getErrors().isEmpty());
            for (String key : new String[]{"months", "minimum"}) {
                for (String bad : new String[]{"1.5", "abc", "1'\""}) {
                    answer(manager, key, bad);
                    assertEquals(key + "=" + bad, Collections.singleton(key), manager.getErrors().keySet());
                }
                for (String valid : new String[]{"0", "2"}) {
                    answer(manager, key, valid);
                    assertTrue(key + "=" + valid, manager.getErrors().isEmpty());
                }
                answer(manager, key, "-1");
                assertEquals(key.equals("minimum"), manager.getErrors().containsKey(key));
                answer(manager, key, null);
                assertTrue(manager.getErrors().isEmpty());
            }
            answer(manager, "first_name", "Ada'\"");
            assertEquals(Collections.singleton("first_name"), manager.getErrors().keySet());
            answer(manager, "first_name", "Ada'");
            assertTrue(manager.getErrors().isEmpty());
            assertEquals(Arrays.asList("first_name = \"Ada'\"", "match-all()", "match-all()"), new ArrayList<>(manager.getRawQueryParams(false).get("_xpath_query")));
        }
    }
}
