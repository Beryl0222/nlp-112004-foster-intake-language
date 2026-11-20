// 值班视图：把判读后的留言、站医许可、同伴关系与家庭条件汇总成
// 值班人可直接使用的四块内容——可核实的安排、仍缺的确认、
// 已发生的交接、可接手的原留言；并支持对核实请求分别作出
// 合并 / 拆开 / 继续待核 的决定，以及为已交接记录另建待确认的回访或转介。

import { buildIdentityIndex } from './identity.mjs';
import { interpretMessages } from './intake.mjs';
import { extractClearances, clearanceCovers } from './clearance.mjs';
import { deriveRelations, familyTerms } from './constraints.mjs';

const ISOLATION_KIND = '临时隔离';

function sortIds(ids) {
  return ids.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
}

function displayName(animal) {
  return animal.aliases.length > 0 ? `${animal.name}（${animal.aliases[0]}）` : animal.name;
}

// 每只个体的当前所在：登记地点为底，有效转运主张与已交接记录依次覆盖。
function currentFacilities(bundle, claims) {
  const facilities = new Map(bundle.animals.map(animal => [animal.id, null]));
  const moves = claims
    .filter(claim => claim.status === '有效' && !claim.negated &&
      claim.stage === '转运' && claim.location !== null && claim.subject.confident)
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const claim of moves) facilities.set(claim.subject.candidates[0], claim.location);
  const done = bundle.handoffs
    .filter(handoff => handoff.state === '已交接')
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const handoff of done) facilities.set(handoff.assigned, handoff.destination);
  return facilities;
}

// 已预约与已交接都占名额（已确认的位子算占用）。
function occupancyOf(bundle) {
  const occupancy = new Map(bundle.locations.map(location => [location.id, 0]));
  for (const handoff of bundle.handoffs) {
    if (handoff.state === '已预约' || handoff.state === '已交接') {
      occupancy.set(handoff.destination, (occupancy.get(handoff.destination) ?? 0) + 1);
    }
  }
  return occupancy;
}

function assessHandoff(handoff, context) {
  const { bundle, terms, clearances, facilities, occupancy } = context;
  const animal = bundle.animals.find(entry => entry.id === handoff.assigned);
  const destination = bundle.locations.find(entry => entry.id === handoff.destination);
  const reasons = [];
  const checks = { clearance: null, capacity: null, terms: null };

  const from = facilities.get(handoff.assigned);
  const fromLocation = bundle.locations.find(entry => entry.id === from);
  const leavesIsolation = fromLocation?.kind === ISOLATION_KIND && destination.kind !== ISOLATION_KIND;
  if (leavesIsolation) {
    checks.clearance = clearanceCovers(clearances, handoff.assigned, from, destination.kind, handoff.at);
    if (!checks.clearance.ok) reasons.push(`离隔许可：${checks.clearance.reason}`);
  } else {
    checks.clearance = { ok: true, reason: '不离开隔离区，无需离隔许可', by: null };
  }

  const used = occupancy.get(destination.id) ?? 0;
  checks.capacity = { ok: used <= destination.capacity, used, capacity: destination.capacity };
  if (!checks.capacity.ok) reasons.push(`容量 ${used}/${destination.capacity} 已满`);

  const term = terms.find(entry => entry.location === destination.id);
  if (term) {
    const problems = [];
    if (term.requiresClearance && leavesIsolation && !checks.clearance.ok) problems.push('家庭要求离隔确认');
    if (term.maxAnimals !== null && used > term.maxAnimals) problems.push(`家庭最多接 ${term.maxAnimals} 只`);
    if (term.until !== null && checks.clearance.by?.window.end != null &&
      checks.clearance.by.window.end.slice(0, 10) > term.until) {
      problems.push(`照护期超过家庭承诺的 ${term.until}`);
    }
    if (term.receiveWeekday !== null) {
      const weekday = new Date(handoff.at).getUTCDay();
      if (weekday !== term.receiveWeekday) problems.push('家庭仅周六能接');
    }
    if (term.noTemporary && checks.clearance.by?.toKind === '短期') problems.push('家庭不接受临时托付');
    checks.terms = { ok: problems.length === 0, problems, term };
    reasons.push(...problems);
  } else {
    checks.terms = { ok: true, problems: [], term: null };
  }

  const pendingCandidates = handoff.mayInclude.filter(id => id !== handoff.assigned);
  const failed = reasons.length > 0;
  const verdict = failed ? '不可执行'
    : pendingCandidates.length > 0 ? '可执行（候选待核）'
      : '可执行';
  return { handoff, animal, destination, checks, pendingCandidates, verdict, reasons };
}

// 核实请求：预约单候选多于一只时发“身份拆开”；
// 当事人同意只停留在转述或否定时发“去向确认”。
function deriveVerifications(bundle, interpreted) {
  const verifications = [];
  let counter = 0;
  for (const handoff of bundle.handoffs) {
    if (handoff.mayInclude.length <= 1) continue;
    counter += 1;
    const chips = handoff.mayInclude
      .map(id => bundle.animals.find(animal => animal.id === id)?.chip)
      .filter(chip => chip !== null);
    const evidence = new Set(handoff.evidence);
    for (const entry of interpreted) {
      for (const claim of entry.claims) {
        const touches = claim.subject.candidates.some(id => handoff.mayInclude.includes(id));
        if (touches && ['当事人', '核验', '值班确认'].includes(claim.scope)) evidence.add(claim.message);
      }
    }
    verifications.push({
      id: `v${counter}`,
      kind: '身份拆开',
      handoff: handoff.id,
      candidates: [...handoff.mayInclude],
      reason: chips.length > 1
        ? `预约单把同名个体按一只记；档案芯片 ${chips.join(' 与 ')} 不同`
        : '预约单候选多于一只，身份未核清',
      evidence: sortIds([...evidence]),
      state: '待核',
    });
  }
  const consentIssues = new Map();
  for (const entry of interpreted) {
    for (const claim of entry.claims) {
      const aboutConsent = /同意|愿意/.test(claim.clause);
      const hearsayOrDenied = claim.scope === '转述' || claim.negated;
      if (!aboutConsent || !hearsayOrDenied || claim.subject.candidates.length !== 1) continue;
      const animal = claim.subject.candidates[0];
      if (!consentIssues.has(animal)) consentIssues.set(animal, []);
      consentIssues.get(animal).push(claim);
    }
  }
  for (const [animal, claims] of consentIssues) {
    counter += 1;
    verifications.push({
      id: `v${counter}`,
      kind: '去向确认',
      animal,
      reason: `当事人同意未见确认（${claims.map(claim => `${claim.message}：${claim.clause}`).join('；')}）`,
      evidence: [...new Set(claims.map(claim => claim.message))],
      state: '待核',
    });
  }
  return verifications;
}

// 已交接记录只能另建待确认的回访或转介，历史不改动。
function deriveFollowUps(bundle, interpreted) {
  const followUps = [];
  let counter = 0;
  for (const handoff of bundle.handoffs) {
    if (handoff.state !== '已交接') continue;
    for (const entry of interpreted) {
      for (const claim of entry.claims) {
        if (claim.stage !== '领回' || claim.negated) continue;
        if (!claim.subject.candidates.includes(handoff.assigned)) continue;
        counter += 1;
        followUps.push({
          id: `f${counter}`,
          kind: '回访',
          refers: handoff.id,
          animal: handoff.assigned,
          state: '待确认',
          evidence: [claim.message],
          note: `${claim.message} 声明接回；实际领回以新的交接记录为准，${handoff.id} 保持已交接。`,
        });
      }
    }
  }
  return followUps;
}

export function buildBriefing(bundle) {
  const index = buildIdentityIndex(bundle.animals);
  const interpreted = interpretMessages(bundle.messages, index, bundle.locations);
  const claims = interpreted.flatMap(entry => entry.claims);
  const clearances = extractClearances(bundle.messages, index, bundle.locations);
  const relations = deriveRelations(bundle.messages, index);
  const terms = familyTerms(bundle.messages, bundle.locations);
  const facilities = currentFacilities(bundle, claims);
  const occupancy = occupancyOf(bundle);
  const context = { bundle, terms, clearances, facilities, occupancy };

  const arrangements = bundle.handoffs.map(handoff =>
    handoff.state === '已交接'
      ? {
        handoff,
        animal: bundle.animals.find(a => a.id === handoff.assigned),
        destination: bundle.locations.find(l => l.id === handoff.destination),
        verdict: '已交接（历史）',
        reasons: [],
      }
      : assessHandoff(handoff, context));
  const verifications = deriveVerifications(bundle, interpreted);
  const followUps = deriveFollowUps(bundle, interpreted);

  const sourceMessages = new Map(bundle.animals.map(animal => [animal.id, new Set()]));
  for (const claim of claims) {
    for (const id of claim.subject.candidates) sourceMessages.get(id)?.add(claim.message);
  }
  for (const handoff of bundle.handoffs) {
    for (const id of handoff.mayInclude) {
      for (const messageId of handoff.evidence) sourceMessages.get(id)?.add(messageId);
    }
  }

  return {
    bundle,
    interpreted,
    clearances,
    relations,
    terms,
    facilities,
    occupancy,
    arrangements,
    verifications,
    followUps,
    sourceMessages: new Map([...sourceMessages].map(([id, set]) => [id, sortIds([...set])])),
  };
}

// 值班人对核实请求作决定。返回新的视图，不改原视图。
// 拆开：候选回到 assigned 一只，许可不复制给其他个体，伙伴的已预约安排不动；
// 合并：芯片不同的档案拒绝合并；继续待核：不改任何记录。
export function decideVerification(briefing, verificationId, decision) {
  const next = structuredClone(briefing);
  const verification = next.verifications.find(entry => entry.id === verificationId);
  if (!verification) throw new Error(`找不到核实请求 ${verificationId}`);
  if (verification.state !== '待核') throw new Error(`${verificationId} 已处理（${verification.state}）`);

  if (verification.kind === '身份拆开') {
    const handoff = next.bundle.handoffs.find(entry => entry.id === verification.handoff);
    if (decision === '合并') {
      const chips = verification.candidates
        .map(id => next.bundle.animals.find(animal => animal.id === id)?.chip)
        .filter(chip => chip !== null);
      if (new Set(chips).size > 1) {
        throw new Error(`芯片 ${chips.join(' 与 ')} 不同，不能合并为一只`);
      }
      handoff.mayInclude = [handoff.assigned];
      verification.state = '已合并';
    } else if (decision === '拆开') {
      const before = JSON.stringify({
        clearances: next.clearances,
        others: next.bundle.handoffs.filter(entry => entry.id !== handoff.id),
      });
      handoff.mayInclude = [handoff.assigned];
      handoff.note += `（${verificationId} 拆开：候选只保留 ${handoff.assigned}）`;
      verification.state = '已拆开';
      const after = JSON.stringify({
        clearances: next.clearances,
        others: next.bundle.handoffs.filter(entry => entry.id !== handoff.id),
      });
      if (before !== after) throw new Error('拆开影响了许可或其他交接，已回滚');
    } else if (decision === '待核' || decision === '继续待核') {
      verification.reason += '（值班人选择继续待核）';
    } else {
      throw new Error(`身份拆开请求不支持决定「${decision}」`);
    }
    const context = {
      bundle: next.bundle,
      terms: next.terms,
      clearances: next.clearances,
      facilities: new Map(next.facilities),
      occupancy: new Map(next.occupancy),
    };
    const index = next.arrangements.findIndex(entry => entry.handoff.id === handoff.id);
    next.arrangements[index] = assessHandoff(handoff, context);
    return next;
  }

  if (verification.kind === '去向确认') {
    if (decision === '已确认') verification.state = '已确认';
    else if (decision === '驳回') verification.state = '已驳回';
    else if (decision === '待核' || decision === '继续待核') {
      verification.reason += '（值班人选择继续待核）';
    } else {
      throw new Error(`去向确认请求不支持决定「${decision}」`);
    }
    return next;
  }
  throw new Error(`未知的核实类型 ${verification.kind}`);
}

// 已交接的记录只允许另建待确认的回访或转介，历史不写成未离开。
export function createFollowUp(briefing, handoffId, { kind = '回访', note = '', evidence = [] } = {}) {
  const handoff = briefing.bundle.handoffs.find(entry => entry.id === handoffId);
  if (!handoff) throw new Error(`找不到交接记录 ${handoffId}`);
  if (handoff.state !== '已交接') throw new Error('只有已交接的记录才能另建回访或转介');
  const next = structuredClone(briefing);
  const id = `f${next.followUps.length + 1}`;
  next.followUps.push({
    id,
    kind,
    refers: handoffId,
    animal: handoff.assigned,
    state: '待确认',
    evidence,
    note: note || `${handoffId} 保持已交接，本记录待确认。`,
  });
  return next;
}

// 对外给家庭看的安排：只带本次必要的照护指示，
// 由白名单字段拼装，不转发其他求助人的私下留言。
export function familyNotice(briefing, handoffId) {
  const arrangement = briefing.arrangements.find(entry => entry.handoff.id === handoffId);
  if (!arrangement) throw new Error(`找不到交接安排 ${handoffId}`);
  const { handoff, animal, destination } = arrangement;
  const lines = [`交接安排 ${handoff.id}（${destination?.label ?? handoff.destination}，${handoff.at}）`];
  lines.push(`个体：${displayName(animal)}（登记 ${animal.id}）；识别特征：${animal.appearance}`);

  const clearance = arrangement.checks?.clearance?.by;
  if (clearance) {
    const from = briefing.bundle.locations.find(entry => entry.id === clearance.from);
    lines.push(`医生许可：${animal.chip ?? animal.id} 可从${from?.label ?? clearance.from}` +
      `转入${clearance.toKind}寄养，` +
      `窗口 ${clearance.window.start.slice(0, 10)} 至 ${clearance.window.end.slice(0, 10)}（${clearance.source}）`);
  }
  const term = arrangement.checks?.terms?.term;
  if (term?.until) lines.push(`照护期限：至 ${term.until}（家庭承诺）`);
  for (const relation of briefing.relations) {
    if (relation.state !== '已确认' || !relation.pair.includes(animal.id)) continue;
    const partnerId = relation.pair.find(id => id !== animal.id);
    const partner = briefing.bundle.animals.find(entry => entry.id === partnerId);
    if (relation.rule === '分养可_领养同户') {
      lines.push(`同伴约定：与${displayName(partner)}正式领养时须同户（${relation.source} 确认）`);
    }
  }
  lines.push('本通知仅含本次交接所需的照护指示。');
  return { to: destination?.label ?? handoff.destination, handoff: handoff.id, lines, text: lines.join('\n') };
}

// 为某只个体评估各去向是否可行，供寄养人员选择家庭能承担的去向。
export function placementOptions(briefing, animalId, at) {
  const { bundle, occupancy, terms, clearances, facilities, relations } = briefing;
  const animal = bundle.animals.find(entry => entry.id === animalId);
  const from = bundle.locations.find(entry => entry.id === facilities.get(animalId));
  const leavesIsolation = from?.kind === ISOLATION_KIND;
  return bundle.locations.map(location => {
    const reasons = [];
    const used = occupancy.get(location.id) ?? 0;
    if (used >= location.capacity) reasons.push(`名额已满 ${used}/${location.capacity}`);
    const term = terms.find(entry => entry.location === location.id);
    if (leavesIsolation && location.kind !== ISOLATION_KIND) {
      const cover = clearanceCovers(clearances, animalId, from.id, location.kind, at);
      if (!cover.ok) reasons.push(cover.reason);
    }
    if (term?.requiresClearance && leavesIsolation) {
      const cover = clearanceCovers(clearances, animalId, from.id, location.kind, at);
      if (!cover.ok) reasons.push('家庭要求医生确认');
    }
    if (term?.noTemporary) reasons.push('家庭不接受临时托付');
    if (location.kind === '长期') {
      const tie = relations.find(relation => relation.state === '已确认' &&
        relation.rule === '分养可_领养同户' && relation.pair.includes(animalId));
      if (tie) reasons.push('领养须与同伴同户，须两只一起评估');
    }
    return { location, ok: reasons.length === 0, reasons };
  });
}

// 值班人文字视图。
export function renderBriefing(briefing) {
  const { bundle, arrangements, verifications, followUps, sourceMessages, occupancy } = briefing;
  const lines = ['值班视图（虚构演练资料）', ''];
  lines.push('■ 可核实的安排');
  for (const arrangement of arrangements) {
    if (arrangement.verdict === '已交接（历史）') continue;
    const { handoff, animal, destination } = arrangement;
    const used = occupancy.get(destination.id);
    const parts = [
      `${handoff.id} ${animal.id} ${displayName(animal)} → ${destination.label}（${destination.kind}）`,
      handoff.at,
      `名额 ${used}/${destination.capacity}`,
    ];
    if (arrangement.checks.clearance.by) parts.push(`许可 ${arrangement.checks.clearance.by.source}`);
    if (arrangement.pendingCandidates.length > 0) {
      parts.push(`候选 ${arrangement.pendingCandidates.join('、')} 待核`);
    }
    if (arrangement.reasons.length > 0) parts.push(`问题：${arrangement.reasons.join('；')}`);
    lines.push(`- [${arrangement.verdict}] ${parts.join('｜')}`);
  }
  lines.push('');
  lines.push('■ 仍缺的确认');
  const pending = verifications.filter(entry => entry.state === '待核');
  if (pending.length === 0 && followUps.every(entry => entry.state !== '待确认')) lines.push('- 无');
  for (const verification of pending) {
    lines.push(`- ${verification.id} ${verification.kind}：${verification.reason}（证据 ${verification.evidence.join('、')}）`);
  }
  for (const followUp of followUps.filter(entry => entry.state === '待确认')) {
    lines.push(`- ${followUp.id} ${followUp.kind}（${followUp.refers}）：${followUp.note}`);
  }
  lines.push('');
  lines.push('■ 已发生的交接（历史保留）');
  for (const arrangement of arrangements) {
    if (arrangement.verdict !== '已交接（历史）') continue;
    const { handoff, animal } = arrangement;
    const destination = bundle.locations.find(entry => entry.id === handoff.destination);
    lines.push(`- ${handoff.id} ${animal.id} ${displayName(animal)} → ${destination.label}｜${handoff.at}｜证据 ${handoff.evidence.join('、')}`);
  }
  lines.push('');
  lines.push('■ 可接手的原留言');
  for (const animal of bundle.animals) {
    const messages = sourceMessages.get(animal.id) ?? [];
    lines.push(`- ${animal.id} ${displayName(animal)}：${messages.join('、') || '无'}`);
  }
  return lines.join('\n');
}
