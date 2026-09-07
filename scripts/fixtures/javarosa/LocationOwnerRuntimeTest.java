package nova.compatibility;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import org.commcare.cases.model.Case;
import org.commcare.core.parse.ParseUtils;
import org.commcare.core.process.CommCareInstanceInitializer;
import org.commcare.core.process.XmlFormRecordProcessor;
import org.commcare.util.mocks.MockDataUtils;
import org.commcare.util.mocks.MockUserDataSandbox;
import org.javarosa.core.model.FormIndex;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.core.model.instance.utils.InstanceUtils;
import org.javarosa.core.test.FormParseInit;
import org.javarosa.form.api.FormEntryController;
import org.javarosa.model.xform.XFormSerializingVisitor;
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
  try(InputStream restore=getClass().getResourceAsStream("/location-"+fixture+".restore.xml")){assertNotNull(restore);ParseUtils.parseIntoSandbox(restore,sandbox);}
  Case patient=new Case("Patient","patient");patient.setCaseId("patient-1");patient.setUserId(owner);sandbox.getCaseStorage().write(patient);
  FormParseInit parsed=new FormParseInit("/location-"+scenario+(hq?".hq.xml":".xml"));parsed.getFormDef().initialize(true,new Runtime(sandbox));
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
}
