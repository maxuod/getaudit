import {describe,it,expect,afterEach,vi} from 'vitest';
import {brandForProperty,preferredBrandProperty} from '../../apps/console/brand-property.ts';
const brands=[{id:'first',owned_domains:'["alpha.example"]'},{id:'second',owned_domains:'["client.example"]'},{id:'broken',owned_domains:'invalid'}];
afterEach(()=>vi.unstubAllGlobals());
describe('website project selection',()=>{
  it.each(['sc-domain:client.example','https://client.example/','https://www.client.example/articles/','https://CLIENT.example/'])('keeps the owning project for property %s',property=>{expect(brandForProperty(brands,property)?.id).toBe('second');});
  it.each(['https://client.example.attacker.test/','https://other.client.example/','javascript:alert(1)','not a property'])('does not cross project boundaries for %s',property=>{expect(brandForProperty(brands,property)).toBeUndefined();});
  it('opens an existing canonical domain when a legacy website starts with www',()=>{expect(preferredBrandProperty({id:'legacy',owned_domains:'["www.CLIENT.example","client.example"]'})).toBe('sc-domain:client.example');});
  it('restores the exact user-selected URL-prefix property for its owning project',()=>{vi.stubGlobal('localStorage',{getItem:()=> 'https://www.client.example/articles/'});expect(preferredBrandProperty(brands[1]!)).toBe('https://www.client.example/articles/');});
  it('ignores a stored property belonging to another project',()=>{vi.stubGlobal('localStorage',{getItem:()=> 'https://other.example/'});expect(preferredBrandProperty(brands[1]!)).toBe('sc-domain:client.example');});
});
