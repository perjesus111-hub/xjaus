import {it,expect,vi,afterEach} from 'vitest';
import {createStreamTelemetry, telemetryDelta, ConnectionGrace} from './stream-telemetry';
afterEach(()=>vi.useRealTimers());
const report=(time:number,frames:number,bytes:number,decode:number,lost=0)=>new Map([['v',{id:'v',type:'inbound-rtp',kind:'video',timestamp:time,framesDecoded:frames,bytesReceived:bytes,totalDecodeTime:decode,packetsLost:lost,packetsReceived:100}],['t',{id:'t',type:'transport',selectedCandidatePairId:'p'}],['p',{id:'p',type:'candidate-pair',state:'succeeded',currentRoundTripTime:.02}]]) as unknown as RTCStatsReport;
it('computes deltas not cumulative averages and uses selected pair',()=>{
 const a=report(1000,10,1000000,.1),b=report(3000,130,3000000,.34,2);
 const stats=telemetryDelta(b,a);expect(stats).toMatchObject({fps:60,mbps:8,rttMs:20,lossPercent:100});expect(stats.decodeMs).toBeCloseTo(2);
 expect(telemetryDelta(b)).toEqual({fps:null,mbps:null,rttMs:20,lossPercent:null,decodeMs:null});
});
it('stats only poll visible; hiding/dispose invalidate late replies and timers',async()=>{
 vi.useFakeTimers();let resolve!:(r:RTCStatsReport)=>void;const getStats=vi.fn(()=>new Promise<RTCStatsReport>(r=>resolve=r)),render=vi.fn();const h=createStreamTelemetry({getStats},render);
 await vi.advanceTimersByTimeAsync(3000);expect(getStats).not.toHaveBeenCalled();h.setVisible(true);expect(getStats).toHaveBeenCalledOnce();h.setVisible(false);resolve(report(1000,1,1,1));await Promise.resolve();expect(render).not.toHaveBeenCalled();h.setVisible(true);h.dispose();resolve(report(2000,2,2,2));await vi.advanceTimersByTimeAsync(5000);expect(render).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('retains session 6s, recovers without teardown, and clears timers on dispose',()=>{
 vi.useFakeTimers();const end=vi.fn(),indicator=vi.fn(),g=new ConnectionGrace(end,indicator);g.update('disconnected','disconnected');vi.advanceTimersByTime(5999);expect(end).not.toHaveBeenCalled();g.update('connected','completed');vi.advanceTimersByTime(6000);expect(end).not.toHaveBeenCalled();expect(indicator).toHaveBeenLastCalledWith(false);g.update('disconnected','disconnected');vi.advanceTimersByTime(6000);expect(end).toHaveBeenCalledOnce();g.dispose();expect(vi.getTimerCount()).toBe(0);
});
