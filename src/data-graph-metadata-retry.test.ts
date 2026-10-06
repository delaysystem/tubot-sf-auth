import { expect, test } from 'bun:test';
import { readOwnedGraphMetadata } from './data-graph-metadata-retry';
test('owned graph metadata retries a missing definition until its real read succeeds', async () => {
  let calls = 0, waits = 0;
  const result = await readOwnedGraphMetadata({invoke:async()=>++calls===1?{status:400,ok:false,body:[{errors:[{message:'DataGraph not found with definition ID owned'}]}]}:{status:200,ok:true,body:[{isSuccess:true,outputValues:{dataGraphMetadata:'real'}}]},wait:async ms=>{expect(ms).toBe(2000);waits++;}});
  expect(result.status).toBe(200);expect(calls).toBe(2);expect(waits).toBe(1);
});
test('owned graph metadata does not retry access denial or ordinary failures', async()=>{
  let calls=0;
  const result=await readOwnedGraphMetadata({invoke:async()=>{calls++;return {status:403,ok:false,body:{message:'Access denied'}};},wait:async()=>{throw Error('Unauthorized retries');}});
  expect(result.status).toBe(403);expect(calls).toBe(1);
});
test('owned graph metadata stops after bounded real definition reads',async()=>{
  let calls=0,waits=0;
  const result=await readOwnedGraphMetadata({invoke:async()=>{calls++;return {status:400,ok:false,body:{message:'DataGraph not found with definition ID owned'}};},wait:async()=>{waits++;}});
  expect(result.status).toBe(400);expect(calls).toBe(10);expect(waits).toBe(9);
});
test('missing owned draft definition activates once before retrying its metadata read',async()=>{
  let calls=0,activations=0;
  const result=await readOwnedGraphMetadata({invoke:async()=>++calls===1?{status:400,ok:false,body:{message:'DataGraph not found with definition ID owned'}}:{status:200,ok:true,body:[{isSuccess:true}]},activate:async()=>{activations++;return {status:200,ok:true,body:{success:true}};},wait:async()=>{}});
  expect(result.status).toBe(200);expect(activations).toBe(1);expect(calls).toBe(2);
});
test('rejected graph activation preserves the upstream failure and stops reads',async()=>{
  let calls=0;
  const result=await readOwnedGraphMetadata({invoke:async()=>{calls++;return {status:400,ok:false,body:{message:'DataGraph not found with definition ID owned'}};},activate:async()=>({status:403,ok:false,body:{message:'Access denied'}}),wait:async()=>{throw Error('Rejected activation retry');}});
  expect(result.status).toBe(403);expect(calls).toBe(1);
});
