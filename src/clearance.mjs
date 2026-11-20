// 站医许可：离开隔离区的许可只来自站医留言，且只适用于
// 说清的个体、交接方向（从哪到哪类地点）和时间窗口。
// 许可不可复制给其他个体；明确的拒绝同样只针对所指个体。

import { findMentions } from './identity.mjs';

const APPROVAL = /可|许可|批准/;
const DENIAL = /没有|未|不得|不可|不许/;

// 把“明天上午”“期限到 22 日晚”这类说法换算成 +08:00 的起止时刻。
// 上午按 06:00 起算，“到某日晚”按当日结束（23:59:59）止。
function parseWindow(text, at) {
  const day = at.slice(0, 10);
  let start = `${day}T00:00:00+08:00`;
  let end = null;
  if (/明天/.test(text)) {
    const date = new Date(at);
    date.setUTCDate(date.getUTCDate() + 1);
    start = `${date.toISOString().slice(0, 10)}T06:00:00+08:00`;
  }
  const deadline = text.match(/(?:期限到|到|至)\s*(\d{1,2})\s*日/);
  if (deadline) {
    const month = day.slice(0, 7);
    end = `${month}-${deadline[1].padStart(2, '0')}T23:59:59+08:00`;
  }
  return { start, end };
}

// 从站医留言提取许可与拒绝。
// 返回 [{ animal, from, toKind, window, polarity, source, text }]
export function extractClearances(messages, index, locations) {
  const clearances = [];
  for (const message of messages) {
    if (message.verifyRole !== '站医') continue;
    const mentions = findMentions(message.text, index);
    const animals = [...new Set(mentions.chips.map(chip => index.byChip.get(chip)))];
    if (animals.length === 0) continue;
    const from = locations.find(location =>
      message.text.includes(location.label.slice(0, 2)) &&
      /隔离/.test(location.kind))?.id ?? null;
    const toKind = /短寄|短期|短托/.test(message.text) ? '短期'
      : /领养|长期/.test(message.text) ? '长期'
        : null;
    const polarity = DENIAL.test(message.text) && /批准|许可|可/.test(message.text) ? '拒绝'
      : APPROVAL.test(message.text) ? '许可'
        : null;
    if (polarity === null) continue;
    for (const animal of animals) {
      clearances.push({
        animal,
        from,
        toKind,
        window: polarity === '许可' ? parseWindow(message.text, message.at) : null,
        polarity,
        source: message.id,
        text: message.text,
      });
    }
  }
  return clearances;
}

// 判断某次交接是否被许可覆盖：同个体、同起点、同去向类别、时刻落在窗口内。
// 若该个体有明确的拒绝且没有被更新的许可覆盖，则不算覆盖。
export function clearanceCovers(clearances, animalId, fromId, toKind, at) {
  const relevant = clearances.filter(clearance => clearance.animal === animalId);
  const denial = relevant.find(clearance => clearance.polarity === '拒绝' &&
    (clearance.from === null || clearance.from === fromId));
  const approval = relevant.find(clearance => {
    if (clearance.polarity !== '许可') return false;
    if (clearance.from !== null && clearance.from !== fromId) return false;
    if (clearance.toKind !== null && clearance.toKind !== toKind) return false;
    const { start, end } = clearance.window;
    if (start !== null && at < start) return false;
    if (end !== null && at > end) return false;
    return true;
  });
  if (approval) return { ok: true, by: approval };
  if (denial) return { ok: false, reason: `站医明确未批准（${denial.source}）`, by: denial };
  return { ok: false, reason: '没有覆盖本次交接的站医许可', by: null };
}
