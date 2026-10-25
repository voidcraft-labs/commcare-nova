package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.TimeZone;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.data.DateData;
import org.javarosa.core.model.data.DateTimeData;
import org.javarosa.core.model.data.IAnswerData;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.data.TimeData;
import org.javarosa.core.model.data.UncastData;
import org.javarosa.core.model.instance.ConcreteInstanceRoot;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.InstanceBase;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.model.instance.InstanceRoot;
import org.javarosa.core.model.instance.TreeElement;
import org.javarosa.core.model.instance.TreeReference;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.model.utils.DateUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xpath.XPathNodeset;
import org.javarosa.xpath.XPathParseTool;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

/**
 * The date-and-time split in Core, in one device zone: the shared original
 * (lib/doc/__tests__/datetimeSplitFixture.ts) with Nova's planner's splits,
 * compiled into a local archive by the expression producer and written as
 * /expression/datetime-split/ with its rows in /expression/datetime-split.json.
 *
 * The split turns a date-and-time question into a date question and a time
 * question joined by a Hidden Value calculated by the clock-keeping date and
 * bound xsd:dateTime (bind rule R3). For an entry it must hold what the
 * question held: DateTimeData of the zone-less wall clock as DateTimeData.cast
 * reads it (Recalculate.wrapData keeps a Date's clock only under xsd:dateTime),
 * and the writer's nova_datetime_ text must name the same instant. A blank part
 * leaves the join blank, and the time question's validation passes while the
 * date is blank. A case value fills both questions and rejoins to what the
 * question held from it, which is its instant wherever its local day is its
 * UTC day (DateUtils.parseTimeAndStore keeps the written day).
 * Each zone runs in a test JVM started in it, because DateUtils fixes its 1970
 * epoch when it loads; a device has no browser provider.
 *
 * Plausible failures: a join read in UTC on a device in another zone, a bind
 * that drops the clock, a join that lands outside a gap or a repeated hour
 * differently from the original question, a preload that does not rejoin, and
 * a guard that throws on a blank part.
 */
public class DatetimeSplitRuntimeTest {
    private static final String CLOCK = "'%Y-%m-%d %H:%M:%S'";

    private static JSONObject rows() throws Exception {
        try (InputStream input = DatetimeSplitRuntimeTest.class.getResourceAsStream("/expression/datetime-split.json")) {
            assertNotNull("The expression producer did not supply datetime-split.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown datetime split rows version", 1, result.getInt("schemaVersion"));
            return result;
        }
    }

    /** The JVM's own zone is the device's: the named setup, user.timezone, and no DateUtils provider. */
    private static String deviceZone() {
        String label = System.getProperty("nova.proof.zone.label");
        assertNotNull("This class must run through a named native zone setup", label);
        String jvmId = System.getProperty("nova.proof.zone.jvm");
        assertNotNull("The native runner did not supply the JVM zone", jvmId);
        assertEquals("The JVM was started in the wrong zone", jvmId, TimeZone.getDefault().getID());
        assertEquals("The native runner must set user.timezone", jvmId, System.getProperty("user.timezone"));
        assertEquals("The split runs only in device zones, never behind a Formplayer provider",
            "", System.getProperty("nova.proof.zone.provider", ""));
        assertFalse("The split runs only in device zones, never with an offset-only provider",
            Boolean.parseBoolean(System.getProperty("nova.proof.zone.offsetOnly", "false")));
        DateUtils.resetTimezoneProvider();
        assertNull("A device zone has no named DateUtils zone", DateUtils.timezone());
        return label;
    }

    private static TreeElement node(String name, String value) {
        TreeElement element = new TreeElement(name, 0);
        if (value != null) element.setValue(new StringData(value));
        return element;
    }

    /** The phone's data: the case the writer's form opens, and the session that names it. */
    private static InstanceInitializationFactory environment(JSONObject preload) {
        return new InstanceInitializationFactory() {
            @Override public InstanceRoot generateRoot(ExternalDataInstance instance) {
                TreeElement root;
                if ("casedb".equals(instance.getInstanceId())) {
                    root = node("casedb", null);
                    TreeElement visit = node("case", null);
                    visit.setAttribute(null, "case_id", preload.getString("caseId"));
                    visit.setAttribute(null, "case_type", preload.getString("caseType"));
                    visit.addChild(node("case_name", "Amina"));
                    visit.addChild(node(preload.getString("property"), preload.getString("value")));
                    root.addChild(visit);
                } else if ("commcaresession".equals(instance.getInstanceId())) {
                    root = node("session", null);
                    TreeElement context = node("context", null);
                    for (String key : new String[]{"deviceid", "username", "userid", "appversion"}) {
                        context.addChild(node(key, "fixture-" + key));
                    }
                    context.addChild(node("drift", "0"));
                    TreeElement data = node("data", null);
                    data.addChild(node(preload.getString("caseDatum"), preload.getString("caseId")));
                    root.addChild(context);
                    root.addChild(data);
                } else {
                    throw new AssertionError("The split's forms read no instance " + instance.getInstanceId());
                }
                InstanceUtils.setUpInstanceRoot(root, instance.getInstanceId(), new InstanceBase(instance.getInstanceId()));
                return new ConcreteInstanceRoot(root);
            }
        };
    }

    private static FormDef open(String resource, JSONObject preload) {
        FormDef form = new FormParseInit(resource).getFormDef();
        form.initialize(true, environment(preload));
        return form;
    }

    private static TreeReference ref(FormDef form, String path) throws Exception {
        XPathNodeset target = (XPathNodeset)XPathParseTool.parseXPath(path).eval(form.getMainInstance(), form.getEvaluationContext());
        assertEquals("One node answers " + path, 1, target.size());
        return target.getRefAt(0);
    }

    private static IAnswerData held(FormDef form, String path) throws Exception {
        return form.getMainInstance().resolveReference(ref(form, path)).getValue();
    }

    private static Object eval(FormDef form, String expression) throws Exception {
        return ExprEvalUtils.xpathEval(form.getEvaluationContext(), expression);
    }

    /** Answers as the widgets' answers are cast (DateData.cast, TimeData.cast); null clears. */
    private static void answer(FormDef form, JSONObject split, String date, String time) throws Exception {
        form.setValue(date == null ? null : new DateData().cast(new UncastData(date)), ref(form, split.getString("date")));
        form.setValue(time == null ? null : new TimeData().cast(new UncastData(time)), ref(form, split.getString("time")));
    }

    /** What the date-and-time question held for the same entry: DateTimeData.cast of the zone-less wall clock. */
    private static Date questionHeld(String date, String time) {
        return (Date)new DateTimeData().cast(new UncastData(date + "T" + time)).getValue();
    }

    /** The joined value, which must be DateTimeData: an xsd:dateTime bind keeps the Date's clock. */
    private static Date joined(FormDef form, JSONObject split, String context) throws Exception {
        IAnswerData value = held(form, split.getString("joined"));
        assertNotNull(context + ": the join is blank", value);
        assertTrue(context + ": the join is held as " + value.getClass().getSimpleName() + ", not DateTimeData",
            value instanceof DateTimeData);
        return (Date)value.getValue();
    }

    private static JSONObject[] splits(JSONObject rows) {
        JSONArray readers = rows.getJSONArray("readers");
        JSONObject[] result = new JSONObject[readers.length() + 1];
        result[0] = rows.getJSONObject("writer");
        for (int index = 0; index < readers.length(); index++) result[index + 1] = readers.getJSONObject(index);
        return result;
    }

    @Test public void eachEntryJoinsToWhatTheQuestionHeld() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        JSONObject preload = rows.getJSONObject("preload");
        JSONArray entries = rows.getJSONArray("entries");
        for (JSONObject split : splits(rows)) {
            for (int index = 0; index < entries.length(); index++) {
                JSONObject entry = entries.getJSONObject(index);
                String date = entry.getString("date");
                String time = entry.getString("time");
                String context = zone + " " + split.getString("joined") + " " + date + " " + time;
                FormDef form = open(split.getString("form"), preload);
                answer(form, split, date, time);
                Date value = joined(form, split, context);
                assertEquals(context + ": the join is not the instant the question held",
                    questionHeld(date, time).getTime(), value.getTime());
                // coalesce unpacks the node, so format-date keeps its clock.
                assertEquals(context + ": the join lost its wall clock", date + " " + time,
                    eval(form, "format-date(coalesce(" + split.getString("joined") + ", ''), " + CLOCK + ")"));
                if (split.has("caseValue")) {
                    String text = (String)eval(form, "string(" + split.getString("caseValue") + ")");
                    Date written = DateUtils.parseDateTime(text);
                    assertNotNull(context + ": Core does not read the written case value " + text, written);
                    assertEquals(context + ": the written case value " + text + " names another instant",
                        value.getTime(), written.getTime());
                }
            }
        }
    }

    @Test public void aTransitionJoinsAsTheQuestionHeldIt() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        JSONObject preload = rows.getJSONObject("preload");
        JSONArray transitions = rows.getJSONArray("transitions");
        for (JSONObject split : splits(rows)) {
            for (int index = 0; index < transitions.length(); index++) {
                JSONObject transition = transitions.getJSONObject(index);
                String date = transition.getString("date");
                String time = transition.getString("time");
                String context = zone + " " + split.getString("joined") + " " + transition.getString("id");
                FormDef form = open(split.getString("form"), preload);
                answer(form, split, date, time);
                Date value = joined(form, split, context);
                assertEquals(context + ": the join lands elsewhere than the question did",
                    questionHeld(date, time).getTime(), value.getTime());
                // Recorded in the report: the instant this zone gives the wall
                // clock, the repeated hour's occurrence among them.
                System.out.println("datetime-split " + context + " " + date + "T" + time
                    + " joins to " + Instant.ofEpochMilli(value.getTime()));
            }
        }
    }

    @Test public void aCaseValueFillsBothQuestionsAndRejoinsToItsInstant() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        JSONObject preload = rows.getJSONObject("preload");
        JSONObject writer = rows.getJSONObject("writer");
        FormDef form = open(writer.getString("form"), preload);
        assertTrue(zone + ": the case value did not fill the date question",
            held(form, writer.getString("date")) instanceof DateData);
        assertTrue(zone + ": the case value did not fill the time question",
            held(form, writer.getString("time")) instanceof TimeData);
        // What the date-and-time question held when the form preloaded the
        // value: DateTimeData.cast of its text. DateUtils.parseTimeAndStore
        // moves the clock into the device's zone and keeps the written day, so
        // where the instant's local day is another (Kiritimati, 10:30Z is the
        // next day's 00:30) the question already held the day before.
        String value = preload.getString("value");
        long instant = Instant.parse(preload.getString("instant")).toEpochMilli();
        long question = ((Date)new DateTimeData().cast(new UncastData(value)).getValue()).getTime();
        boolean sameDay = Instant.ofEpochMilli(instant).atZone(ZoneId.systemDefault()).toLocalDate()
            .equals(Instant.ofEpochMilli(instant).atZone(ZoneOffset.UTC).toLocalDate());
        if (sameDay) {
            assertEquals(zone + ": the question does not hold the case value " + value + " as its instant",
                instant, question);
        }
        assertEquals(zone + ": the case value " + value + " does not rejoin to what the question held",
            question, joined(form, writer, zone + " preload").getTime());
        // Recorded in the report: the instant the question and the join hold.
        System.out.println("datetime-split " + zone + " preload " + value + " joins to " + Instant.ofEpochMilli(question));
    }

    @Test public void aBlankPartLeavesTheJoinBlank() throws Exception {
        JSONObject rows = rows();
        String zone = deviceZone();
        JSONObject preload = rows.getJSONObject("preload");
        JSONObject entry = rows.getJSONArray("entries").getJSONObject(0);
        for (JSONObject split : splits(rows)) {
            String joined = split.getString("joined");
            for (String blank : new String[]{"date", "time"}) {
                String context = zone + " " + joined + " with a blank " + blank;
                FormDef form = open(split.getString("form"), preload);
                answer(form, split,
                    "date".equals(blank) ? null : entry.getString("date"),
                    "time".equals(blank) ? null : entry.getString("time"));
                assertEquals(context + ": the join is not blank", "", eval(form, "string(" + joined + ")"));
                if (split.has("caseValue")) {
                    assertEquals(context + ": a blank join still names an instant for the case", "",
                        eval(form, "string(" + split.getString("caseValue") + ")"));
                }
            }
        }
        // The writer's validation moved to its time question, guarded by the date.
        JSONObject writer = rows.getJSONObject("writer");
        FormDef form = open(writer.getString("form"), preload);
        answer(form, writer, null, null);
        assertTrue(zone + ": the time question's validation fails a time with a blank date",
            form.evaluateConstraint(ref(form, writer.getString("time")),
                new TimeData().cast(new UncastData(entry.getString("time")))));
    }
}
