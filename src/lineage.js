// 连续谱系：从品种版本回溯到育种世代、原始种质，以及过程中的试验与决策。

import { buildIndex, findVersion } from "./pack.js";

// 返回某版本所对应材料的祖先链（自顶向下：最早资源 → 当前材料）。
export function materialAncestry(pack, materialId) {
  const byId = new Map(pack.germplasm.map((g) => [g.id, g]));
  const chain = [];
  const seen = new Set();

  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const g = byId.get(id);
    if (!g) return;
    // 深度优先，父本先入链；排序保证输出稳定
    for (const parentId of [...g.derived_from].sort()) {
      walk(parentId);
    }
    if (!chain.some((x) => x.id === id)) chain.push(g);
  };
  walk(materialId);
  return chain;
}

// 品种版本的完整谱系：审定 → 版本 → 材料世代 → 原始种质，并附带名称沿革。
export function versionLineage(pack, versionId) {
  const found = findVersion(pack, versionId);
  if (!found) throw new Error(`版本不存在：${versionId}`);
  const { variety, version } = found;
  const registrations = pack.registrations
    .filter((r) => r.variety_version_id === version.id)
    .map((r) => ({ cert_no: r.cert_no, decision_date: r.decision_date, regions: r.regions, status: r.status }));
  const packages = pack.cultivation_packages
    .filter((c) => c.variety_version_id === version.id)
    .map((c) => ({ id: c.id, title: c.title, regions: c.regions, techniques: c.techniques }));
  return {
    variety_id: variety.id,
    current_name: variety.current_name,
    name_history: variety.names,
    version,
    material_chain: materialAncestry(pack, version.material_id),
    registrations,
    cultivation_packages: packages,
  };
}

// 某材料/版本形成过程中引用的试验（含阴性）与决策，按日期排列。
export function evidenceTimeline(pack, versionId) {
  const idx = buildIndex(pack);
  const { version } = findVersion(pack, versionId);
  const materialIds = new Set(materialAncestry(pack, version.material_id).map((g) => g.id));

  const trials = pack.field_trials
    .filter((t) => t.material_id && materialIds.has(t.material_id))
    .map((t) => ({ kind: "trial", date: seasonDate(t), ref: t.id, summary: `${t.name}（${t.outcome}）` }));

  const decisions = pack.breeding_decisions
    .filter((d) => materialIds.has(d.material_id) || (d.output_material_id && materialIds.has(d.output_material_id)))
    .map((d) => ({ kind: "decision", date: d.date, ref: d.id, summary: `${d.action}：${d.rationale}` }));

  return [...trials, ...decisions].sort((a, b) => a.date.localeCompare(b.date));
}

// 季节字符串没有精确日期，统一映射到该季节起始日用于排序。
function seasonDate(trial) {
  if (/^(\d{4})/.test(trial.season ?? "")) {
    const year = trial.season.match(/^(\d{4})/)[1];
    if (trial.season.includes("南繁")) return `${Number(year) - 1}-11-01`;
    return `${year}-05-01`;
  }
  return "9999-12-31";
}
