import {it,expect} from 'vitest';
import source from './main.ts?raw';
import html from '../index.html?raw';
it('wires a durable manual language selector independently of stream settings',()=>{expect(html).toContain('id="app-language"');expect(source).toContain("i18n.setPreference");expect(source).toContain('languageControl.value = i18n.preference');});
it('uses live localized callbacks for shared buttons and filters',()=>{expect(source).toContain('function cardButton(label: () => string');expect(source).toContain('cardButton(() => t(\'play\')');expect(source).toContain('bindText(button,label)');expect(source).toContain('bindText(pill,()=>t(value))');});
