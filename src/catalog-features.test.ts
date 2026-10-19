import {expect,it} from 'vitest';
import {normalizeCloudTitles} from './catalog';
import {readMetadata,writeMetadata} from './catalog-cache';
const raw={results:[{titleId:'real',details:{productId:'9N2Z748SPMTM',hasEntitlement:true}}]};
it('audited DisplayCatalog category, gen9 and multiplayer names survive scoped cache',()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
 writeMetadata(storage,'a',{Products:[{ProductId:'9N2Z748SPMTM',Properties:{Category:'Action & adventure',XboxConsoleGenOptimized:['ConsoleGen9'],Attributes:[{Name:'XblOnlineMultiPlayer'}],token:'SECRET'}}]});
 const games=normalizeCloudTitles(raw,readMetadata(storage,'a'));
 expect(games[0].features).toMatchObject({series:true,action:true,multiplayer:true});expect(games[0].features?.controller).toBeUndefined();
 expect(JSON.stringify([...values])).not.toContain('SECRET');
});
it('unknown, compatibility-only and PC controller metadata cannot invent cloud features',()=>{
 const game=normalizeCloudTitles(raw,{Products:[{ProductId:'9N2Z748SPMTM',Properties:{XboxConsoleGenCompatible:['ConsoleGen9'],Attributes:[{Name:'PcGamePad'},{Name:'XblOnlineMultiPlayer',ApplicablePlatforms:['Desktop']}]}}]})[0];
 expect(game.features?.series).not.toBe(true);expect(game.features?.controller).not.toBe(true);expect(game.features?.multiplayer).not.toBe(true);expect(game.features?.action).not.toBe(true);
});
