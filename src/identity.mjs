// 个体辨认：把留言里的称呼、芯片号、外貌特征与地点映射到档案候选。
//
// 约定（见 README 与 data/contract.json）：
// - aliases 不是唯一身份，同一只在不同时间能换名，领养家庭也可能给
//   两只同样颜色的猫起不同临时名，所以称呼只产生候选集；
// - place 只是当次登记的观察地点，只能作弱证据收窄候选；
// - 芯片号是强证据；外貌特征与称呼同句出现时可收窄候选。

// 把外貌描述拆成可用于比对的特征片段（含两字以上的连续子串），
// 例如“左耳有浅缺口”能命中留言里的“左耳缺一块”。
export function appearanceKeys(appearance) {
  const keys = new Set();
  for (const raw of appearance.split(/[、，,；;]/)) {
    const token = raw.trim();
    if (token.length < 2) continue;
    keys.add(token);
    for (let length = 2; length < token.length; length++) {
      for (let start = 0; start + length <= token.length; start++) {
        keys.add(token.slice(start, start + length));
      }
    }
  }
  return keys;
}

export function buildIdentityIndex(animals) {
  const byId = new Map();
  const byChip = new Map();
  const byName = new Map();
  const byAppearance = new Map();
  const byPlace = new Map();
  const remember = (table, key, id) => {
    if (!table.has(key)) table.set(key, new Set());
    table.get(key).add(id);
  };
  for (const animal of animals) {
    byId.set(animal.id, animal);
    if (animal.chip !== null) byChip.set(animal.chip, animal.id);
    for (const term of [animal.name, ...animal.aliases]) remember(byName, term, animal.id);
    for (const key of appearanceKeys(animal.appearance)) remember(byAppearance, key, animal.id);
    remember(byPlace, animal.place, animal.id);
  }
  return { byId, byChip, byName, byAppearance, byPlace };
}

// 在一段文字里找出所有可能指向档案个体的线索。
export function findMentions(text, index) {
  const chips = [...text.matchAll(/CH-\d+/g)].map(match => match[0])
    .filter(chip => index.byChip.has(chip));
  const names = [];
  for (const [term, ids] of index.byName) {
    if (text.includes(term)) names.push({ term, ids: [...ids] });
  }
  const looks = [];
  for (const [key, ids] of index.byAppearance) {
    if (text.includes(key)) looks.push({ key, ids: [...ids] });
  }
  const places = [];
  for (const [place, ids] of index.byPlace) {
    if (text.includes(place)) places.push({ place, ids: [...ids] });
  }
  return { chips, names, looks, places };
}

// 依据同句内的其他线索收窄一个称呼的候选集。
// 返回 { candidates, matchedBy, confident }；confident 为 false 时
// 表示应交给值班人发核实请求，而不是擅自定身份。
export function resolveCandidates(termIds, context, index) {
  let candidates = new Set(termIds);
  const matchedBy = ['称呼'];
  const narrow = (ids, why) => {
    const overlap = [...candidates].filter(id => ids.includes(id));
    if (overlap.length > 0 && overlap.length < candidates.size) {
      candidates = new Set(overlap);
      matchedBy.push(why);
    }
  };
  // 芯片只可能对应一只，且必须在候选里才采用。
  for (const chip of context.chips) {
    narrow([index.byChip.get(chip)], '芯片');
  }
  for (const look of context.looks) narrow(look.ids, '外貌');
  for (const place of context.places) narrow(place.ids, '地点');
  const confident = candidates.size === 1 &&
    (matchedBy.includes('芯片') || matchedBy.includes('外貌') ||
      termIds.length === 1);
  return { candidates: [...candidates], matchedBy, confident };
}
