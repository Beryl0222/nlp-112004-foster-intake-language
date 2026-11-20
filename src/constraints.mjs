// 文字里的约束：同伴关系（必须同运 / 可分养但领养须同户 / 仅同来可分开）
// 与接收方家庭开出的条件。约束只在其来源适用范围内生效：
// 值班员当面确认的才算“已确认”，志愿者亲见记为“亲见”，转述只配“待核”。

import { findMentions, resolveCandidates } from './identity.mjs';

const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

const NUMERALS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };

// 留言日期（+08:00）起算，下一个指定星期几的日期。
export function nextWeekday(at, weekday) {
  const date = new Date(at);
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(date);
    candidate.setUTCDate(date.getUTCDate() + offset);
    if (candidate.getUTCDay() === weekday) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  return null;
}

function subjectsOf(text, index) {
  const mentions = findMentions(text, index);
  const ids = new Set();
  for (const chip of mentions.chips) ids.add(index.byChip.get(chip));
  for (const name of mentions.names) {
    const resolved = resolveCandidates(name.ids, mentions, index);
    if (resolved.confident) ids.add(resolved.candidates[0]);
  }
  return [...ids];
}

const RELATION_RULES = [
  ['必须同运', /必须一起|一起转运|不能分开|不可分开/],
  ['分养可_领养同户', /(先分开|分养|分开安置)[\s\S]*?(同一户|同户|一起)|领养时[\s\S]*?(同一户|同户)/],
  ['仅同来可分开', /同来|巧合/],
];

const SCOPE_STATE = { 值班确认: '已确认', 核验: '已确认', 亲见: '亲见', 当事人: '亲见' };

// 从全部留言推导同伴关系。同一对个体后来的确认覆盖先前的建议；
// 明确排除的个体（如“这不是白鼻糖糖的安排”）记入 excludes。
export function deriveRelations(messages, index) {
  const relations = [];
  for (const message of messages) {
    for (const [rule, pattern] of RELATION_RULES) {
      if (!pattern.test(message.text)) continue;
      const pair = subjectsOf(message.text, index);
      if (pair.length < 2) continue;
      const scope = message.verifyRole === '值班员' ? '值班确认'
        : message.verifyRole === '站医' ? '核验'
          : /转述|听说/.test(message.text) ? '转述'
            : '亲见';
      const state = SCOPE_STATE[scope] ?? '待核';
      const excludes = [];
      const exclusion = message.text.match(/这不是(.{1,6})的安排/);
      if (exclusion) {
        const excluded = subjectsOf(exclusion[1], index);
        excludes.push(...excluded.filter(id => !pair.includes(id)));
      }
      relations.push({ pair: pair.slice(0, 2), rule, state, source: message.id, excludes, text: message.text });
    }
  }
  // 同一对个体、同一条规则：已确认覆盖亲见与建议。
  const merged = [];
  for (const relation of relations) {
    const key = `${relation.pair.slice().sort().join('+')}|${relation.rule}`;
    const existing = merged.find(item => item.key === key);
    if (!existing) {
      merged.push({ key, ...relation, sources: [relation.source] });
    } else {
      existing.sources.push(relation.source);
      if (relation.state === '已确认' && existing.state !== '已确认') {
        Object.assign(existing, relation, { sources: existing.sources });
      }
    }
  }
  return merged.map(({ key, ...relation }) => relation);
}

// 接收方留言折算成地点条件，按发送人对应到 locations 里的家庭。
export function familyTerms(messages, locations) {
  const terms = [];
  for (const message of messages) {
    if (message.verifyRole !== '接收方') continue;
    const location = locations.find(entry => entry.label.startsWith(message.sender));
    if (!location) continue;
    const text = message.text;
    const untilMatch = text.match(/只能到(周[日一二三四五六天])/);
    const maxMatch = text.match(/最多([一二两三四五])只/) ?? text.match(/接([一二两三四五])只/);
    const receiveMatch = text.match(/仅(周[日一二三四五六天])能接/);
    terms.push({
      location: location.id,
      source: message.id,
      until: untilMatch ? nextWeekday(message.at, WEEKDAYS[untilMatch[1][1]]) : null,
      maxAnimals: maxMatch ? NUMERALS[maxMatch[1]] : null,
      requiresClearance: /确认可离开隔离|医生确认|医生同意/.test(text),
      noTemporary: /不接受临时|不收临时/.test(text),
      noMixedKind: /混搭/.test(text),
      pairOnlyForTwo: /一起领才接受|同领才接受/.test(text),
      receiveWeekday: receiveMatch ? WEEKDAYS[receiveMatch[1][1]] : null,
      prefersCompanion: /最好[\s\S]*同伴|同伴[\s\S]*一块/.test(text),
      privacy: /不要[\s\S]*(联系|地址)|别[\s\S]*(联系|地址)/.test(text),
      text,
    });
  }
  return terms;
}
