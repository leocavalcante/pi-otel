import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createPiOtel } from '../src/index.ts';
import { receiver, spans, metrics } from './receiver.ts';

test('SDK ModelRuntime preserves its auth/forwarding path and exports each model request exactly once', async () => {
  const sink=await receiver(); const directory=await mkdtemp(join(tmpdir(),'pi-otel-runtime-'));
  const runtime=await ModelRuntime.create({authPath:join(directory,'auth.json'),modelsPath:null,modelsStorePath:join(directory,'models.json'),refreshOnCreate:false,allowModelNetwork:false});
  const faux=fauxProvider({tokensPerSecond:100000});runtime.registerNativeProvider(faux.provider);
  const PRIVATE='SYNTHETIC_PRIVATE_MODEL_RUNTIME_CONTENT';
  faux.setResponses([fauxAssistantMessage(fauxToolCall('example_tool',{text:PRIVATE}),{stopReason:'toolUse'}),fauxAssistantMessage(PRIVATE)]);
  const registry=createRegistry();registry.install(defineExtension({name:'fixture',tools:[defineTool({name:'example_tool',description:'Synthetic fixture',parameters:{type:'object',properties:{text:{type:'string'}}},async execute(){return {output:[{type:'text',text:PRIVATE}]}}})]}));
  const otel=createPiOtel({endpoint:sink.endpoint});
  const models=otel.modelRuntime(runtime);
  const context=BACKGROUND_CONTEXT;
  const harness=await Harness.open(new MemoryStorage(),{models,registry,telemetry:otel.telemetry,settings:{compaction:{enabled:false},retry:{maxRetries:0}}},context);
  try{
    const model=faux.getModel(); const root=await harness.root(context,{agent:{model:{provider:model.provider,modelId:model.id}}});
    assert.equal((await(await root.submit({type:'input',content:[{type:'text',text:PRIVATE}]},context)).wait(context)).status,'done');
    assert.equal(faux.state.callCount,2);assert(await otel.forceFlush());
    assert.equal(spans(sink.requests).filter(span=>span.name==='pi.ai.request').length,2);
    const durations=metrics(sink.requests).find(metric=>metric.name==='pi.ai.request.duration');
    assert(durations);assert.equal(durations.histogram.dataPoints.reduce((sum:number,point:any)=>sum+Number(point.count),0),2);
    assert(metrics(sink.requests).some(metric=>metric.name==='pi.ai.first_chunk.duration'));
    assert(!JSON.stringify(sink.requests).includes(PRIVATE));
  }finally{await harness.close(context);await otel.shutdown();await sink.close();await rm(directory,{recursive:true});}
});
