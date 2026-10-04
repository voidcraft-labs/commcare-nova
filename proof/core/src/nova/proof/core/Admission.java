package nova.proof.core;

import org.commcare.resources.ResourceInstallContext;
import org.commcare.resources.ResourceManager;
import org.commcare.resources.model.InstallRequestSource;
import org.commcare.resources.model.InstallerFactory;
import org.commcare.resources.model.Resource;
import org.commcare.resources.model.ResourceInitializationException;
import org.commcare.resources.model.ResourceLocation;
import org.commcare.resources.model.ResourceTable;
import org.commcare.resources.model.UnresolvedResourceException;
import org.commcare.resources.model.installers.MediaInstaller;
import org.commcare.suite.model.Entry;
import org.commcare.suite.model.Menu;
import org.commcare.suite.model.Profile;
import org.commcare.suite.model.PropertySetter;
import org.commcare.suite.model.Suite;
import org.commcare.util.CommCarePlatform;
import org.commcare.util.engine.CommCareConfigEngine;
import org.commcare.xml.ProfileParser;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.reference.ReferenceHandler;
import org.javarosa.core.services.locale.Localization;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;
import org.javarosa.core.services.storage.StorageManager;
import org.javarosa.core.services.storage.util.DummyIndexedStorageUtility;
import org.javarosa.xml.ElementParser;
import org.javarosa.xml.util.UnfullfilledRequirementsException;
import org.json.JSONArray;
import org.json.JSONObject;
import org.kxml2.io.KXmlParser;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.TreeMap;
import java.util.stream.Stream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Admits an archive the way Core's archive installer does and reports what Core
 * made of it.
 *
 * The install is CommCareConfigEngine's: ResourceManager.installAppResources
 * from the archive's profile.ccpr with forceInstall true (so, like Core's CLI
 * and Formplayer, it never refuses on the profile's required version), then
 * initEnvironment, then Localization.setLocale for every locale, because the
 * installer only records where each app_strings file lives and Core reads it
 * the first time its locale is set.
 *
 * Core's installer stops at the first resource it cannot install. To report
 * every problem rather than the first, a refused resource is recorded, taken out
 * of the table, and the installer is run again over what remains, until nothing
 * more is refused. The archive is admitted only when nothing was refused.
 */
final class Admission {
    static final String PLATFORM_VERSION = CommCareConfigEngine.MAJOR_VERSION + "."
            + CommCareConfigEngine.MINOR_VERSION + "." + CommCareConfigEngine.MINIMAL_VERSION;
    private static final String[] PROFILE_ATTRIBUTES = {"version", "update", "requiredMajor", "requiredMinor",
            "requiredMinimal", "uniqueid", "name", "buildProfileID"};

    private Admission() {
    }

    /**
     * {"path": a .ccz file or a directory whose files are the archive's entries,
     * "platformVersion"?: "2.64.0"} gives the admission report, with "appHandle"
     * set when the archive was admitted, and "archiveRoot", the jr://archive/
     * root its resources were read under (the handle it was admitted or refused
     * under, numbered by this runner's admissions), wherever it was opened.
     */
    static JSONObject admit(JSONObject request, Apps apps) throws Exception {
        File source = new File(Ops.requireString(request, "path"));
        String platformVersion = request.optString("platformVersion", PLATFORM_VERSION);
        int[] platform = parsePlatformVersion(platformVersion);
        JSONObject report = new JSONObject();
        JSONArray problems = new JSONArray();
        report.put("problems", problems);

        Path temporary = null;
        File archive = source;
        if (source.isDirectory()) {
            temporary = zipDirectory(source.toPath());
            archive = temporary.toFile();
        } else if (!source.isFile()) {
            throw new RequestException("There is no archive or directory at " + source
                    + ". Pass the path of a .ccz file or of a directory holding its entries.");
        }

        ZipFile zip;
        try {
            zip = new ZipFile(archive);
        } catch (IOException e) {
            problems.put(problem("archive", null, e));
            report.put("admitted", false);
            report.put("appHandle", JSONObject.NULL);
            if (temporary != null) {
                Files.deleteIfExists(temporary);
            }
            return report;
        }

        apps.clearActive();
        ReferenceHandler.clearInstance();
        // A profile without "uniqueid" gets a random one (ProfileParser); seeded, it is the same every time.
        Generated.seedCoreRandomness();
        ProofEngine engine = ProofEngine.create();
        String handle = apps.nextHandle();
        Apps.App app = new Apps.App(handle, engine, handle, zip, temporary);
        boolean admitted = false;
        report.put("archiveRoot", handle);
        try {
            engine.archiveRoot().registerArchive(handle, zip);
            report.put("profile", readProfileAttributes(zip, problems));
            report.put("versionCheck", versionCheck(zip, platformVersion, platform, engine));

            boolean profileInstalled = install(engine, "jr://archive/" + handle + "/profile.ccpr", problems);
            if (profileInstalled) {
                initialize(engine, problems);
                describe(engine, zip, report, problems);
            }
            report.put("resources", resources(engine));

            admitted = problems.length() == 0;
            report.put("admitted", admitted);
            if (admitted) {
                app.profile = profileForTrace(report.getJSONObject("profile"));
                apps.add(app);
                report.put("appHandle", handle);
            } else {
                report.put("appHandle", JSONObject.NULL);
            }
            return report;
        } finally {
            if (!admitted) {
                app.close();
                ReferenceHandler.clearInstance();
            }
        }
    }

    /**
     * The platform version a request names, as Core's CommCarePlatform takes it;
     * checked before the archive is opened, so a malformed one leaves nothing open.
     */
    private static int[] parsePlatformVersion(String platformVersion) {
        String[] parts = platformVersion.split("\\.");
        int[] version = new int[3];
        try {
            if (parts.length != 3) {
                throw new NumberFormatException();
            }
            for (int i = 0; i < 3; i++) {
                version[i] = Integer.parseInt(parts[i]);
            }
        } catch (NumberFormatException e) {
            throw new RequestException("platformVersion must be major.minor.minimal in whole numbers, such as "
                    + PLATFORM_VERSION + "; it was \"" + platformVersion + "\".");
        }
        return version;
    }

    /**
     * What a session trace carries of the profile: its required version as the
     * profile.ccpr states it (Core keeps none) and the properties Core installed.
     */
    private static JSONObject profileForTrace(JSONObject profile) {
        JSONObject trace = new JSONObject();
        JSONObject required = new JSONObject();
        for (String attribute : new String[]{"requiredMajor", "requiredMinor", "requiredMinimal"}) {
            required.put(attribute, profile.opt(attribute));
        }
        trace.put("requiredVersion", required);
        trace.put("properties", profile.optJSONArray("properties") == null ? new JSONArray()
                : profile.getJSONArray("properties"));
        return trace;
    }

    /** Returns whether the profile itself installed. */
    private static boolean install(ProofEngine engine, String profileReference, JSONArray problems) {
        IStorageUtilityIndexed<Resource> storage = engine.resourceStorage();
        ResourceInstallContext context = new ResourceInstallContext(InstallRequestSource.INSTALL);
        boolean first = true;
        for (int attempt = 0; attempt <= storage.getNumRecords() + 1; attempt++) {
            Resource refused;
            try {
                if (first) {
                    first = false;
                    engine.installAppFromReference(profileReference);
                } else {
                    ResourceTable.RetrieveTable(storage, new InstallerFactory())
                            .prepareResources(null, engine.getPlatform(), context);
                }
                break;
            } catch (UnresolvedResourceException e) {
                refused = e.getResource();
                problems.put(problem("install", refused, e));
            } catch (UnfullfilledRequirementsException e) {
                problems.put(problem("install", null, e));
                break;
            } catch (Exception e) {
                refused = engine.archiveRoot().resourceLastRead(storage);
                problems.put(problem("install", refused, e));
            }
            if (refused == null || CommCarePlatform.APP_PROFILE_RESOURCE_ID.equals(refused.getResourceId())) {
                break;
            }
            storage.remove(refused.getID());
        }
        Resource profile = find(storage, CommCarePlatform.APP_PROFILE_RESOURCE_ID);
        return profile != null && profile.getStatus() == Resource.RESOURCE_STATUS_INSTALLED;
    }

    private static void initialize(ProofEngine engine, JSONArray problems) {
        try {
            engine.initEnvironment();
        } catch (ResourceInitializationException e) {
            problems.put(problem("initialize", e.getResource(), e.getCause() == null ? e : (Exception)e.getCause()));
            return;
        } catch (RuntimeException e) {
            problems.put(problem("initialize", null, e));
            return;
        }
        String current = Localization.getCurrentLocale();
        for (String locale : Localization.getGlobalLocalizerAdvanced().getAvailableLocales()) {
            try {
                Localization.setLocale(locale);
            } catch (RuntimeException e) {
                JSONObject problem = problem("locale", null, e);
                problem.put("locale", locale);
                problems.put(problem);
            }
        }
        try {
            Localization.setLocale(current);
        } catch (RuntimeException e) {
            JSONObject problem = problem("locale", null, e);
            problem.put("locale", current);
            problems.put(problem);
        }
        // Ready as Core's installer counts it (ResourceTable.getUnreadyResources): installed, or ready for
        // upgrade, which is where OfflineUserRestoreInstaller.install leaves a practice user restore on a
        // fresh install.
        for (IStorageIterator<Resource> it = engine.resourceStorage().iterate(); it.hasMore(); ) {
            Resource resource = it.nextRecord();
            if (resource.getStatus() != Resource.RESOURCE_STATUS_INSTALLED
                    && resource.getStatus() != Resource.RESOURCE_STATUS_UPGRADE) {
                JSONObject problem = new JSONObject();
                problem.put("stage", "table");
                problem.put("resource", resource.getResourceId());
                problem.put("descriptor", resource.getDescriptor());
                problem.put("message", "Core left this resource " + ResourceTable.getStatusString(resource.getStatus())
                        + ", which its installer does not count as ready.");
                problems.put(problem);
            }
        }
    }

    private static JSONObject problem(String stage, Resource resource, Exception error) {
        JSONObject problem = new JSONObject();
        problem.put("stage", stage);
        problem.put("resource", resource == null ? JSONObject.NULL : resource.getResourceId());
        if (resource != null) {
            problem.put("descriptor", resource.getDescriptor());
        }
        problem.put("class", error.getClass().getName());
        problem.put("message", String.valueOf(error.getMessage()));
        Throwable cause = error.getCause();
        if (cause != null && cause != error) {
            problem.put("cause", cause.getClass().getName() + ": " + cause.getMessage());
        }
        return problem;
    }

    private static Resource find(IStorageUtilityIndexed<Resource> storage, String id) {
        for (IStorageIterator<Resource> it = storage.iterate(); it.hasMore(); ) {
            Resource resource = it.nextRecord();
            if (id.equals(resource.getResourceId())) {
                return resource;
            }
        }
        return null;
    }

    /**
     * The profile's root attributes as they stand in profile.ccpr, read with
     * Core's own XML pull parser. Core's Profile keeps no required version, and
     * a profile without "uniqueid" gets a random one from ProfileParser, so the
     * harness reads the attributes itself.
     */
    private static JSONObject readProfileAttributes(ZipFile zip, JSONArray problems) {
        JSONObject attributes = new JSONObject();
        ZipEntry entry = zip.getEntry("profile.ccpr");
        if (entry == null) {
            JSONObject problem = new JSONObject();
            problem.put("stage", "archive");
            problem.put("resource", CommCarePlatform.APP_PROFILE_RESOURCE_ID);
            problem.put("message", "The archive has no profile.ccpr at its root, which Core's archive installer"
                    + " starts from.");
            problems.put(problem);
            return attributes;
        }
        try (InputStream in = zip.getInputStream(entry)) {
            KXmlParser parser = ElementParser.instantiateParser(in);
            while (parser.getEventType() != KXmlParser.START_TAG) {
                parser.next();
            }
            attributes.put("element", parser.getName());
            for (String name : PROFILE_ATTRIBUTES) {
                String value = parser.getAttributeValue(null, name);
                attributes.put(name, value == null ? JSONObject.NULL : value);
            }
        } catch (Exception e) {
            attributes.put("unreadable", e.getClass().getName() + ": " + e.getMessage());
        }
        return attributes;
    }

    /**
     * Core's own required-version check (ProfileParser with forceVersion false, as
     * Android's installer runs it) against the given platform version, on a
     * scratch resource table. The archive install itself is forced, as Core's
     * archive installer forces it, so this verdict does not decide admission.
     */
    private static JSONObject versionCheck(ZipFile zip, String platformVersion, int[] version,
                                           ProofEngine engine) {
        JSONObject check = new JSONObject();
        check.put("platform", platformVersion);
        ZipEntry entry = zip.getEntry("profile.ccpr");
        if (entry == null) {
            check.put("accepted", JSONObject.NULL);
            return check;
        }
        CommCarePlatform platform = new CommCarePlatform(version[0], version[1], version[2],
                new StorageManager(new ProofEngine.Storages()));
        ResourceTable scratch = ResourceTable.RetrieveTable(
                new DummyIndexedStorageUtility<>(Resource.class, engine.prototypes()), new InstallerFactory());
        try (InputStream in = zip.getInputStream(entry)) {
            new ProfileParser(in, platform, scratch, "proof-version-check",
                    Resource.RESOURCE_STATUS_UNINITIALIZED, false).parse();
            check.put("accepted", true);
        } catch (UnfullfilledRequirementsException e) {
            check.put("accepted", false);
            check.put("message", e.getMessage());
        } catch (Exception e) {
            check.put("accepted", JSONObject.NULL);
            check.put("message", e.getClass().getName() + ": " + e.getMessage());
        }
        return check;
    }

    private static void describe(ProofEngine engine, ZipFile zip, JSONObject report, JSONArray problems) {
        CommCarePlatform platform = engine.getPlatform();
        Profile profile = platform.getCurrentProfile();
        JSONObject installedProfile = report.getJSONObject("profile");
        if (profile != null) {
            installedProfile.put("installedVersion", profile.getVersion());
            installedProfile.put("installedUniqueId", profile.getUniqueId());
            installedProfile.put("uniqueIdGenerated", installedProfile.isNull("uniqueid"));
            installedProfile.put("displayName", profile.getDisplayName());
            JSONArray properties = new JSONArray();
            for (PropertySetter property : profile.getPropertySetters()) {
                JSONObject setter = new JSONObject();
                setter.put("key", property.getKey());
                setter.put("value", property.getValue() == null ? JSONObject.NULL : property.getValue());
                setter.put("force", property.isForce());
                properties.put(setter);
            }
            installedProfile.put("properties", properties);
        }

        JSONArray suites = new JSONArray();
        for (Suite suite : platform.getInstalledSuites()) {
            JSONObject described = new JSONObject();
            JSONArray menus = new JSONArray();
            for (Menu menu : suite.getMenus()) {
                JSONObject m = new JSONObject();
                m.put("id", menu.getId());
                m.put("root", menu.getRoot());
                m.put("commands", new JSONArray(menu.getCommandIds()));
                menus.put(m);
            }
            described.put("menus", menus);
            JSONArray entries = new JSONArray();
            for (String command : new TreeMap<>(suite.getEntries()).keySet()) {
                Entry entry = suite.getEntries().get(command);
                JSONObject e = new JSONObject();
                e.put("command", command);
                e.put("xmlns", entry.getXFormNamespace() == null ? JSONObject.NULL : entry.getXFormNamespace());
                e.put("view", entry.isView());
                e.put("remoteRequest", entry.isRemoteRequest());
                entries.put(e);
            }
            described.put("entries", entries);
            List<String> endpoints = new ArrayList<>(suite.getEndpoints().keySet());
            Collections.sort(endpoints);
            described.put("endpoints", new JSONArray(endpoints));
            suites.put(described);
        }
        report.put("suites", suites);

        JSONArray forms = new JSONArray();
        IStorageUtilityIndexed<FormDef> formStorage = platform.getStorageManager().getStorage(FormDef.STORAGE_KEY);
        for (IStorageIterator<FormDef> it = formStorage.iterate(); it.hasMore(); ) {
            FormDef form = it.nextRecord();
            JSONObject f = new JSONObject();
            f.put("xmlns", form.getMetaData("XMLNS"));
            f.put("title", form.getTitle() == null ? JSONObject.NULL : form.getTitle());
            forms.put(f);
        }
        report.put("forms", sortedBy(forms, "xmlns"));

        JSONArray locales = new JSONArray();
        try {
            for (String locale : Localization.getGlobalLocalizerAdvanced().getAvailableLocales()) {
                locales.put(locale);
            }
            report.put("currentLocale", Localization.getCurrentLocale());
        } catch (RuntimeException e) {
            problems.put(problem("locale", null, e));
        }
        report.put("locales", locales);

        JSONArray media = new JSONArray();
        for (IStorageIterator<Resource> it = engine.resourceStorage().iterate(); it.hasMore(); ) {
            Resource resource = it.nextRecord();
            if (!(resource.getInstaller() instanceof MediaInstaller)) {
                continue;
            }
            JSONObject m = new JSONObject();
            m.put("id", resource.getResourceId());
            for (ResourceLocation location : resource.getLocations()) {
                if (location.getAuthority() == Resource.RESOURCE_AUTHORITY_LOCAL) {
                    String path = location.getLocation();
                    m.put("location", path);
                    if (location.isRelative()) {
                        m.put("bytesInArchive", zip.getEntry(path.substring(2)) != null);
                    }
                    break;
                }
            }
            media.put(m);
        }
        report.put("media", sortedBy(media, "id"));
    }

    private static JSONArray resources(ProofEngine engine) {
        JSONArray resources = new JSONArray();
        for (IStorageIterator<Resource> it = engine.resourceStorage().iterate(); it.hasMore(); ) {
            Resource resource = it.nextRecord();
            JSONObject r = new JSONObject();
            r.put("id", resource.getResourceId());
            r.put("descriptor", resource.getDescriptor());
            r.put("status", ResourceTable.getStatusString(resource.getStatus()));
            r.put("installer", resource.getInstaller() == null ? JSONObject.NULL
                    : resource.getInstaller().getClass().getSimpleName());
            r.put("version", resource.getVersion());
            JSONArray locations = new JSONArray();
            for (ResourceLocation location : resource.getLocations()) {
                JSONObject l = new JSONObject();
                l.put("authority", location.getAuthority() == Resource.RESOURCE_AUTHORITY_LOCAL ? "local"
                        : location.getAuthority() == Resource.RESOURCE_AUTHORITY_REMOTE ? "remote"
                        : String.valueOf(location.getAuthority()));
                l.put("location", location.getLocation());
                locations.put(l);
            }
            r.put("locations", locations);
            resources.put(r);
        }
        return sortedBy(resources, "id");
    }

    static JSONArray sortedBy(JSONArray items, String key) {
        List<JSONObject> list = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            list.add(items.getJSONObject(i));
        }
        list.sort((a, b) -> String.valueOf(a.opt(key)).compareTo(String.valueOf(b.opt(key))));
        return new JSONArray(list);
    }

    /**
     * HQ's built files arranged as an archive: every file under the directory
     * becomes the entry at its relative path, in path order.
     */
    private static Path zipDirectory(Path directory) throws IOException {
        List<Path> files;
        try (Stream<Path> walk = Files.walk(directory)) {
            files = walk.filter(Files::isRegularFile).sorted().toList();
        }
        Path zip = Files.createTempFile("proof-core-", ".ccz");
        try (OutputStream out = Files.newOutputStream(zip); ZipOutputStream zipOut = new ZipOutputStream(out)) {
            for (Path file : files) {
                String name = directory.relativize(file).toString().replace(File.separatorChar, '/');
                zipOut.putNextEntry(new ZipEntry(name));
                Files.copy(file, zipOut);
                zipOut.closeEntry();
            }
        } catch (IOException | RuntimeException e) {
            Files.deleteIfExists(zip);
            throw e;
        }
        return zip;
    }
}
