import { test,expect } from 'bun:test';
import { invokeCustomFieldActionContext,xmlText } from './custom-field-action-context';
const root='/services/data/v67.0',route=root+'/actions/standard/createCustomField';
test('native custom-field probes verify actual metadata and authenticated deletion',async()=>{
 for(const ns of ['','fixture_ns']) {
 let stored:any,created=false,deleted=false;
 const request=async(path:string,method='GET',body?:any)=>{
  const result=(body:any,status=200)=>({status,ok:status<400,body});
  if(path===route&&method==='GET')return result({inputs:['Datatype','Entity','Label','Name'].map(name=>({name,type:'STRING'}))});
  if(path.endsWith('/describe'))return result({queryable:true,fields:[{name:'TableEnumOrId',picklistValues:[{active:true,value:'Account'}]}]});
  if(path.includes('/query?'))return result({records:stored?[{Id:stored.Id,DeveloperName:stored.DeveloperName}]:[]});
  if(path===route){const v=body.inputs[0];expect(v.Name.length).toBeLessThan(40);expect(v.Label.length).toBeLessThan(40);stored={Id:'00N000000000001AAA',DeveloperName:v.Name,NamespacePrefix:ns||null,FullName:v.Entity+'.'+(ns?ns+'__':'')+v.Name+'__c',Metadata:{label:v.Label,type:v.Datatype,length:v.Length}};created=true;return result([{isSuccess:true,errors:[],outputValues:{Id:stored.Id}}]);}
  return result(stored);
 };
 const removed:string[]=[];
 const result=await invokeCustomFieldActionContext({root,route,target:'Account',request,remove:async fullName=>{removed.push(fullName);if(!stored)return {status:200,ok:false,missing:true};expect(fullName).toBe(stored.FullName);stored=undefined;deleted=true;return {status:200,ok:true,missing:false};}});
 expect(created).toBe(true);expect(deleted).toBe(true);expect(result.contextSchema?.verified).toBe(true);expect(result.cleanupError).toBeUndefined();expect(removed.length).toBe(2);
 }
});
test('custom fields are not created when metadata cleanup authorization is absent',async()=>{
 let posts=0;
 const request=async(path:string,method='GET')=>{if(method==='POST')posts++;return {status:200,ok:true,body:path===route?{inputs:['Datatype','Entity','Label','Name'].map(name=>({name,type:'STRING'}))}:path.endsWith('/describe')?{queryable:true,fields:[{name:'TableEnumOrId',picklistValues:[{active:true,value:'Account'}]}]}:{records:[]}};};
 const result=await invokeCustomFieldActionContext({root,route,target:'Account',request,remove:async()=>({status:403,ok:false,missing:false})});
 expect(result.status).toBe(403);expect(posts).toBe(0);
 expect(xmlText('<&"')).toBe('&lt;&amp;&quot;');
});
