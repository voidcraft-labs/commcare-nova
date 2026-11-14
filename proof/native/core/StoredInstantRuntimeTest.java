package nova.compatibility;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Collection;
import java.util.Date;
import java.util.TimeZone;
import org.javarosa.core.model.data.DateTimeData;
import org.javarosa.form.api.FormEntryController;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import static org.junit.Assert.*;

/**
 * A phone writes a date and time as CommCare HQ stores it, in one device zone: the case family's sequence form
 * (proof/native/producers/emit-case-evidence.ts), from the local archive and from HQ's build
 * (proof/native/steps/case_emission.py), with each moment of /case/stored-instants.json
 * (lib/domain/__tests__/hqInstantText.vectors.ts) as the clock now() reads and as the date-and-time question's
 * answer. The form is submitted and applied through Core's case transaction parser, and the case holds, for the
 * clock (read once into the operation's nova_instant_ node) and for the answer (through the basic update's
 * nova_datetime_ sibling), the text CommCare HQ stores for the moment: UTC, six fraction digits and Z
 * (dimagi/utils/parsing.py::json_format_datetime). A literal written with its own offset is stored the same way.
 *
 * Each zone runs in a test JVM started in it (proof/native/families.py::ZONED_CLASSES), because DateUtils fixes
 * its 1970 epoch when it loads and Core prints %Z in the device's zone.
 *
 * Plausible failures: a typed moment written in the device's offset; a day moved for a moment whose UTC day is
 * not the device's (the day before or after, across a month, a February or a year); seconds or milliseconds
 * lost; the clock read twice across a minute's turn.
 */
@RunWith(Parameterized.class)
public class StoredInstantRuntimeTest {
    @Parameterized.Parameters(name = "HQ={0}")
    public static Collection<Object[]> paths() { return Arrays.asList(new Object[][]{{false}, {true}}); }
    private final boolean hq;
    public StoredInstantRuntimeTest(boolean hq) { this.hq = hq; }

    private static JSONArray vectors() throws Exception {
        try (InputStream input = StoredInstantRuntimeTest.class.getResourceAsStream("/case/stored-instants.json")) {
            assertNotNull("The case producer did not supply stored-instants.json", input);
            JSONObject result = new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
            assertEquals("Unknown stored instants version", 1, result.getInt("schemaVersion"));
            return result.getJSONArray("vectors");
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
        assertEquals("Stored instants run only in device zones, never behind a Formplayer provider",
            "", System.getProperty("nova.proof.zone.provider", ""));
        return jvmId;
    }

    @Test public void aPhoneStoresEachMomentAsCommCareHqDoes() throws Exception {
        String zone = deviceZone();
        JSONArray vectors = vectors();
        assertTrue("The vectors hold moments", vectors.length() > 0);
        for (int index = 0; index < vectors.length(); index++) {
            JSONObject vector = vectors.getJSONObject(index);
            Instant instant = Instant.parse(vector.getString("instant"));
            String expected = vector.getString("text");
            String context = vector.getString("id") + " on a device in " + zone + (hq ? ", HQ's build" : "");
            CaseOperationRuntimeTest.Run run = new CaseOperationRuntimeTest.Run("sequence", hq, instant);
            run.answer("/data/enabled", "yes");
            run.answer("/data/answer", "Visit at " + vector.getString("id"));
            run.answer("/data/key", "key-" + index);
            run.answer("/data/ordinary_note", "Noted");
            FormEntryController answer =
                new FormEntryController(CaseOperationRuntimeTest.clockQuestion(run.form, "/data/visible_at"));
            assertEquals(context, FormEntryController.ANSWER_OK,
                answer.answerQuestion(new DateTimeData(Date.from(instant))));
            run.apply();
            assertEquals(context + ": the clock", expected, run.record("patient-1").getPropertyString("occurred_at"));
            assertEquals(context + ": the answer", expected, run.record("patient-1").getPropertyString("visible_at"));
            assertEquals(context + ": a literal with its own offset", "2026-04-17T11:23:41.000000Z",
                run.record("patient-1").getPropertyString("reference_at"));
        }
    }

    /**
     * targeted-datetime-saved's "Revisit" form, opened from its suite on a visit whose seen_at holds each moment
     * as CommCare HQ stores it, and submitted with nothing answered: its date-and-time question starts on seen_at
     * (read in the device's own date and clock before Core's cast, which keeps the written date) and saves it back
     * through Case Management's nova_datetime_ sibling, and a Hidden Value calculated as seen_at saves it to
     * seen_kept through its own sibling, which copies the text. So seen_at keeps its text and seen_kept is the same
     * text, in a zone west of UTC (New York) and east of it (Kolkata, Kiritimati) alike. The one moment a phone
     * cannot keep is the first of an hour the zone repeats: Core's parse sets the device's date and clock on a
     * calendar, which reads a repeated clock as its later occurrence whatever text names it.
     *
     * Plausible failures: the starting value read a day away (the written UTC date with the device's clock), so
     * each save moves the visit by a day; the copy parsed and moved the same way; a millisecond lost to Core's
     * truncation of the seconds it reads.
     */
    @Test public void aFormOpenedOnAStoredMomentAndSavedUnchangedKeepsIt() throws Exception {
        String zone = deviceZone();
        JSONArray vectors = vectors();
        JSONObject form = AdvancedFormRuntimeTest.app("datetime-saved").getJSONArray("modules").getJSONObject(0)
            .getJSONArray("forms").getJSONObject(2);
        String file = "datetime-saved.m0f2" + (hq ? ".hq.xml" : ".xml");
        DateTimeFormatter stored = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'").withZone(ZoneOffset.UTC);
        for (int index = 0; index < vectors.length(); index++) {
            JSONObject vector = vectors.getJSONObject(index);
            String text = vector.getString("text");
            String context = vector.getString("id") + " on a device in " + zone + (hq ? ", HQ's build" : "");
            SuiteFormRun run = new SuiteFormRun("case", "datetime-saved", hq, file, form.getString("xmlns"),
                record -> { if ("visit".equals(record.getTypeId())) record.setProperty("seen_at", text); });
            run.apply();
            Instant instant = Instant.parse(vector.getString("instant"));
            Instant kept = ZonedDateTime.ofInstant(instant, ZoneId.of(zone)).withLaterOffsetAtOverlap().toInstant();
            String expected = kept.equals(instant) ? text : stored.format(kept);
            assertEquals(context + ": the question saved unchanged", expected,
                run.record("visit-1").getPropertyString("seen_at"));
            assertEquals(context + ": the Hidden Value's copy", text,
                run.record("visit-1").getPropertyString("seen_kept"));
        }
    }
}
