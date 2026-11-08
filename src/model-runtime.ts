import { lazyStream, AI_TELEMETRY_SCHEMA, type Models, type Model, type Api, type LazyStreamObserver } from '@earendil-works/pi-ai';
import { createTypedMetrics, NOOP_TELEMETRY_METRICS, type TelemetryContext, type TelemetrySpan } from '@earendil-works/pi-telemetry';

/** Pi 1.5.0 ModelRuntime dispatches directly to providers, bypassing Models' native AI observer. */
function observer(model: Model<Api>, context: TelemetryContext, reasoning: unknown, poll: boolean): LazyStreamObserver {
  const started=performance.now();
  const labels={provider:model.provider,model:model.id};
  const metrics=createTypedMetrics(context.metrics??NOOP_TELEMETRY_METRICS,[AI_TELEMETRY_SCHEMA]);
  const duration=metrics.histogram('pi.ai.request.duration');
  const firstDuration=metrics.histogram('pi.ai.first_chunk.duration');
  const tokens=metrics.counter('pi.ai.tokens');
  const cost=metrics.counter('pi.ai.cost');
  let span: TelemetrySpan|undefined; let finish!:()=>void; let first=true;
  const completed=new Promise<void>(resolve=>{finish=resolve;});
  const toolChars=new Map<number,number>();
  try {
    void context.startSpan({name:poll?'pi.ai.poll':'pi.ai.request',attributes:{...labels,api:model.api,
      ...(typeof reasoning==='string'?{reasoning}:{})}},active=>{span=active;return completed;}).catch(()=>{});
  } catch { /* Recording must not prevent request admission. */ }
  return {
    onEvent(event) {
      try {
        if(first){first=false;span?.addEvent('pi.ai.first_chunk');firstDuration.record(performance.now()-started,labels,span);}
        if(event.type==='toolcall_delta')toolChars.set(event.contentIndex,(toolChars.get(event.contentIndex)??0)+event.delta.length);
        else if(event.type==='text_end'||event.type==='thinking_end')span?.addEvent('pi.ai.block',{
          type:event.type==='text_end'?'text':'thinking',index:event.contentIndex,chars:event.content.length});
        else if(event.type==='toolcall_end'){
          span?.addEvent('pi.ai.block',{type:'tool_call',index:event.contentIndex,chars:toolChars.get(event.contentIndex)??0,tool:event.toolCall.name});
          toolChars.delete(event.contentIndex);
        }
      } catch { /* Native lazyStream observers must never throw into forwarding. */ }
    },
    onResult(message) {
      try {
        if(!message)return;
        span?.setAttributes({stop:message.stopReason,'usage.input':message.usage.input,'usage.output':message.usage.output,
          'usage.cache_read':message.usage.cacheRead,'usage.cache_write':message.usage.cacheWrite,'cost.total':message.usage.cost.total});
        if(message.stopReason==='error')span?.setStatus({status:'error',error:{name:'provider_error',message:''}});
        duration.record(performance.now()-started,{...labels,stop:message.stopReason},span);
        if(!poll||(message.stopReason!=='pending'&&message.stopReason!=='deferred')){
          for(const [kind,key] of [['input','input'],['output','output'],['cache_read','cacheRead'],['cache_write','cacheWrite']] as const)
            tokens.add(message.usage[key],{...labels,kind});
          cost.add(message.usage.cost.total,labels);
        }
      } catch { /* Usage observation is not the durable accounting ledger. */ }
      finally {toolChars.clear();finish();}
    },
  };
}

/**
 * Explicit compatibility opt-in for SDK ModelRuntime 1.5.0 only.
 * All auth/catalog/configuration and request arguments remain with that same runtime.
 * Do not wrap createModels(), which already emits native request telemetry.
 */
export function withModelRuntimeTelemetry<T extends Models>(runtime:T,telemetry:TelemetryContext):T {
  const methods=new Map<PropertyKey,unknown>();
  for(const name of ['stream','streamSimple','streamDeferred'] as const){
    methods.set(name,(...args:Parameters<Models['streamSimple']>)=>{
      const model=args[0]; const options=args[2];
      // Lazy forwarding preserves the original events/result and makes exactly one underlying call.
      let observation: LazyStreamObserver|undefined;
      try { observation=observer(model,options?.telemetry??telemetry,options&&'reasoning' in options?options.reasoning:undefined,name==='streamDeferred'); } catch {}
      return lazyStream(model,async()=>Reflect.apply(runtime[name],runtime,args),observation);
    });
  }
  for(const [complete,stream] of [['complete','stream'],['completeSimple','streamSimple'],['fetchDeferred','streamDeferred']] as const){
    methods.set(complete,(...args:unknown[])=>Reflect.apply(methods.get(stream) as Function,undefined,args).result());
  }
  return new Proxy(runtime,{get(target,key){
    if(methods.has(key))return methods.get(key);
    const value=Reflect.get(target,key,target);
    if(typeof value!=='function'||key==='constructor')return value;
    const bound=value.bind(target);methods.set(key,bound);return bound;
  }});
}
