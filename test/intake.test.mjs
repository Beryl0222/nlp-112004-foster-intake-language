import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildIdentityIndex, findMentions, resolveCandidates } from '../src/identity.mjs';
import { effectiveClaims, interpretMessage, interpretMessages } from '../src/intake.mjs';

const bundle = readBundle();
const index = buildIdentityIndex(bundle.animals);
const interpreted = interpretMessages(bundle.messages, index, bundle.locations);
const byId = new Map(interpreted.map(entry => [entry.message.id, entry]));

test('同名不同只：称呼只产生候选，芯片与外貌才是强证据', () => {
  const mentions = findMentions('竹桥那只叫糖糖的，鼻口是白的', index);
  const tang = mentions.names.find(name => name.term === '糖糖');
  assert.deepEqual(tang.ids.sort(), ['A1', 'A2'], '糖糖必须同时候选两只');
  const resolved = resolveCandidates(tang.ids, mentions, index);
  assert.deepEqual(resolved.candidates, ['A2']);
  assert.ok(resolved.matchedBy.includes('外貌'));
  assert.ok(resolved.confident);
});

test('临时名撞名：麦米同时是 A4 的名和 A5 的别名，单称呼不定身份', () => {
  const mentions = findMentions('麦米今天吃得很好', index);
  const resolved = resolveCandidates(mentions.names[0].ids, mentions, index);
  assert.deepEqual(resolved.candidates.sort(), ['A4', 'A5']);
  assert.equal(resolved.confident, false);
});

test('m1 亲见两只上车，m4 更正后白背的转运被覆盖、花脸的保留', () => {
  const m1 = byId.get('m1');
  const boarded = m1.claims.filter(claim => claim.stage === '转运');
  assert.equal(boarded.length, 2);
  const huabei = boarded.find(claim => claim.subject.candidates.includes('A3'));
  const hualian = boarded.find(claim => claim.subject.candidates.includes('A1'));
  assert.equal(huabei.status, '被更正');
  assert.equal(huabei.supersededBy, 'm4');
  assert.equal(hualian.status, '有效', 'm4 同样肯定花脸上车，不算更正');
  const m4 = byId.get('m4');
  const denied = m4.claims.find(claim => claim.stage === '转运' && claim.negated);
  assert.deepEqual(denied.subject.candidates, ['A3']);
  assert.equal(denied.scope, '亲见');
});

test('m2 转述部分只配待核，亲见部分按同句地点收窄', () => {
  const m2 = byId.get('m2');
  const relay = m2.claims.filter(claim => claim.scope === '转述');
  assert.ok(relay.length > 0);
  assert.ok(relay.every(claim => claim.status === '待核'));
  const relayTang = relay.find(claim => claim.subject.term === '小糖');
  assert.deepEqual(relayTang.subject.candidates.sort(), ['A1', 'A2'], '转述里的称呼不跨句借地点收窄');
  const seen = m2.claims.find(claim => claim.scope === '亲见' && claim.subject.term === '小糖');
  assert.deepEqual(seen.subject.candidates, ['A2']);
  assert.equal(seen.eventDate, '2026-11-18', '昨晚按留言时间回推');
});

test('m3 原主当事人陈述：竹桥糖糖是 A2，今天接回', () => {
  const m3 = byId.get('m3');
  const ownership = m3.claims.find(claim => claim.stage === '归属');
  assert.equal(ownership.scope, '当事人');
  assert.deepEqual(ownership.subject.candidates, ['A2']);
  const reclaim = m3.claims.find(claim => claim.stage === '领回');
  assert.equal(reclaim.eventDate, '2026-11-19');
  assert.equal(reclaim.negated, false);
});

test('m6 站医核验以芯片定个体，m7 的拒绝只针对 CH-913', () => {
  const m6 = byId.get('m6');
  assert.ok(m6.claims.every(claim => claim.scope === '核验'));
  assert.ok(m6.claims.some(claim => claim.subject.matchedBy.includes('芯片') &&
    claim.subject.candidates.includes('A1')));
  const m7 = byId.get('m7');
  const denial = m7.claims.find(claim => claim.stage === '转运' && claim.negated);
  assert.deepEqual(denial.subject.candidates, ['A2']);
});

test('m13 邻居口头同意是转述，不能替代当事人确认', () => {
  const m13 = byId.get('m13');
  const hearsay = m13.claims.filter(claim => claim.scope === '转述');
  assert.ok(hearsay.length > 0);
  assert.ok(hearsay.every(claim => claim.status === '待核'));
  assert.ok(hearsay.every(claim => claim.subject.candidates.includes('A3')));
});

test('有效主张里不再包含被更正的转运', () => {
  const effective = effectiveClaims(interpreted);
  assert.ok(!effective.some(claim => claim.message === 'm1' && claim.stage === '转运' &&
    claim.subject.candidates.includes('A3')));
  assert.ok(effective.some(claim => claim.message === 'm1' && claim.stage === '转运' &&
    claim.subject.candidates.includes('A1')));
});

test('接收方留言只产生条件声明，不产生亲见主张', () => {
  const m8 = byId.get('m8');
  assert.ok(m8.claims.every(claim => claim.scope === '条件声明'));
});
