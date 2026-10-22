package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import org.commcare.cases.model.Case;
import org.commcare.cases.model.CaseIndex;
import org.commcare.session.CommCareSession;
import org.commcare.session.RemoteQuerySessionManager;
import org.commcare.session.SessionFrame;
import org.commcare.session.SessionInstanceBuilder;
import org.commcare.suite.model.*;
import org.commcare.test.utilities.TestInstanceInitializer;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.condition.IFunctionHandler;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.core.services.locale.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Core builds each search query of the csql family's scenarios from both
 * suites (Nova's local suite and HQ's regeneration of it) under each sending's
 * session, as a worker's search sends it: the worker enters the module's
 * form, chooses the case of each menu the entry passes through, opens the
 * module's search from its case list, answers the prompts, and
 * {@code RemoteQuerySessionManager} evaluates the remote request's
 * {@code _xpath_query} data against that session (its datums, the worker's
 * user data and context, the casedb holding the scenario's cases).
 *
 * The class is zoned (families.py::ZONED_CLASSES): each zone's JVM builds
 * every sending that names no zone, and the sendings that name its own, so a
 * worker's {@code today()} and a date and time ordering in a clause chosen at
 * run time are read in a zone whose day differs from UTC's and in one with
 * daylight saving. A sending's clock is the instant {@code today()} and
 * {@code now()} read; Core's own day rounding turns it into the zone's date.
 *
 * The scenarios and their sendings are the fixture's
 * (lib/commcare/__tests__/csqlCompositionFixture.ts, written as
 * {@code /csql/scenarios.jsonl}); what HQ's search finds for each query is
 * proof/native/test_csql_payload.py's to judge, so this class states only
 * that every sending builds its queries on both paths, and writes them with
 * the case types the sending asks for ({@code case_type}).
 */
public class CsqlCompositionRuntimeTest {
    /** The fixture's device zones (CSQL_DEVICE_ZONES), by the runner's label. */
    private static final Map<String, String> ZONES = Map.of(
        "utc", "UTC", "kiritimati", "Pacific/Kiritimati", "new-york", "America/New_York");

    private static final class Parser extends SuiteParser {
        Parser(InputStream stream) throws IOException { super(stream, null, "nova-csql", null, true, true, false); }
    }
    private InputStream resource(String name) {
        InputStream stream = getClass().getResourceAsStream("/csql/" + name);
        assertNotNull(name, stream);
        return stream;
    }
    private List<String> lines(String name) throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(resource(name), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) if (!line.isEmpty()) lines.add(line);
        }
        return lines;
    }
    private void localize(String scenario) throws Exception {
        Hashtable<String, String> strings = new Hashtable<>();
        for (String line : lines(scenario + ".strings.txt")) {
            int equals = line.indexOf('=');
            if (equals > 0) strings.put(line.substring(0, equals), line.substring(equals + 1));
        }
        LocalizerManager.init(true);
        Localizer localizer = LocalizerManager.getGlobalLocalizer();
        localizer.addAvailableLocale("en");
        localizer.registerLocaleResource("en", new TableLocaleSource(strings));
        localizer.setLocale("en");
    }
    @After public void cleanupLocale() { LocalizerManager.clearInstance(); }

    /** The device a sending is sent from: the scenario's cases in its casedb, and its session. */
    private static final class Device extends TestInstanceInitializer {
        final CommCareSession session;
        final JSONObject state;

        Device(JSONObject scenario, CommCareSession session, JSONObject state) {
            this(MockDataUtils.getStaticStorage(), scenario, session, state);
        }

        private Device(MockUserDataSandbox sandbox, JSONObject scenario, CommCareSession session, JSONObject state) {
            super(sandbox);
            this.session = session;
            this.state = state;
            JSONArray cases = scenario.getJSONArray("cases");
            for (int i = 0; i < cases.length(); i++) {
                JSONObject row = cases.getJSONObject(i);
                Case c = new Case(row.getString("name"), row.getString("type"));
                c.setCaseId(row.getString("id"));
                c.setClosed(row.optBoolean("closed", false));
                JSONObject properties = row.getJSONObject("properties");
                for (String key : properties.keySet()) c.setProperty(key, properties.getString(key));
                JSONArray indices = row.optJSONArray("indices");
                if (indices != null) for (int n = 0; n < indices.length(); n++) {
                    JSONObject index = indices.getJSONObject(n);
                    c.setIndex(new CaseIndex(index.getString("identifier"), index.getString("caseType"),
                        index.getString("caseId"), index.getString("relationship")));
                }
                sandbox.getCaseStorage().write(c);
            }
        }

        private String context(String field, String fallback) {
            JSONObject context = state.optJSONObject("context");
            return context == null ? fallback : context.optString(field, fallback);
        }

        @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
            String id = instance.getInstanceId();
            // The Search engine supplies the prompts' answers itself.
            if (id.startsWith("search-input:")) return new ConcreteInstanceRoot(null);
            if (!"commcaresession".equals(id)) return super.generateRoot(instance);
            Hashtable<String, String> user = new Hashtable<>();
            JSONObject fields = state.optJSONObject("user");
            if (fields != null) for (String key : fields.keySet()) user.put(key, fields.getString(key));
            TreeElement root = SessionInstanceBuilder.getSessionInstance(session.getFrame(),
                context("deviceid", "csql-device"), context("appversion", "1"), 0L,
                context("username", "csql-worker"), context("userid", "csql-worker-id"), user, "400", "en");
            InstanceUtils.setUpInstanceRoot(root, id, instance.getBase());
            return new ConcreteInstanceRoot(root);
        }
    }

    /** A handler for a clock function that reads the sending's instant, as the device's clock would. */
    private static IFunctionHandler clock(String name, Date value) {
        return new IFunctionHandler() {
            @Override public String getName() { return name; }
            @Override public Vector<Class[]> getPrototypes() {
                Vector<Class[]> result = new Vector<>();
                result.add(new Class[0]);
                return result;
            }
            @Override public boolean rawArgs() { return false; }
            // XPathFuncExpr.evalRaw checks a handler before the built-in evalBody.
            @Override public Object eval(Object[] args, EvaluationContext ignored) { return value; }
        };
    }

    /** The module index a case list detail belongs to (HQ's and Nova's {@code m<i>_case_short}). */
    private static int detailModule(String detail) {
        assertTrue("A case list detail is named m<i>_case_short: " + detail, detail.matches("m\\d+_case_short"));
        return Integer.parseInt(detail.substring(1, detail.indexOf('_')));
    }

    /**
     * The worker's way to the module's search: its form command, each earlier
     * menu's chosen case, then the module's own case list's search action.
     */
    private RemoteQuerySessionManager manager(JSONObject scenario, boolean hq, int module, JSONObject sending) throws Exception {
        String id = scenario.getString("id");
        localize(id);
        Suite suite;
        try (InputStream stream = resource(id + (hq ? ".hq-suite.xml" : ".suite.xml"))) { suite = new Parser(stream).parse(); }
        CommCarePlatform platform = new CommCarePlatform(2, 53, 0);
        platform.registerSuite(suite);
        CommCareSession session = new CommCareSession(platform);
        JSONObject state = sending.optJSONObject("session");
        if (state == null) state = new JSONObject();
        Device device = new Device(scenario, session, state);
        JSONObject chosen = state.optJSONObject("chosenCaseIds");
        JSONArray modules = scenario.getJSONArray("modules");
        String search = "search_command.m" + module;
        session.setCommand("m" + module);
        session.setCommand("m" + module + "-f0");
        for (int step = 0; ; step++) {
            assertTrue(id + " " + search + " needs more datums than the fixture's entries hold", step < 8);
            SessionDatum datum = session.getNeededDatum();
            assertNotNull(id + " " + search + " reached no search", datum);
            if (datum instanceof RemoteQueryDatum) break;
            assertTrue(id + " " + search + " meets a datum Core cannot choose here: " + datum.getDataId(), datum instanceof EntityDatum);
            EntityDatum entity = (EntityDatum)datum;
            int owner = detailModule(entity.getShortDetail());
            if (owner != module) {
                String menu = modules.getString(owner);
                assertTrue(id + " " + search + " passes through m" + owner + ", and the sending chooses no case there",
                    chosen != null && chosen.has(menu));
                session.setEntityDatum(entity, chosen.getString(menu));
                continue;
            }
            EvaluationContext context = session.getEvaluationContext(device);
            Action open = null;
            for (Action action : session.getDetail(entity.getShortDetail()).getCustomActions(context)) {
                for (StackOperation op : action.getStackOperations())
                    for (StackFrameStep frame : op.getStackFrameSteps())
                        if (SessionFrame.STATE_COMMAND_ID.equals(frame.getType()) && search.equals(frame.evaluateValue(context)))
                            open = action;
            }
            assertNotNull(id + " m" + module + "'s case list has no action opening " + search, open);
            session.executeStackOperations(open.getStackOperations(), context);
        }
        assertEquals(id + " opened another search", search, session.getCommand());
        EvaluationContext context = session.getEvaluationContext(device);
        if (state.has("clock")) {
            Date now = Date.from(Instant.parse(state.getString("clock")));
            context.addFunctionHandler(clock("now", now));
            // Core's today(): the clock's instant rounded to the device's day.
            context.addFunctionHandler(clock("today", DateUtils.roundDate(now)));
        }
        RemoteQuerySessionManager manager = RemoteQuerySessionManager.buildQuerySessionManager(session, context, Collections.emptyList());
        assertNotNull(id + " " + search + " builds no query", manager);
        return manager;
    }

    @Test public void everySendingBuildsItsQueryOnBothPaths() throws Exception {
        String zone = System.getProperty("nova.proof.zone.label");
        assertNotNull("This class must run through a named native zone setup", zone);
        assertTrue("The csql fixture names no zone " + zone, ZONES.containsKey(zone));
        assertEquals("The JVM was started in the wrong zone", ZONES.get(zone), TimeZone.getDefault().getID());
        List<String> records = new ArrayList<>();
        for (String line : lines("scenarios.jsonl")) {
            JSONObject scenario = new JSONObject(line);
            String id = scenario.getString("id");
            JSONArray searches = scenario.getJSONArray("searches");
            for (int s = 0; s < searches.length(); s++) {
                JSONObject search = searches.getJSONObject(s);
                assertEquals(id + " search " + s + " is module " + s + "'s", "search_command.m" + s, search.getString("command"));
                JSONArray sendings = search.getJSONArray("sendings");
                for (boolean hq : new boolean[]{false, true}) {
                    for (int n = 0; n < sendings.length(); n++) {
                        JSONObject sending = sendings.getJSONObject(n);
                        if (sending.has("zone") && !zone.equals(sending.getString("zone"))) continue;
                        String label = id + "/" + search.getString("id") + "/" + sending.getString("id")
                            + (hq ? "@hq" : "@local") + "[" + zone + "]";
                        JSONObject record;
                        try {
                            record = send(scenario, hq, s, sending, label);
                        } catch (Exception error) {
                            throw new AssertionError(label + ": Core could not build the query: " + error, error);
                        }
                        record.put("zone", zone);
                        records.add(record.toString());
                    }
                }
            }
        }
        assertFalse("The csql family holds no sending", records.isEmpty());
        Files.write(NativeProof.familyDirectory("csql").resolve("nova-csql-payloads." + zone + ".jsonl"), records, StandardCharsets.UTF_8);
    }

    /** One sending, sent as the worker sends it: the queries Core wrote for it. */
    private JSONObject send(JSONObject scenario, boolean hq, int module, JSONObject sending, String label) throws Exception {
        JSONObject search = scenario.getJSONArray("searches").getJSONObject(module);
        // A fresh session per sending: no answer or choice carries over.
        RemoteQuerySessionManager manager = manager(scenario, hq, module, sending);
        JSONObject answers = sending.optJSONObject("answers");
        if (answers != null) {
            for (String key : answers.keySet()) {
                // No device sends a typed blank: Web Apps leaves an empty field out of its request
                // (query.js::encodeValue, ::getAnswers) and Android answers it with null
                // (QueryRequestUiController.kt::answerUserPrompt), so a blank is answered as Android answers it.
                String answer = answers.isNull(key) ? null : answers.getString(key);
                manager.answerUserPrompt(key, answer == null || answer.isEmpty() ? null : answer);
            }
        }
        manager.refreshInputDependentState();
        // A prompt whose validation holds the answer keeps the worker from
        // sending it; its query still means the fixture's ids.
        Set<String> refused = new TreeSet<>();
        JSONArray refusedBy = sending.optJSONArray("refusedBy");
        if (refusedBy != null) for (int r = 0; r < refusedBy.length(); r++) refused.add(refusedBy.getString(r));
        assertEquals(label + " " + manager.getErrors(), refused, new TreeSet<>(manager.getErrors().keySet()));
        com.google.common.collect.Multimap<String, String> params = manager.getRawQueryParams(false);
        Collection<String> queries = params.get("_xpath_query");
        assertNotNull(label + " sends no _xpath_query", queries);
        assertFalse(label + " sends no _xpath_query", queries.isEmpty());
        // The case types the search asks HQ for: its own module's, not every type the scenario saves.
        Collection<String> caseTypes = params.get("case_type");
        assertFalse(label + " sends no case_type", caseTypes == null || caseTypes.isEmpty());
        JSONObject record = new JSONObject();
        record.put("scenario", scenario.getString("id"));
        record.put("search", search.getString("id"));
        record.put("sending", sending.getString("id"));
        record.put("carrier", hq ? "hq" : "local");
        record.put("queries", new JSONArray(new ArrayList<>(queries)));
        record.put("caseTypes", new JSONArray(new ArrayList<>(caseTypes)));
        return record;
    }
}
