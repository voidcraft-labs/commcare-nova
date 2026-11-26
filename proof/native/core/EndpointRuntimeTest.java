package nova.compatibility;

import java.io.*;
import java.util.*;
import org.commcare.core.interfaces.VirtualDataInstanceStorage;
import org.commcare.data.xml.VirtualInstances;
import org.commcare.session.CommCareSession;
import org.commcare.session.SessionFrame;
import org.commcare.suite.model.*;
import org.commcare.util.CommCarePlatform;
import org.commcare.xml.SuiteParser;
import org.javarosa.core.model.Constants;
import org.javarosa.core.model.condition.EvaluationContext;
import org.javarosa.core.model.data.StringData;
import org.javarosa.core.model.instance.*;
import org.javarosa.xpath.XPathParseTool;
import org.javarosa.xpath.expr.FunctionUtils;
import org.junit.Test;
import static org.junit.Assert.*;

/** Native endpoint parsing, arguments, virtual selections and evaluated stack
 * state. This executes Core, not Formplayer's HTTP claim/replay lifecycle. */
public class EndpointRuntimeTest {
 private static final class Parser extends SuiteParser {
  Parser(InputStream in)throws IOException{super(in,null,"endpoint-proof",null,true,true,false);}
 }
 private Suite suite(String scenario,boolean hq)throws Exception{
  try(InputStream in=getClass().getResourceAsStream("/endpoint/endpoint-"+scenario+(hq?".hq-suite.xml":".suite.xml"))){assertNotNull(in);return new Parser(in).parse();}
 }
 private static final class Storage implements VirtualDataInstanceStorage {
  final Map<String,ExternalDataInstance> values=new HashMap<>();
  public String write(ExternalDataInstance instance){return write("native-selected-"+values.size(),instance);}
  public String write(String key,ExternalDataInstance instance){values.put(key,instance);return key;}
  public ExternalDataInstance read(String key,String instanceId,String refId){throw new AssertionError("No restoration requested by this proof");}
  public boolean contains(String key){return values.containsKey(key);}
 }
 @Test public void argumentsBuildNativeSelectionsAndNavigationFrames()throws Exception{
  for(boolean hq:new boolean[]{false,true})for(String scenario:new String[]{"single","multiple","inline","registration","registration-supplied","first-menu","child","module","case-list"}){
   Suite suite=suite(scenario,hq);Endpoint endpoint=suite.getEndpoint("visit");assertNotNull(endpoint);
   assertEquals(!scenario.startsWith("registration"),endpoint.isRespectRelevancy());
   CommCarePlatform platform=new CommCarePlatform(2,53,0);platform.registerSuite(suite);CommCareSession session=new CommCareSession(platform);
   HashMap<String,String> args=new HashMap<>();Hashtable<String,DataInstance> instances=new Hashtable<>();Storage storage=new Storage();
   for(EndpointArgument arg:endpoint.getArguments()){
    if(arg.isInstanceArgument()){
     assertEquals("jr://instance/selected-entities",arg.getInstanceSrc());
     var selected=VirtualInstances.storeSelectedValuesInInstance(storage,new String[]{"case-one","case-two"},arg.getInstanceId());
     assertTrue(storage.contains(selected.first));args.put(arg.getId(),selected.first);instances.put(arg.getInstanceId(),selected.second);
    }else args.put(arg.getId(),arg.getId().equals("parent_id")?"parent-one":"case-one");
   }
   if(scenario.equals("single")||scenario.equals("child")){
    // What a device holds once each claim has posted and synced: the session's data and the claimed cases, which
    // a claim's post reads when Back asks whether it is needed again.
    TreeElement data=new TreeElement("data"),cases=new TreeElement("casedb");
    for(var arg:args.entrySet()){
     TreeElement value=new TreeElement(arg.getKey());value.setValue(new StringData(arg.getValue()));data.addChild(value);
     TreeElement held=new TreeElement("case");held.setAttribute(null,"case_id",arg.getValue());cases.addChild(held);
    }
    TreeElement sessionRoot=new TreeElement("session");sessionRoot.addChild(data);
    instances.put("commcaresession",new FormInstance(sessionRoot,"commcaresession"));
    instances.put("casedb",new FormInstance(cases,"casedb"));
   }
   EvaluationContext context=new EvaluationContext(null,instances);Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,args,context);
   if(scenario.equals("multiple")){
    assertEquals("case-one",FunctionUtils.toString(XPathParseTool.parseXPath("instance('selected_cases')/results/value[1]").eval(context)));
    assertEquals("case-two",FunctionUtils.toString(XPathParseTool.parseXPath("instance('selected_cases')/results/value[2]").eval(context)));
   }
   // Each claim push leaves the session on its claim command; a real session posts it there and marks the step
   // posted (`SyncScreen.updateSessionOnSuccess`, `EXTRA_POST_SUCCESS`), so a later Back never asks for it again.
   int index=0;
   for(StackOperation operation:endpoint.getStackOperations()){
    session.executeStackOperations(new Vector<>(List.of(operation)),context);
    if(++index<endpoint.getStackOperations().size()){
     assertTrue(session.getCommand().startsWith("claim_command.visit."));
     session.addExtraToCurrentFrameStep(Constants.EXTRA_POST_SUCCESS,true);
    }
   }
   if(scenario.equals("registration-supplied")){
    assertEquals("a supplied creation is never claimed",1,endpoint.getStackOperations().size());
    assertEquals("case-one",session.getData().get("case_id_new_patient_0"));
   }
   String command=scenario.equals("child")?"m1-f0":scenario.equals("module")||scenario.equals("case-list")?"m0":"m0-f0";
   assertEquals(scenario+" hq="+hq,command,session.getCommand());
   if(scenario.equals("case-list"))assertEquals("case_id",session.getNeededDatum().getDataId());
   else {
    // Registration and this child's registration-root menu contribute computed
    // UUID datums. Native runtime fills them; endpoints only bind selections.
    int computed=0;
    while(session.getNeededDatum() instanceof ComputedDatum){
     String id=session.getNeededDatum().getDataId();session.setComputedDatum(context);computed++;
     assertTrue(session.getData().get(id).matches("[0-9a-f-]{36}"));
     if(computed>2)throw new AssertionError("Unexpected computed-datum cycle");
    }
    assertEquals(scenario+" hq="+hq,scenario.equals("registration")||scenario.equals("child")?1:0,computed);
    assertNull(scenario+" hq="+hq,session.getNeededDatum());
    for(var arg:args.entrySet())assertEquals(arg.getValue(),session.getData().get(arg.getKey()));
    if(scenario.equals("single")||scenario.equals("child")){
     // The menu's command follows the claim pushes, yet Back reaches the first menu with the first claimed case
     // still chosen: each posted claim needs nothing, and a later claim's case goes with its claim.
     int backs=0;
     while(session.getCommand()!=null){session.stepBack(context);if(++backs>6)throw new AssertionError(scenario+" never reached the first menu");}
     assertEquals(scenario+" hq="+hq,SessionFrame.STATE_COMMAND_ID,session.getNeededData(context));
     String first=scenario.equals("child")?"parent_id":"case_id";
     assertEquals(scenario+" hq="+hq,args.get(first),session.getData().get(first));
     if(scenario.equals("child"))assertNull(scenario+" hq="+hq,session.getData().get("case_id"));
    }
    if(scenario.equals("first-menu")){
     session.stepBack(context);
     assertNull("Back returns to the first menu",session.getCommand());
     assertEquals("case-one",session.getData().get("case_id"));
     session.setCommand("m1");
     assertEquals(SessionFrame.STATE_COMMAND_ID,session.getNeededData(context));
     session.setCommand("m1-f0");
     assertNull(session.getNeededDatum());
     assertEquals("case-one",session.getData().get("case_id"));
    }
   }
  }
 }
 @Test public void nativeArgumentBindingRejectsMissingAndUnexpectedKeys()throws Exception{
  for(boolean hq:new boolean[]{false,true}){
   Endpoint endpoint=suite("single",hq).getEndpoint("visit");EvaluationContext context=new EvaluationContext(null,new Hashtable<String,DataInstance>());
   var missing=assertThrows(Endpoint.InvalidEndpointArgumentsException.class,()->Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,new HashMap<String,String>(),context));
   assertEquals(List.of("case_id"),missing.getMissingArguments());assertFalse(missing.hasUnexpectedArguments());
   HashMap<String,String> extra=new HashMap<>();extra.put("case_id","case-one");extra.put("surprise","x");
   var unexpected=assertThrows(Endpoint.InvalidEndpointArgumentsException.class,()->Endpoint.populateEndpointArgumentsToEvaluationContext(endpoint,extra,context));
   assertEquals(List.of("surprise"),unexpected.getUnexpectedArguments());assertFalse(unexpected.hasMissingArguments());
  }
 }
}
