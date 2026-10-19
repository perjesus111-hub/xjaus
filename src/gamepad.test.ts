import { expect, it } from 'vitest';
import { serializeGamepads, parseRumble } from './gamepad';

it('serializes the audited 14-byte header and 23-byte standard gamepad frame', () => {
  const pad = { index: 1, axes: [1, -1, .5, -.5], buttons: Array.from({length:17}, (_,i)=>({value:[0,6,7].includes(i)?1:0})) } as unknown as Gamepad;
  const packet = new DataView(serializeGamepads([pad], 42, 123.5));
  expect(packet.byteLength).toBe(38);
  expect(packet.getUint16(0,true)).toBe(2);
  expect(packet.getUint32(2,true)).toBe(42);
  expect(packet.getFloat64(6,true)).toBe(123.5);
  expect(packet.getUint8(14)).toBe(1);
  expect(packet.getUint8(15)).toBe(1);
  expect(packet.getUint16(16,true)).toBe(16); // A is 16, NOT XInput bit 4096.
  expect([18,20,22,24].map(i=>packet.getInt16(i,true))).toEqual([32767,32767,16383,16383]);
  expect(packet.getUint16(26,true)).toBe(65535);
  expect(packet.getUint16(28,true)).toBe(65535);
  expect([...new Uint8Array(packet.buffer).slice(30)]).toEqual(Array(8).fill(0));
});
it('bounds axes/triggers and wraps sequence exactly as uint32', () => {
  const pad = {index:0,axes:[-2,2,NaN,0],buttons:[]} as unknown as Gamepad;
  const v=new DataView(serializeGamepads([pad], 0x100000000, 0));
  expect(v.getUint32(2,true)).toBe(0);
  expect(v.getInt16(18,true)).toBe(-32767);
  expect(v.getInt16(20,true)).toBe(-32767);
  expect(v.getInt16(22,true)).toBe(0);
});
it('parses binary four-motor rumble and rejects truncated/unrelated packets', () => {
  const b=new Uint8Array([128,0,0,1,100,50,25,75,232,3,20,0,2]);
  expect(parseRumble(b.buffer)).toEqual({index:1,strongMagnitude:1,weakMagnitude:.5,leftTrigger:.25,rightTrigger:.75,duration:1000,delay:20,repeat:2});
  expect(parseRumble(b.slice(0,12).buffer)).toBeNull();
  b[1]=1; expect(parseRumble(b.buffer)?.index).toBe(1); // Reference skips reserved byte 1.
  b[0]=2; expect(parseRumble(b.buffer)).toBeNull();
});
