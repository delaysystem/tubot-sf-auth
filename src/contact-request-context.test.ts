import {expect,test} from 'bun:test';
import {invokeContactRequestContext} from './contact-request-context';
const user='005000000000001AAA',owned='09R000000000001AAA',root='/services/data/v67.0';
async function run(reject=false,missingTerminal=false,cleanupRejected=false) {
  let row:any;const calls:string[]=[];
  const request=async(path:string,method='GET',body?:any):Promise<any>=>{
    calls.push(method+' '+path.split('?')[0]);const reply=(status:number,body:any)=>({status,ok:status>=200&&status<300,body});
    if(path.endsWith('/composite/batch')){const results=[];for(const op of body.batchRequests){const value=await request('/services/data/'+op.url,op.method);results.push({statusCode:value.status,result:value.body});}return reply(200,{results});}
    if(path.endsWith('/actions/standard/contactRequestAction')&&method==='GET')return reply(200,{inputs:[{name:'RequestDescription',required:false},{name:'OwnerId',required:true},{name:'Status',required:true},{name:'PreferredChannel',required:true},{name:'RequestReason',required:true},{name:'PreferredPhone',required:true}]});
    if(path.endsWith('/describe'))return reply(200,{createable:true,queryable:true,deletable:true,fields:[{name:'RequestDescription',type:'textarea',createable:true},{name:'Status',type:'picklist',createable:true,picklistValues:missingTerminal?[]:[{active:true,value:'Abandoned'}]},...['PreferredChannel','RequestReason'].map(name=>({name,type:'picklist',createable:true,picklistValues:[{active:true,value:'actual-live-choice'}]})),{name:'PreferredPhone',type:'phone',createable:true}]});
    if(path.endsWith('/contactRequestAction')&&method==='POST'){if(reject)return reply(200,[{isSuccess:false,errors:[{message:'Real rejection'}]}]);row={...body.inputs[0],Id:owned};return reply(200,[{isSuccess:true,outputValues:{Id:owned}}]);}
    if(path.includes('/query?'))return reply(200,{records:row?[row]:[]});
    if(method==='DELETE'){if(cleanupRejected)return reply(403,{});row=undefined;return reply(204,null);}
    return row?reply(200,row):reply(404,{});
  };
  const result=await invokeContactRequestContext({root,route:root+'/actions/standard/contactRequestAction',userId:user,request});
  return {result,calls,row};
}
test('native contact request uses actual choices and verifies owned terminal record and deletion',async()=>{const {result,row}=await run();expect(result.contextSchema?.verified).toBe(true);expect(result.contextSchema?.expectedChanges).toEqual({Status:'Abandoned',OwnerId:user});expect(result.cleanupError).toBeUndefined();expect(row).toBeUndefined();});
test('missing live terminal status prevents native contact request mutation',async()=>{const {result,calls}=await run(false,true);expect(result.status).toBe(422);expect(calls.some(c=>c.startsWith('POST'))).toBe(false);});
test('HTTP200 business rejection remains rejected',async()=>{const {result}=await run(true);expect(result.body[0].isSuccess).toBe(false);expect(result.contextSchema?.verified).toBe(false);});
test('contact request cleanup rejection remains explicit',async()=>{const {result,row}=await run(false,false,true);expect(result.cleanupError).toContain('cleanup deletion');expect(row).toBeDefined();});
