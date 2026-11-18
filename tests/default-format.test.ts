import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberOutputFormat, savedOutputFormat, setDefaultOutputFormat } from '../src/default-format.ts';
test('existing settings migrate to MP3 once and later choices are respected', () => {
 const data = new Map<string,string>([['shiyin-format','m4a']]);
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,val:string)=>data.set(key,val)}});
 try {
   assert.equal(savedOutputFormat(), 'mp3');
   rememberOutputFormat('original');
   assert.equal(savedOutputFormat(), 'original');
   setDefaultOutputFormat('m4a');
   rememberOutputFormat('mp3');
   assert.equal(savedOutputFormat(), 'm4a');
 }
 finally { delete (globalThis as any).localStorage; }
});
