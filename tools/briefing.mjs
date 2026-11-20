// 值班工具：
//   node tools/briefing.mjs                 值班视图（可核实安排 / 仍缺确认 / 已交接 / 原留言）
//   node tools/briefing.mjs notice h1       对外给家庭看的交接安排（只含本次必要照护指示）
//   node tools/briefing.mjs decide v1 拆开  演示对核实请求作决定（合并 / 拆开 / 继续待核）
//   node tools/briefing.mjs options A3      某只个体当前各去向的可行性
import { readBundle } from './materials.mjs';
import {
  buildBriefing,
  decideVerification,
  familyNotice,
  placementOptions,
  renderBriefing,
} from '../src/briefing.mjs';

const [command, ...args] = process.argv.slice(2);
const briefing = buildBriefing(readBundle());

try {
  if (command === undefined) {
    console.log(renderBriefing(briefing));
  } else if (command === 'notice') {
    console.log(familyNotice(briefing, args[0]).text);
  } else if (command === 'decide') {
    const [id, decision] = args;
    const next = decideVerification(briefing, id, decision);
    console.log(renderBriefing(next));
  } else if (command === 'options') {
    const at = args[1] ?? '2026-11-20T09:00:00+08:00';
    for (const option of placementOptions(briefing, args[0], at)) {
      const verdict = option.ok ? '可行' : `不可行：${option.reasons.join('；')}`;
      console.log(`${option.location.id} ${option.location.label}（${option.location.kind}） ${verdict}`);
    }
  } else {
    console.error(`未知命令 ${command}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
