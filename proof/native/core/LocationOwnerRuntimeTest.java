package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Hashtable;
import java.util.Vector;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.commcare.cases.model.Case;
import org.commcare.core.parse.ParseUtils;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.suite.model.Entry;
import org.commcare.suite.model.StackOperation;
import org.commcare.suite.model.Suite;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.FormDef;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.model.xform.XFormSerializingVisitor;
import org.javarosa.test_utils.ExprEvalUtils;
import org.javarosa.xform.util.XFormUtils;
import org.javarosa.xpath.XPathTypeMismatchException;
import org.javarosa.xml.util.InvalidStructureException;
import org.junit.Test;
import static org.junit.Assert.*;

/** Native HQ restore bytes, actual fixture storage, and executable owner forms. */
public class LocationOwnerRuntimeTest {
 private static TreeElement node(String name,String value){TreeElement n=new TreeElement(name,0);if(value!=null)n.setValue(new StringData(value));return n;}
 private static class Runtime extends CommCareInstanceInitializer {
  final MockUserDataSandbox sandbox;
  Runtime(MockUserDataSandbox sandbox){super(sandbox);this.sandbox=sandbox;}
  @Override protected InstanceRoot setupSessionData(ExternalDataInstance instance){
   TreeElement root=node("session",null),context=node("context",null),data=node("data",null);
   context.addChild(node("userid","worker"));for(String key:new String[]{"deviceid","username","appversion"})context.addChild(node(key,"fixture-"+key));context.addChild(node("drift","0"));
   data.addChild(node("case_id","patient-1"));root.addChild(context);root.addChild(data);
   InstanceUtils.setUpInstanceRoot(root,instance.getInstanceId(),instance.getBase());return new ConcreteInstanceRoot(root);
  }
 }
 private String submit(String scenario,String fixture,String owner,boolean hq)throws Exception {
  MockUserDataSandbox sandbox=MockDataUtils.getStaticStorage();
  try(InputStream restore=getClass().getResourceAsStream("/location/location-"+fixture+".restore.xml")){assertNotNull(restore);ParseUtils.parseIntoSandbox(restore,sandbox);}
  Case patient=new Case("Patient","patient");patient.setCaseId("patient-1");patient.setUserId(owner);sandbox.getCaseStorage().write(patient);
  FormParseInit parsed=new FormParseInit("/location/location-"+scenario+(hq?".hq.xml":".xml"));parsed.getFormDef().initialize(true,new Runtime(sandbox));
  FormEntryController controller=parsed.getFormEntryController();controller.jumpToIndex(FormIndex.createBeginningOfFormIndex());int steps=0;
  while(controller.stepToNextEvent()!=FormEntryController.EVENT_END_OF_FORM){if(++steps>20)throw new AssertionError("Form did not terminate");}
  parsed.getFormDef().postProcessInstance();byte[] xml=new XFormSerializingVisitor().serializeInstance(parsed.getFormDef().getMainInstance());
  XmlFormRecordProcessor.process(sandbox,new ByteArrayInputStream(xml));
  return sandbox.getCaseStorage().getRecordForValue(Case.INDEX_CASE_ID,"patient-1").getUserId();
 }
 @Test public void directHopSelectsItsOwnBranchFromRealIndexedFixture()throws Exception {
  for(boolean hq:new boolean[]{false,true}){assertEquals("place-3",submit("direct","complete","place-2",hq));assertEquals("place-6",submit("direct","complete","place-5",hq));}
 }
 @Test public void nonOwningIntermediateLevelDoesNotChangeTheDestination()throws Exception {
  for(boolean hq:new boolean[]{false,true}){assertEquals("place-3",submit("multirung","complete","place-1",hq));assertEquals("place-6",submit("multirung","complete","place-4",hq));}
 }
 @Test public void missingIntermediatePlaceStillReachesTheOwningAncestor()throws Exception {
  for(boolean hq:new boolean[]{false,true})assertEquals("place-3",submit("multirung","skipped","place-1",hq));
 }
 @Test public void missingDestinationRefusesTheSubmittedForm()throws Exception {
  for(boolean hq:new boolean[]{false,true})for(String fixture:new String[]{"empty","missing"}) {
   try {submit("direct",fixture,"place-2",hq);fail("Missing destination must refuse transfer");}
   catch(XPathTypeMismatchException failure) {assertEquals("empty",fixture);}
   catch(InvalidStructureException failure) {assertEquals("missing",fixture);assertTrue(failure.getMessage().contains("case_id"));}
  }
 }
 @Test public void ordinaryOwnerDoesNotNeedLocationData()throws Exception {
  for(boolean hq:new boolean[]{false,true})assertEquals("worker",submit("plain","empty","place-1",hq));
 }
 private static final class ReadOnlyParser extends SuiteParser {
  ReadOnlyParser(InputStream stream)throws IOException{super(stream,null,"nova-location",null,true,true,false);}
 }
 /** A member of the targeted document's local archive, or HQ's regeneration of it. */
 private static byte[] targeted(Path document,boolean hq,String member,String hqFile)throws IOException {
  if(hq)return Files.readAllBytes(document.resolve(hqFile));
  try(ZipFile archive=new ZipFile(document.resolve("local.ccz").toFile())){
   ZipEntry entry=archive.getEntry(member);assertNotNull(document+" must contain "+member,entry);
   try(InputStream input=archive.getInputStream(entry)){return input.readAllBytes();}
  }
 }
 /** The regions table a sync delivers beside the places, which the form's entry also declares. */
 private static final String REGIONS="<OpenRosaResponse xmlns=\"http://openrosa.org/http/response\"><fixture id=\"item-list:regions\" user_id=\"worker\"><regions_list>"
  +"<regions><code>north</code><name>North region</name></regions><regions><code>south</code><name>South region</name></regions></regions_list></fixture></OpenRosaResponse>";
 /**
  * A form's logic and its after-submit link read places ({@code targeted-instance-reads}): over HQ's own flat
  * fixture of a region with a clinic directly under it, the form reads the clinic's name and its ward, a location
  * data field, and its first link fires on the clinic's name, on the local archive and on HQ's regenerated form
  * and hand-assembled suite, where HQ declares the flat {@code jr://fixture/locations}.
  */
 @Test public void formLogicAndItsLinkReadPlacesFromRealIndexedFixture()throws Exception {
  Path document=SessionReadAssertions.targeted("location","targeted-instance-reads");
  for(boolean hq:new boolean[]{false,true}){
   MockUserDataSandbox sandbox=MockDataUtils.getStaticStorage();
   try(InputStream restore=getClass().getResourceAsStream("/location/location-skipped.restore.xml")){assertNotNull(restore);ParseUtils.parseIntoSandbox(restore,sandbox);}
   ParseUtils.parseIntoSandbox(new ByteArrayInputStream(REGIONS.getBytes(StandardCharsets.UTF_8)),sandbox);
   Runtime runtime=new Runtime(sandbox);
   FormDef form=XFormUtils.getFormFromInputStream(new ByteArrayInputStream(targeted(document,hq,"modules-0/forms-0.xml","hq.0.xml")));
   form.initialize(true,runtime);
   assertEquals("hq="+hq,"clinic & North",ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/clinic_name)"));
   assertEquals("hq="+hq,"A & B",ExprEvalUtils.xpathEval(form.getEvaluationContext(),"string(/data/clinic_ward)"));
   Suite suite=new ReadOnlyParser(new ByteArrayInputStream(targeted(document,hq,"suite.xml","hq.suite.xml"))).parse();
   Entry entry=suite.getEntry("m0-f0");
   Hashtable<String,DataInstance> instances=entry.getInstances(null);
   assertEquals("jr://fixture/locations",((ExternalDataInstance)instances.get("locations")).getReference());
   for(String id:new ArrayList<>(instances.keySet()))instances.put(id,instances.get(id).initialize(runtime,id));
   Vector<StackOperation> links=entry.getPostEntrySessionOperations();
   assertTrue("The place link reads the clinic's name, hq="+hq,links.get(0).isOperationTriggered(new EvaluationContext(null,instances)));
  }
 }
}
