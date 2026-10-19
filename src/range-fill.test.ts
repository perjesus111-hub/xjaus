// @vitest-environment happy-dom
import {expect,it} from 'vitest';
import {syncRangeFill} from './range-fill';
it('15/30/45 Mbps keep fill at the 18px thumb center and preserve kbps storage',()=>{
 const input=document.createElement('input');input.type='range';input.min='15000';input.max='45000';input.step='1000';
 for(const [value,fill] of [[15000,'calc(0% + 9px)'],[30000,'calc(50% + 0px)'],[45000,'calc(100% + -9px)']] as const){
  input.value=String(value);syncRangeFill(input);expect(input.style.getPropertyValue('--range-fill')).toBe(fill);expect(input.value).toBe(String(value));
 }
});
