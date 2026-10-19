import {it,expect,vi} from 'vitest';
import {initializeXboxChannels} from './webrtc';
it('accepts only the audited serverInitiatedDisconnect envelope, acknowledges then ends once',()=>{
 const channels:any=Object.fromEntries(['input','control','message','chat'].map(name=>[name,Object.assign(new EventTarget(),{readyState:'open',send:vi.fn()})]));
 const ended=vi.fn();const cleanup=initializeXboxChannels(channels,()=>{},ended);
 const send=(value:unknown)=>channels.message.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));
 for(const value of [null,[],{type:'TitleExited'},{type:'SessionTerminated'},{message:'StopStream'},{type:'TransactionStart',target:'/unrelated',id:'x'},{type:'Handshake',target:'/streaming/sessionLifetimeManagement/serverInitiatedDisconnect',id:'x'}])send(value);
 channels.message.dispatchEvent(new Event('close'));expect(ended).not.toHaveBeenCalled();
 send({type:'TransactionStart',target:'/streaming/sessionLifetimeManagement/serverInitiatedDisconnect',id:'server-id',content:'{}'});
 expect(channels.message.send).toHaveBeenLastCalledWith(JSON.stringify({type:'TransactionComplete',content:JSON.stringify(''),id:'server-id',cv:''}));expect(ended).toHaveBeenCalledOnce();
 send({type:'Message',target:'/streaming/sessionLifetimeManagement/serverInitiatedDisconnect',id:'server-id'});expect(ended).toHaveBeenCalledOnce();
 cleanup();send({type:'TransactionStart',target:'/streaming/sessionLifetimeManagement/serverInitiatedDisconnect',id:'late'});expect(ended).toHaveBeenCalledOnce();
});
