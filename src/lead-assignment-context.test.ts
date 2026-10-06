import { test,expect } from 'bun:test';
import { invokeLeadAssignmentContext } from './lead-assignment-context';
test('Lead assignment success requires actual changed ownership and cleanup',async()=>{
 for(const mutate of [true,false]){
  let stored:any, deleted=false;
  const root='/services/data/v67.0',route=root+'/actions/standard/invocableApplyLeadAssignmentRules';
  const original='005000000000001AAA',assigned='005000000000002AAA',lead='00Q000000000001AAA';
  const request=async(path:string,method='GET',body?:any):Promise<any>=>{
   const result=(body:any,status=200)=>({status,ok:status<400,body});
  if(path.endsWith('/composite/batch')){const results=[];for(const op of body.batchRequests){const value=await request('/services/data/'+op.url,op.method);results.push({statusCode:value.status,result:value.body});}return result({results});}
  if(path.endsWith('/describe'))return result({createable:true,deletable:true,queryable:true,fields:[{name:'LastName',createable:true,filterable:true,type:'string',length:80,nillable:false},{name:'OwnerId',updateable:true}]});
   if(path===route&&method==='GET')return result({inputs:[{name:'leadId',type:'ID',required:true}]});
   if(path===route){if(mutate)stored.OwnerId=assigned;return result([{isSuccess:true,errors:[],outputValues:{}}]);}
   if(path.includes('/query?'))return result({records:decodeURIComponent(path).includes('AssignmentRule')?[{Id:'01Q000000000001AAA'}]:stored?[{Id:lead}]:[]});
   if(method==='POST'){expect(body.OwnerId).toBeUndefined();stored={...body,Id:lead,OwnerId:original};return result({id:lead},201);}
   if(method==='DELETE'){stored=undefined;deleted=true;return result(null,204);}
   return stored?result({...stored}):result(null,404);
  };
  const result=await invokeLeadAssignmentContext({root,route,request,build:async(_name,_marker,values)=>({values:{...values,OwnerId:original}})});
  expect(result.contextSchema?.verified).toBe(mutate);
  expect(result.status).toBe(mutate?200:422);
  expect(deleted).toBe(true);
  expect(result.cleanupError).toBeUndefined();
 }
});
test('assignment can retain the owner only when the action actually updates the record',async()=>{
 let stored:any;
 const root='/services/data/v67.0',route=root+'/actions/standard/invocableApplyLeadAssignmentRules',actor='005000000000001AAA',lead='00Q000000000001AAA';
 const request=async(path:string,method='GET',body?:any):Promise<any>=>{
  const result=(body:any,status=200)=>({status,ok:status<400,body});
  if(path.endsWith('/composite/batch')){const results=[];for(const op of body.batchRequests){const value=await request('/services/data/'+op.url,op.method);results.push({statusCode:value.status,result:value.body});}return result({results});}
  if(path.endsWith('/describe'))return result({createable:true,deletable:true,queryable:true,fields:[{name:'LastName',createable:true,filterable:true,type:'string',length:80,nillable:false},{name:'OwnerId',updateable:true}]});
  if(path===route&&method==='GET')return result({inputs:[{name:'leadId',type:'ID',required:true}]});
  if(path===route){stored.LastModifiedDate='2026-10-01T01:00:02.000Z';return result([{isSuccess:true,errors:[],outputValues:{}}]);}
  if(path.includes('/query?'))return result({records:decodeURIComponent(path).includes('AssignmentRule')?[{Id:'01Q000000000001AAA'}]:stored?[{Id:lead}]:[]});
  if(method==='POST'){stored={...body,Id:lead,OwnerId:actor,CreatedById:actor,LastModifiedById:actor,LastModifiedDate:'2026-10-01T01:00:00.000Z'};return result({id:lead},201);}
  if(method==='DELETE'){stored=undefined;return result(null,204);}
  return stored?result({...stored}):result(null,404);
 };
 const result=await invokeLeadAssignmentContext({root,route,request,build:async(_name,_marker,values)=>({values})});
 expect(result.contextSchema?.verified).toBe(true);
 expect(result.contextSchema?.beforeOwnerId).toBe(result.contextSchema?.afterOwnerId);
 expect(result.contextSchema?.beforeModifiedAt).not.toBe(result.contextSchema?.afterModifiedAt);
 expect(result.cleanupError).toBeUndefined();
});
test('zero active rules verifies the native no-op success (platform truth)',async()=>{
 let stored:any, deleted=false;
 const root='/services/data/v67.0',route=root+'/actions/standard/invocableApplyLeadAssignmentRules';
 const actor='005000000000001AAA',lead='00Q000000000001AAA';
 const request=async(path:string,method='GET',body?:any):Promise<any>=>{
  const result=(body:any,status=200)=>({status,ok:status<400,body});
  if(path.endsWith('/composite/batch')){const results=[];for(const op of body.batchRequests){const value=await request('/services/data/'+op.url,op.method);results.push({statusCode:value.status,result:value.body});}return result({results});}
  if(path.endsWith('/describe'))return result({createable:true,deletable:true,queryable:true,fields:[{name:'LastName',createable:true,filterable:true,type:'string',length:80,nillable:false},{name:'OwnerId',updateable:true}]});
  if(path===route&&method==='GET')return result({inputs:[{name:'leadId',type:'ID',required:true}]});
  if(path===route)return result([{isSuccess:true,errors:[],outputValues:{}}]);
  if(path.includes('/query?'))return result({records:decodeURIComponent(path).includes('AssignmentRule')?[]:stored?[{Id:lead}]:[]});
  if(method==='POST'){stored={...body,Id:lead,OwnerId:actor};return result({id:lead},201);}
  if(method==='DELETE'){stored=undefined;deleted=true;return result(null,204);}
  return stored?result({...stored}):result(null,404);
 };
 const result=await invokeLeadAssignmentContext({root,route,request,build:async(_name,_marker,values)=>({values})});
 expect(result.status).toBe(200);
 expect(result.contextSchema?.verified).toBe(true);
 expect(deleted).toBe(true);
 expect(result.cleanupError).toBeUndefined();
});
test('more than one active rule refuses without invoking',async()=>{
 const root='/services/data/v67.0',route=root+'/actions/standard/invocableApplyLeadAssignmentRules';
 let posted=false;
 const request=async(path:string,method='GET',body?:any):Promise<any>=>{
  const result=(body:any,status=200)=>({status,ok:status<400,body});
  if(path.endsWith('/describe'))return result({createable:true,deletable:true,queryable:true,fields:[{name:'LastName',createable:true,filterable:true,type:'string',length:80,nillable:false},{name:'OwnerId',updateable:true}]});
  if(path===route&&method==='GET')return result({inputs:[{name:'leadId',type:'ID',required:true}]});
  if(path===route){posted=true;return result([{isSuccess:true,errors:[],outputValues:{}}]);}
  if(path.includes('/query?'))return result({records:decodeURIComponent(path).includes('AssignmentRule')?[{Id:'01Q000000000001AAA'},{Id:'01Q000000000002AAA'}]:[]});
  return result(null,404);
 };
 const result=await invokeLeadAssignmentContext({root,route,request,build:async(_name,_marker,values)=>({values})});
 expect(result.status).toBe(422);
 expect((result.body as any).errorCode).toBe('LEAD_ASSIGNMENT_RULE_REQUIRED');
 expect(posted).toBe(false);
});
