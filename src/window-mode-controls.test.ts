// @vitest-environment happy-dom
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {bindWindowModeControls} from './window-mode-controls';

describe('bindWindowModeControls',()=>{
 beforeEach(()=>document.body.innerHTML='<button id="window-mode-main" data-window-mode-toggle></button><button id="window-mode-stream" data-window-mode-toggle></button>');
 it('toggles the native window mode from both visible controls and F11 without consuming Escape',()=>{
  const toggle=vi.fn();
  const dispose=bindWindowModeControls(document,toggle);
  document.querySelector<HTMLButtonElement>('#window-mode-main')!.click();
  document.querySelector<HTMLButtonElement>('#window-mode-stream')!.click();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'F11',bubbles:true}));
  const escape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
  window.dispatchEvent(escape);
  expect(toggle).toHaveBeenCalledTimes(3);
  expect(escape.defaultPrevented).toBe(false);
  dispose();
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'F11',bubbles:true}));
  expect(toggle).toHaveBeenCalledTimes(3);
 });
 it('does not toggle for Ctrl+F11, repeats, or already-handled F11',()=>{
  const toggle=vi.fn();
  bindWindowModeControls(document,toggle);
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'F11',ctrlKey:true,bubbles:true}));
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'F11',repeat:true,bubbles:true}));
  const event=new KeyboardEvent('keydown',{key:'F11',bubbles:true,cancelable:true});event.preventDefault();window.dispatchEvent(event);
  expect(toggle).not.toHaveBeenCalled();
 });
});
