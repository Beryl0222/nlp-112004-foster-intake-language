import assert from 'node:assert/strict';
import test from 'node:test';
import { readBundle } from '../tools/materials.mjs';
import { buildIdentityIndex } from '../src/identity.mjs';
import { clearanceCovers, extractClearances } from '../src/clearance.mjs';
import { deriveRelations, familyTerms } from '../src/constraints.mjs';
import {
  buildBriefing,
  createFollowUp,
  decideVerification,
  familyNotice,
  placementOptions,
  renderBriefing,
} from '../src/briefing.mjs';

const bundle = readBundle();
const index = buildIdentityIndex(bundle.animals);
const briefing = buildBriefing(bundle);

test('站医许可只覆盖指定个体、方向与窗口', () => {
  const clearances = extractClearances(bundle.messages, index, bundle.locations);
  const approval = clearances.find(clearance => clearance.polarity === '许可');
  assert.equal(approval.animal, 'A1');
  assert.equal(approval.from, 'r1');
  assert.equal(approval.toKind, '短期');
  assert.ok(clearanceCovers(clearances, 'A1', 'r1', '短期', '2026-11-20T10:00:00+08:00').ok);
  assert.ok(!clearanceCovers(clearances, 'A1', 'r1', '短期', '2026-11-23T08:00:00+08:00').ok,
    '超过 22 日晚的期限不再覆盖');
  assert.ok(!clearanceCovers(clearances, 'A1', 'r1', '长期', '2026-11-20T10:00:00+08:00').ok,
    '短期许可不覆盖长期方向');
  const denied = clearanceCovers(clearances, 'A2', 'r1', '短期', '2026-11-20T10:00:00+08:00');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /m7/, 'A2 的拒绝要指回 m7');
});

test('同伴关系分级：仅同来可分开、分养可但领养须同户，且不扩到白鼻糖糖', () => {
  const relations = deriveRelations(bundle.messages, index);
  const coArrived = relations.find(relation => relation.rule === '仅同来可分开');
  assert.deepEqual(coArrived.pair.sort(), ['A1', 'A3']);
  const adoptTogether = relations.find(relation => relation.rule === '分养可_领养同户');
  assert.deepEqual(adoptTogether.pair.sort(), ['A1', 'A3']);
  assert.equal(adoptTogether.state, '已确认');
  assert.equal(adoptTogether.source, 'm12', '值班员当面确认覆盖志愿者的建议');
  assert.deepEqual(adoptTogether.excludes, ['A2'], 'm12 明示不适用于白鼻糖糖');
});

test('家庭留言折算成地点条件', () => {
  const terms = familyTerms(bundle.messages, bundle.locations);
  const qiu = terms.find(term => term.location === 'r2');
  assert.equal(qiu.until, '2026-11-22', '只能到周日');
  assert.equal(qiu.maxAnimals, 2);
  assert.ok(qiu.requiresClearance);
  const cen = terms.find(term => term.location === 'r4');
  assert.equal(cen.maxAnimals, 1);
  assert.ok(cen.privacy, '岑家要求不要转发别人联系地址');
  const shan = terms.find(term => term.location === 'r5');
  assert.equal(shan.receiveWeekday, 6);
  assert.ok(shan.noTemporary);
});

test('值班视图：可执行安排、待核候选、历史交接各归各位', () => {
  const h1 = briefing.arrangements.find(entry => entry.handoff.id === 'h1');
  assert.equal(h1.verdict, '可执行（候选待核）');
  assert.deepEqual(h1.pendingCandidates, ['A2']);
  assert.equal(h1.checks.clearance.by.source, 'm6');
  const h2 = briefing.arrangements.find(entry => entry.handoff.id === 'h2');
  assert.equal(h2.verdict, '可执行');
  const h3 = briefing.arrangements.find(entry => entry.handoff.id === 'h3');
  assert.equal(h3.verdict, '已交接（历史）');
  assert.equal(briefing.occupancy.get('r2'), 2, '已确认的位子算占用');
  const v1 = briefing.verifications.find(entry => entry.id === 'v1');
  assert.equal(v1.kind, '身份拆开');
  assert.deepEqual(v1.candidates, ['A1', 'A2']);
  const v2 = briefing.verifications.find(entry => entry.kind === '去向确认');
  assert.equal(v2.animal, 'A3');
  const followUp = briefing.followUps.find(entry => entry.refers === 'h3');
  assert.equal(followUp.state, '待确认');
});

test('拆开：许可不复制给另一只，伙伴的已预约安排不动', () => {
  const next = decideVerification(briefing, 'v1', '拆开');
  const h1 = next.bundle.handoffs.find(entry => entry.id === 'h1');
  assert.deepEqual(h1.mayInclude, ['A1']);
  assert.equal(h1.assigned, 'A1');
  const clearances = next.clearances.filter(clearance => clearance.polarity === '许可');
  assert.ok(clearances.every(clearance => clearance.animal === 'A1'), '许可仍只属于 A1');
  const untouched = next.bundle.handoffs.filter(entry => entry.id !== 'h1');
  const original = briefing.bundle.handoffs.filter(entry => entry.id !== 'h1');
  assert.deepEqual(untouched, original, '其他交接记录一字不动');
  assert.equal(next.bundle.handoffs.find(entry => entry.id === 'h3').state, '已交接');
  const h1After = next.arrangements.find(entry => entry.handoff.id === 'h1');
  assert.equal(h1After.verdict, '可执行');
  assert.equal(next.followUps.find(entry => entry.refers === 'h3').state, '待确认',
    '拆开不影响已交接记录的待确认回访');
  assert.equal(briefing.bundle.handoffs.find(entry => entry.id === 'h1').mayInclude.length, 2,
    '原视图不被决定改动');
});

test('合并：芯片不同的档案拒绝合并；继续待核不改记录', () => {
  assert.throws(() => decideVerification(briefing, 'v1', '合并'), /不能合并/);
  const pending = decideVerification(briefing, 'v1', '继续待核');
  assert.equal(pending.verifications.find(entry => entry.id === 'v1').state, '待核');
  assert.deepEqual(pending.bundle.handoffs, briefing.bundle.handoffs);
  const confirmed = decideVerification(briefing, 'v2', '已确认');
  assert.equal(confirmed.verifications.find(entry => entry.id === 'v2').state, '已确认');
  assert.throws(() => decideVerification(confirmed, 'v2', '已确认'), /已处理/);
});

test('已交接后只允许另建待确认的回访或转介，历史不写成未离开', () => {
  const next = createFollowUp(briefing, 'h3', { kind: '转介', evidence: ['m3'] });
  const added = next.followUps[next.followUps.length - 1];
  assert.equal(added.kind, '转介');
  assert.equal(added.state, '待确认');
  assert.equal(next.bundle.handoffs.find(entry => entry.id === 'h3').state, '已交接');
  assert.throws(() => createFollowUp(briefing, 'h1'), /已交接/);
});

test('对外通知只带本次必要照护指示，不夹带其他求助人的私下留言', () => {
  const notice = familyNotice(briefing, 'h1');
  assert.match(notice.text, /左耳有浅缺口/);
  assert.match(notice.text, /CH-801/);
  assert.match(notice.text, /2026-11-22/);
  assert.match(notice.text, /同户/);
  for (const leaked of ['蓝雨', '竹桥', '接回', '联系地址', '岑家', '杉窗', 'CH-913']) {
    assert.ok(!notice.text.includes(leaked), `通知不应出现「${leaked}」`);
  }
});

test('去向评估：名额、隔离容量与家庭承诺都影响选择', () => {
  const options = placementOptions(briefing, 'A3', '2026-11-20T09:00:00+08:00');
  const byId = new Map(options.map(option => [option.location.id, option]));
  assert.equal(byId.get('r2').ok, false, '丘家已满');
  assert.equal(byId.get('r4').ok, false, '岑家名额被已交接占用');
  assert.equal(byId.get('r5').ok, false, '杉窗不接受临时托付且领养须同户');
  assert.equal(byId.get('r1').ok, true, '临时隔离还有容量');
});

test('值班视图文本涵盖四块内容', () => {
  const view = renderBriefing(briefing);
  for (const section of ['可核实的安排', '仍缺的确认', '已发生的交接', '可接手的原留言']) {
    assert.ok(view.includes(section), `视图缺少「${section}」`);
  }
  assert.ok(view.includes('v1'));
  assert.ok(view.includes('m4'));
});
