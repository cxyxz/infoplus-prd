import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from '../src/cli.mjs';
test('空资料不能宣称采集成功',()=>{const r=inspect({});assert.equal(r.structuralChecksPassed,false);assert.equal(r.status,'unverified');});
test('识别悬空连线与重复节点',()=>{const r=inspect({workflow:{nodes:[{id:'a'},{id:'a'}],transitions:[{source:'a',target:'b'}]}});assert.ok(r.missing.some(x=>x.includes('重复')));assert.ok(r.missing.some(x=>x.includes('悬空')));});
test('未知视图总数不能当成零视图成功',()=>{assert.ok(inspect({views:[]}).missing.includes('视图总数未验证'));});
