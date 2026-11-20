// 留言判读：把每条值班留言拆成分句级、单主体的主张（claim），标明
// 谁亲眼见到、说的是哪只、在哪个地点、什么时间、哪个照护阶段。
//
// 判读规则是透明的关键字规则，只覆盖本演练语料的表达方式；
// 规则拿不准时一律标“待核”，交给值班人发核实请求，不擅自定身份。

import { findMentions, resolveCandidates } from './identity.mjs';

const STAGE_PATTERNS = [
  ['领回', /接回|领回/],
  ['归属', /是我家的|我家的猫/],
  ['转运', /上车|转运|接去|转入|转出|送救助|送到|暂留/],
  ['隔离', /隔离/],
  ['寄养', /短寄|寄养|短托|托付|分养|安置/],
  ['领养', /领养|同领/],
  ['观察', /看见|见到|看到|来了|躲在|见过|同来/],
];

const NEGATION = /没|没有|未|不是|不能|不要|别/;
const CORRECTION = /更正|纠正/;
const RELAY = /转述|听说|据说|口头|[\p{Script=Han}]{1,4}说/u;
const OWNER = /是我家的|我接回|我领回/;

// 相对留言时间的日期线索（按 +08:00 的日历日偏移）。
const TIME_PATTERNS = [
  [/昨晚|昨夜/, -1],
  [/昨天|昨日/, -1],
  [/今天|今日|今晨/, 0],
  [/明天|明日/, 1],
  [/下周/, 7],
];

// 会被更正覆盖的阶段：只覆盖改变状态的主张，观察类主张保留。
const SUPERSEDABLE_STAGES = new Set(['转运', '隔离', '寄养', '领养', '领回']);

export function splitClauses(text) {
  return text.split(/(?<=[。！？；，])/).map(clause => clause.trim()).filter(Boolean);
}

function detectStage(clause) {
  for (const [stage, pattern] of STAGE_PATTERNS) {
    if (pattern.test(clause)) return stage;
  }
  return null;
}

function scopeFor(clause, verifyRole) {
  if (RELAY.test(clause)) return '转述';
  if (verifyRole === '站医') return '核验';
  if (verifyRole === '值班员') return '值班确认';
  if (verifyRole === '接收方') return '条件声明';
  if (verifyRole === '居民' && OWNER.test(clause)) return '当事人';
  return '亲见';
}

function eventDateFor(clause, at) {
  for (const [pattern, offset] of TIME_PATTERNS) {
    if (pattern.test(clause)) {
      const date = new Date(at);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    }
  }
  return at.slice(0, 10);
}

function locationMention(clause, locations) {
  for (const location of locations) {
    if (clause.includes(location.label.slice(0, 2))) return location.id;
  }
  return null;
}

// 解读单条留言，返回 { message, claims }；每条 claim 只讲一只个体。
// 收窄候选只用同一句内的芯片、外貌、地点线索，不跨句借用，
// 免得把别句的地点错安到这句的称呼上。
export function interpretMessage(message, index, locations) {
  const messageMentions = findMentions(message.text, index);
  const correction = CORRECTION.test(message.text);
  const claims = [];
  let lastSubjects = [];
  let counter = 0;
  for (const clause of splitClauses(message.text)) {
    const mentions = findMentions(clause, index);
    let subjects = [];
    if (mentions.names.length > 0) {
      subjects = mentions.names.map(name => ({
        term: name.term,
        ...resolveCandidates(name.ids, mentions, index),
      }));
    } else if (mentions.chips.length > 0) {
      subjects = mentions.chips.map(chip => ({
        term: chip,
        candidates: [index.byChip.get(chip)],
        matchedBy: ['芯片'],
        confident: true,
      }));
    } else if (mentions.looks.length > 0) {
      const ids = [...new Set(mentions.looks.flatMap(look => look.ids))];
      if (ids.length === 1) {
        subjects = [{ term: mentions.looks[0].key, candidates: ids, matchedBy: ['外貌'], confident: true }];
      }
    }
    if (subjects.length === 0) subjects = lastSubjects;
    if (subjects.length > 0) lastSubjects = subjects;

    const stage = detectStage(clause) ?? (subjects.length > 0 ? '观察' : null);
    if (subjects.length === 0) continue;
    const scope = scopeFor(clause, message.verifyRole);
    const base = {
      message: message.id,
      sender: message.sender,
      verifyRole: message.verifyRole,
      at: message.at,
      scope,
      correction,
      clause,
      stage,
      negated: NEGATION.test(clause),
      place: mentions.places[0]?.place ?? messageMentions.places[0]?.place ?? null,
      location: locationMention(clause, locations),
      eventDate: eventDateFor(clause, message.at),
      supersededBy: null,
    };
    const targets = subjects;
    for (const subject of targets) {
      counter += 1;
      claims.push({
        ...base,
        id: `${message.id}#${counter}`,
        subject,
        status: scope === '转述' || !subject.confident ? '待核' : '有效',
      });
    }
  }
  return { message, claims };
}

// 解读全部留言并应用更正：更正留言对被回复留言中同个体、同阶段、
// 且极性相反（肯定 vs 否定）的状态主张逐条覆盖，原主张保留并标记“被更正”。
export function interpretMessages(messages, index, locations) {
  const interpreted = messages.map(message => interpretMessage(message, index, locations));
  const byId = new Map(interpreted.map(entry => [entry.message.id, entry]));
  for (const entry of interpreted) {
    if (!CORRECTION.test(entry.message.text)) continue;
    const corrections = entry.claims.filter(claim => SUPERSEDABLE_STAGES.has(claim.stage));
    if (corrections.length === 0) continue;
    for (const targetId of entry.message.replies) {
      const target = byId.get(targetId);
      if (!target) continue;
      for (const claim of target.claims) {
        if (!SUPERSEDABLE_STAGES.has(claim.stage)) continue;
        const covered = corrections.some(correction =>
          correction.stage === claim.stage &&
          correction.negated !== claim.negated &&
          correction.subject.candidates.some(id => claim.subject.candidates.includes(id)));
        if (covered) {
          claim.status = '被更正';
          claim.supersededBy = entry.message.id;
        }
      }
    }
  }
  return interpreted;
}

// 当前仍有效的主张（未被更正、非待核），供交接模块判断个体所在与阶段。
export function effectiveClaims(interpreted) {
  return interpreted.flatMap(entry => entry.claims)
    .filter(claim => claim.status === '有效');
}
