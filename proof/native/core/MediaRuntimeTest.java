package nova.compatibility;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.SelectChoice;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.xform.util.XFormUtils;
import org.junit.Test;
import org.commcare.cases.model.Case;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.suite.model.*;
import org.commcare.xml.SuiteParser;
import org.commcare.resources.model.*;
import org.commcare.modern.reference.ArchiveFileRoot;
import org.commcare.modern.reference.JavaFileReference;
import org.javarosa.core.model.User;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.services.storage.util.DummyIndexedStorageUtility;
import org.javarosa.core.util.externalizable.LivePrototypeFactory;
import org.javarosa.core.services.locale.*;
import org.javarosa.model.xform.XPathReference;
import org.javarosa.form.api.*;
import static org.junit.Assert.*;

public class MediaRuntimeTest {
    private static final String[] SCENARIOS = {"media-rich-on", "media-rich-off", "media-only-on", "media-only-off"};
    private byte[] resource(String path) throws IOException {
        try (InputStream stream = getClass().getResourceAsStream("/media/" + path)) {
            assertNotNull(path, stream);
            return stream.readAllBytes();
        }
    }
    private FormParseInit parse(String path) throws IOException {
        try (InputStream stream = new ByteArrayInputStream(resource(path))) {
            FormDef form = XFormUtils.getFormFromInputStream(stream);
            assertNotNull(path, form);
            return new FormParseInit(form);
        }
    }
    @Test public void sourceFormsParseWithRealCoreBeforeHqMatching() throws Exception {
        Properties certificate = new Properties();
        for (String name : SCENARIOS) {
            String filename = name + ".validation.xml";
            FormParseInit parsed = parse(filename);
            assertEquals(2, parsed.getFormDef().getChildren().size());
            certificate.setProperty(filename, HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(resource(filename))));
        }
        String directory = NativeProof.familyDirectory("media").toString();
        try (OutputStream output = Files.newOutputStream(Path.of(directory, "core-validated-sources.properties"))) {
            certificate.store(output, "Actual Core parser acceptance of exact Nova source bytes");
        }
    }

    private Properties properties(String path) throws IOException {
        Properties props = new Properties();
        try (Reader reader = new InputStreamReader(new ByteArrayInputStream(resource(path)), StandardCharsets.UTF_8)) { props.load(reader); }
        return props;
    }
    private void locale(String name) throws IOException {
        TableLocaleSource table = new TableLocaleSource();
        Properties props = properties(name + ".strings.properties");
        for (String key : props.stringPropertyNames()) table.setLocaleMapping(key, props.getProperty(key));
        Localizer localizer = Localization.getGlobalLocalizerAdvanced();
        localizer.addAvailableLocale("en");
        localizer.registerLocaleResource("en", table);
        localizer.setLocale("en");
    }
    private static TreeElement node(String name, String value) {
        TreeElement node = new TreeElement(name, 0);
        if (value != null) node.setValue(new StringData(value));
        return node;
    }
    private static final class Runtime extends CommCareInstanceInitializer {
        final MockUserDataSandbox sandbox;
        Runtime() throws Exception { this(MockDataUtils.getStaticStorage()); }
        private Runtime(MockUserDataSandbox sandbox) throws Exception {
            super(sandbox); this.sandbox = sandbox;
            sandbox.setLoggedInUser(new User("proof", "unused", "worker-proof"));
            for (String value : Arrays.asList("active", "closed", "unknown", "active closed", "a.'\"/b")) {
                Case record = new Case(value, "patient"); record.setCaseId(value); record.setProperty("care_status", value);
                sandbox.getCaseStorage().write(record);
            }
        }
        @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance) {
            TreeElement session = node("session", null), context = node("context", null), data = node("data", null);
            for (String key : new String[]{"deviceid", "appversion", "username", "userid"}) context.addChild(node(key, "proof"));
            context.addChild(node("drift", "0")); data.addChild(node("case_id", "active"));
            session.addChild(context); session.addChild(data);
            InstanceUtils.setUpInstanceRoot(session, instance.getInstanceId(), instance.getBase());
            return new ConcreteInstanceRoot(session);
        }
        EvaluationContext context(Hashtable<String, DataInstance> instances) {
            for (String id : new ArrayList<>(instances.keySet())) instances.put(id, instances.get(id).initialize(this, id));
            return new EvaluationContext(null, instances);
        }
    }
    @Test public void nativePromptsResolveMediaAndOptionalContentOnBothExportPaths() throws Exception {
        Properties refs = properties("media-paths.properties");
        for (String scenario : SCENARIOS) for (String suffix : Arrays.asList(".xml", ".hq.xml")) {
            boolean enabled = scenario.endsWith("-on"), only = scenario.startsWith("media-only");
            Runtime runtime = new Runtime(); FormParseInit parsed = parse(scenario + suffix);
            parsed.getFormDef().initialize(true, runtime); parsed.getFormDef().getLocalizer().setLocale("en");
            FormEntryController controller = parsed.getFormEntryController(); controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());
            int questions = 0;
            while (controller.stepToNextEvent() != FormEntryController.EVENT_END_OF_FORM) {
                if (parsed.getFormEntryModel().getEvent() != FormEntryController.EVENT_QUESTION) continue;
                FormEntryPrompt prompt = parsed.getFormEntryModel().getQuestionPrompt(); questions++;
                if (questions == 1) {
                    assertEquals("Answer 雪", prompt.getQuestionText());
                    assertEquals(enabled ? refs.getProperty("label") : null, prompt.getImageText());
                    assertEquals(enabled ? refs.getProperty("audio") : null, prompt.getAudioText());
                    assertEquals(enabled ? refs.getProperty("video") : null, prompt.getVideoText());
                    assertEquals(enabled ? refs.getProperty("audio") : null, prompt.getHelpMultimedia("audio"));
                    assertEquals(!only || enabled, prompt.hasHelp());
                    if (!only) { assertEquals("A hint", prompt.getHintText()); assertEquals("Some help", prompt.getHelpText()); assertEquals("Use ok", prompt.getConstraintText()); }
                    assertEquals(FormEntryController.ANSWER_CONSTRAINT_VIOLATED, controller.answerQuestion(new StringData("wrong")));
                    assertEquals(FormEntryController.ANSWER_OK, controller.answerQuestion(new StringData("ok")));
                } else {
                    assertEquals(6, prompt.getSelectChoices().size());
                    assertEquals("One", prompt.getSelectChoiceText(prompt.getSelectChoices().get(0)));
                    assertEquals(enabled ? refs.getProperty("option") : null, prompt.getSpecialFormSelectChoiceText(prompt.getSelectChoices().get(0), "image"));
                    assertEquals(enabled ? refs.getProperty("audio") : null, prompt.getSpecialFormSelectChoiceText(prompt.getSelectChoices().get(0), "audio"));
                    assertEquals(enabled ? refs.getProperty("video") : null, prompt.getSpecialFormSelectChoiceText(prompt.getSelectChoices().get(0), "video"));
                    assertNull(prompt.getSpecialFormSelectChoiceText(prompt.getSelectChoices().get(1), "image"));
                    // One file of each format defect 11's first half accepts, each in a slot of its kind.
                    String[][] formats = {{"2", "image", "bmp"}, {"2", "audio", "m4a"}, {"2", "video", "webm"}, {"3", "audio", "flac"}, {"4", "audio", "oggVorbis"}, {"5", "audio", "oggOpus"}};
                    for (String[] format : formats) {
                        SelectChoice choice = prompt.getSelectChoices().get(Integer.parseInt(format[0]));
                        assertEquals(String.join(" ", format), enabled ? refs.getProperty(format[2]) : null, prompt.getSpecialFormSelectChoiceText(choice, format[1]));
                    }
                }
            }
            assertEquals(2, questions);
        }
    }
    @Test public void nativeSuiteNavigationAndImageMapResolveExactPaths() throws Exception {
        Properties refs = properties("media-paths.properties");
        for (String scenario : SCENARIOS) for (String path : Arrays.asList(scenario, scenario + ".hq")) {
            boolean enabled = scenario.endsWith("-on"); locale(path); Runtime runtime = new Runtime();
            Suite suite;
            try (InputStream input = new ByteArrayInputStream(resource(path + ".suite.xml"))) { suite = new SuiteParser(input, ResourceTable.RetrieveTable(new DummyIndexedStorageUtility(Resource.class, new LivePrototypeFactory())), "suite", runtime.sandbox.getAppFixtureStorage()).parse(); }
            Menu menu = suite.getMenus().firstElement();
            assertEquals(enabled ? refs.getProperty("icon") : null, menu.getImageURI());
            assertEquals(enabled ? refs.getProperty("audio") : null, menu.getAudioURI());
            EvaluationContext context = runtime.context(suite.getEntry("m0-f0").getInstances(null));
            Detail detail = suite.getDetail("m0_case_short");
            for (String value : Arrays.asList("active", "closed", "unknown", "active closed", "a.'\"/b")) {
                List<TreeReference> matches = context.expandReference(XPathReference.getPathExpr("instance('casedb')/casedb/case[care_status = " + xpathString(value) + "]").getReference());
                assertEquals(1, matches.size());
                String expected = !enabled ? value : value.startsWith("active") ? refs.getProperty("label") : value.equals("closed") ? refs.getProperty("option") : value.equals("a.'\"/b") ? refs.getProperty("icon") : "";
                assertEquals(path + " " + value, expected, detail.getFields()[1].getTemplate().evaluate(new EvaluationContext(context, matches.get(0))));
            }
        }
    }
    private String xpathString(String value) {
        if (!value.contains("'")) return "'" + value + "'";
        return "concat('a.', \"'\", '\"/b')";
    }
    private ResourceTable mediaTable(String xml) throws Exception {
        ResourceTable table = ResourceTable.RetrieveTable(new DummyIndexedStorageUtility(Resource.class, new LivePrototypeFactory()));
        try (InputStream input = new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8))) { new SuiteParser(input, table, "media", null).parse(); }
        return table;
    }
    /** The file-system install, Android's shape: a media resource installs from a file that exists, never from one that doesn't. */
    @Test public void fileSystemMediaResourcesInstallOnlyWhenLocalBytesExist() throws Exception {
        String directory = NativeProof.familyDirectory("media").toString();
        for (String scenario : SCENARIOS) {
            ResourceTable table = mediaTable(new String(resource(scenario + ".media-suite.xml"), StandardCharsets.UTF_8));
            Vector<Resource> resources = table.getResourcesForParent("media"); assertEquals(scenario.endsWith("-on") ? 11 : 0, resources.size());
            for (Resource entry : resources) {
                assertEquals(1, entry.getLocations().size()); ResourceLocation location = entry.getLocations().firstElement();
                Path file = Path.of(directory, location.getLocation()).normalize();
                assertTrue(entry.getInstaller().install(entry, location, new JavaFileReference(file.getParent().toString(), file.getFileName().toString()), table, null, false, null));
                Path missing = file.resolveSibling("missing-" + file.getFileName());
                assertFalse(entry.getInstaller().install(entry, location, new JavaFileReference(missing.getParent().toString(), missing.getFileName().toString()), table, null, false, null));
            }
        }
    }
    /**
     * The archive install, Core's and Formplayer's shape: Nova's local archive registered with Core's
     * ArchiveFileRoot. Every media resource installs from its archive reference, and so does a reference to a
     * file the archive does not hold (ArchiveFileReference.doesBinaryExist answers true), which records that an
     * archive install is not the bundling proof. The proof is the archive itself: it holds an entry at each
     * location's path whose SHA-256 is the hash the path names.
     */
    @Test public void archiveMediaResourcesInstallWhetherTheArchiveHoldsTheFileOrNot() throws Exception {
        String directory = NativeProof.familyDirectory("media").toString();
        ArchiveFileRoot root = new ArchiveFileRoot();
        for (String scenario : SCENARIOS) {
            ResourceTable table = mediaTable(new String(resource(scenario + ".media-suite.xml"), StandardCharsets.UTF_8));
            Vector<Resource> resources = table.getResourcesForParent("media"); assertEquals(scenario.endsWith("-on") ? 11 : 0, resources.size());
            try (ZipFile archive = new ZipFile(Path.of(directory, scenario + ".ccz").toFile())) {
                String guid = root.addArchiveFile(archive);
                for (Resource entry : resources) {
                    assertEquals(1, entry.getLocations().size()); ResourceLocation location = entry.getLocations().firstElement();
                    String path = location.getLocation().startsWith("./") ? location.getLocation().substring(2) : location.getLocation();
                    int slash = path.lastIndexOf('/');
                    String name = path.substring(slash + 1), missing = path.substring(0, slash + 1) + "missing-" + name;
                    assertTrue(path, entry.getInstaller().install(entry, location, root.derive("jr://archive/" + guid + "/" + path), table, null, false, null));
                    assertTrue(missing, entry.getInstaller().install(entry, location, root.derive("jr://archive/" + guid + "/" + missing), table, null, false, null));
                    ZipEntry held = archive.getEntry(path); assertNotNull(path, held);
                    byte[] bytes; try (InputStream stream = archive.getInputStream(held)) { bytes = stream.readAllBytes(); }
                    assertEquals(path, name.substring(0, name.indexOf('.')), HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)));
                }
            }
        }
    }
    @Test public void parserCounterexamplesDistinguishCoreRulesFromNovaConventions() throws Exception {
        for (String version : Arrays.asList("+1", "-2147483648", "2147483647")) mediaTable("<suite version='" + version + "'/>");
        for (String version : Arrays.asList("2147483648", "-2147483649", "1.2")) {
            try { mediaTable("<suite version='" + version + "'/>"); fail(version); } catch (NumberFormatException expected) { }
        }
        try { mediaTable("<wrapper><suite version='1'/></wrapper>"); fail("Nested suite must refuse"); } catch (org.javarosa.xml.util.InvalidStructureException expected) { }
        // The native InstallerFactory ignores the media path. Empty media is
        // legal. Nova can require a complete emitted resource as its own rule.
        assertEquals(0, mediaTable("<suite version='1'><media/></suite>").getResourcesForParent("media").size());
        String first = "<resource id='same' version='+1'><location authority='local'>./first.png</location></resource>";
        String second = "<resource id='same' version='1'><location authority='local'>./second.png</location></resource>";
        ResourceTable table = mediaTable("<suite version='1'><media>" + first + second + "</media></suite>");
        assertEquals(1, table.getResourcesForParent("media").size());
        assertEquals("./first.png", table.getResourceWithId("same").getLocations().firstElement().getLocation());
    }
}
