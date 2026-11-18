import test from 'node:test'; import assert from 'node:assert/strict';
import type {Job} from '../shared/types.ts';
import {organizeLibrary,validGroupName} from '../server/library-organize.ts';
import {filterLibrary,emptyLibraryFilters} from '../shared/library-filters.ts';
const make=(id:string, extra:Partial<Job>={}):Job=>({id,title:id,artist:'歌手',platform:'local',status:'completed',progress:100,message:'',format:'mp3',createdAt:'2026-11-17T00:00:00Z',completeness:'full',fileExists:true,...extra});
test('favorites and group updates are atomic, normalized and never alter source objects',()=>{
 const a=make('a',{groups:['通勤'],favorite:true}), b=make('b'), c=make('c',{status:'processing'});const jobs=new Map([[a.id,a],[b.id,b],[c.id,c]]);
 const added=organizeLibrary(['a','b'],'add-group',' 通勤 ',jobs);
 assert.deepEqual(added.map(j=>j.groups),[['通勤'],['通勤']]); assert.equal(b.groups,undefined);
 const favorited=organizeLibrary(['b'],'favorite',true,jobs);assert.equal(favorited[0].favorite,true);assert.equal(b.favorite,undefined);
 assert.throws(()=>organizeLibrary(['a','c'],'add-group','待剪辑',jobs),/不可用/);assert.deepEqual(a.groups,['通勤']);
 assert.throws(()=>organizeLibrary(['a','a'],'favorite',true,jobs),/不得重复/);
 assert.throws(()=>validGroupName('a\nb'),/不能包含换行/);assert.throws(()=>validGroupName('x'.repeat(31)),/30/);
 const removed=organizeLibrary(['a'],'remove-group','通勤',jobs);assert.deepEqual(removed[0].groups,[]);
});
test('group and favorite filters combine with existing file status and search',()=>{
 const items=[make('x',{favorite:true,groups:['通勤'],fileExists:true}),make('y',{favorite:true,groups:['待剪辑'],fileExists:false}),make('z',{groups:['通勤']})];
 assert.deepEqual(filterLibrary(items,{...emptyLibraryFilters,favoriteOnly:true,group:'通勤'}).map(j=>j.id),['x']);
 assert.deepEqual(filterLibrary(items,{...emptyLibraryFilters,favoriteOnly:true,file:'missing'}).map(j=>j.id),['y']);
 assert.equal(filterLibrary(items,{...emptyLibraryFilters,group:'通勤',query:'不存在'}).length,0);
});
test('group names are case insensitive and per-item group limits cannot partially apply',()=>{
 const full=make('full',{groups:Array.from({length:20},(_,i)=>`group${i}`)}),empty=make('empty');const jobs=new Map([[full.id,full],[empty.id,empty]]);
 assert.throws(()=>organizeLibrary(['empty','full'],'add-group','新增',jobs),/最多加入/);assert.equal(empty.groups,undefined);
 assert.deepEqual(organizeLibrary(['full'],'add-group','GROUP1',jobs)[0].groups,full.groups);
});
