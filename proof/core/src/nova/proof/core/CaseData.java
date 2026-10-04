package nova.proof.core;

import org.commcare.cases.instance.CaseInstanceTreeElement;
import org.commcare.core.interfaces.UserSandbox;
import org.commcare.core.parse.ParseUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.util.CommCarePlatform;
import org.javarosa.core.model.User;
import org.javarosa.core.model.instance.ExternalDataInstance;
import org.javarosa.core.model.instance.FormInstance;
import org.javarosa.core.model.instance.InstanceInitializationFactory;
import org.javarosa.core.services.storage.IStorageIterator;
import org.javarosa.core.services.storage.IStorageUtilityIndexed;
import org.javarosa.model.xform.DataModelSerializer;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Collection;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.transform.OutputKeys;
import javax.xml.transform.Transformer;
import javax.xml.transform.TransformerFactory;
import javax.xml.transform.dom.DOMSource;
import javax.xml.transform.stream.StreamResult;

/** The user's case data: a sandbox loaded from a restore, and the views of it a trace records. */
final class CaseData {
    private CaseData() {
    }

    /**
     * A sandbox holding the restore, set up as Core's CLI host sets one up
     * (ApplicationHost.setupSandbox, restoreFileToSandbox and initUser): app
     * fixtures read from the platform's form-instance storage, the restore parsed
     * with Core's transaction parsers, and its first user logged in. The parse
     * fails fast, since a restore the harness generates must be one Core reads
     * whole.
     */
    static MockUserDataSandbox sandbox(CommCarePlatform platform, byte[] restore) throws Exception {
        MockUserDataSandbox sandbox = new MockUserDataSandbox(ProofEngine.PROTOTYPES);
        if (platform != null) {
            @SuppressWarnings("unchecked")
            IStorageUtilityIndexed<FormInstance> appFixtures = (IStorageUtilityIndexed<FormInstance>)
                    platform.getStorageManager().getStorage(FormInstance.STORAGE_KEY);
            sandbox.setAppFixtureStorageLocation(appFixtures);
        }
        try {
            ParseUtils.parseIntoSandbox(new ByteArrayInputStream(restore), sandbox, true);
        } catch (Exception e) {
            throw new RequestException("Core's transaction parsers could not read the restore (" + e.getClass()
                    .getSimpleName() + ": " + e.getMessage() + "). Send the case data as a restore Core reads,"
                    + " like Core's src/test/resources/session-tests-template/user_restore.xml.");
        }
        logInFirstUser(sandbox);
        return sandbox;
    }

    static void logInFirstUser(UserSandbox sandbox) {
        IStorageIterator<User> users = sandbox.getUserStorage().iterate();
        if (!users.hasMore()) {
            throw new RequestException("The restore holds no user registration (<Registration> in"
                    + " http://openrosa.org/user/registration); Core's session needs a logged-in user.");
        }
        sandbox.setLoggedInUser(users.nextRecord());
    }

    /** The casedb instance as Core serializes it (the pattern of Core's CaseTestUtils). */
    static String caseDb(InstanceInitializationFactory initializer) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new DataModelSerializer(out, initializer).serialize(
                new ExternalDataInstance(ExternalDataInstance.JR_CASE_DB_REFERENCE, CaseInstanceTreeElement.MODEL_NAME),
                null);
        return out.toString(StandardCharsets.UTF_8);
    }

    /**
     * A case search response holding every case of the requested types: the
     * casedb's own case elements under HQ's search root, <results id="case">
     * (casexml/apps/case/fixtures.py::CaseDBFixture, whose cases are
     * phone/xml.py::get_casedb_element, the casedb shape).
     */
    static byte[] searchResults(String caseDb, Collection<String> caseTypes) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        Document casedb = factory.newDocumentBuilder().parse(
                new ByteArrayInputStream(caseDb.getBytes(StandardCharsets.UTF_8)));
        Document results = factory.newDocumentBuilder().newDocument();
        Element root = results.createElement("results");
        root.setAttribute("id", "case");
        results.appendChild(root);
        NodeList children = casedb.getDocumentElement().getChildNodes();
        for (int i = 0; i < children.getLength(); i++) {
            Node child = children.item(i);
            if (child instanceof Element && "case".equals(child.getLocalName() == null ? child.getNodeName()
                    : child.getLocalName()) && caseTypes.contains(((Element)child).getAttribute("case_type"))) {
                root.appendChild(results.importNode(child, true));
            }
        }
        return serialize(results);
    }

    static int countCases(byte[] results) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        Document document = factory.newDocumentBuilder().parse(new ByteArrayInputStream(results));
        return document.getDocumentElement().getElementsByTagName("case").getLength();
    }

    static byte[] serialize(Document document) throws Exception {
        Transformer transformer = TransformerFactory.newInstance().newTransformer();
        transformer.setOutputProperty(OutputKeys.ENCODING, "UTF-8");
        transformer.setOutputProperty(OutputKeys.OMIT_XML_DECLARATION, "yes");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        transformer.transform(new DOMSource(document), new StreamResult(out));
        return out.toByteArray();
    }
}
