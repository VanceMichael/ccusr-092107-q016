// 领域资料包的读取、结构校验与索引。
// 只做纯数据校验，不包含业务判定（排期、许可、溯源等规则在各自模块中）。

const COLLECTIONS = [
  "teams",
  "germplasm",
  "market_signals",
  "breeding_decisions",
  "plots",
  "plot_bookings",
  "field_trials",
  "cultivation_packages",
  "varieties",
  "registrations",
  "joint_agreements",
  "ip_rights",
  "licenses",
  "enterprise_grants",
  "promotion_feedback",
  "sales_batches",
];

export function parsePack(raw) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || typeof value !== "object") {
    throw new Error("领域资料包必须是对象");
  }
  for (const field of ["domain", "version", "sample_id", "facts", ...COLLECTIONS]) {
    if (!(field in value)) {
      throw new Error(`领域资料缺少必要字段：${field}`);
    }
  }
  if (value.domain !== "seed-commercialization") {
    throw new Error("领域标识必须为 seed-commercialization");
  }
  if (!Number.isInteger(value.version) || value.version < 1) {
    throw new Error("版本号必须为不小于 1 的整数");
  }
  if (!Array.isArray(value.facts) || value.facts.length === 0) {
    throw new Error("业务事实列表不能为空");
  }
  return value;
}

// 校验引用完整性与跨字段约束，返回错误信息数组（空数组表示通过）。
export function validatePack(pack) {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  for (const key of COLLECTIONS) {
    if (!Array.isArray(pack[key])) fail(`${key} 必须是数组`);
  }
  if (errors.length) return errors;

  const index = buildIndex(pack);
  const assertRef = (kind, id, where) => {
    if (id != null && !index[kind].has(id)) fail(`${where} 引用了不存在的 ${kind}：${id}`);
  };

  // 各集合内 id 唯一
  for (const key of COLLECTIONS) {
    const seen = new Set();
    for (const item of pack[key]) {
      if (!item.id) fail(`${key} 中存在缺少 id 的记录`);
      else if (seen.has(item.id)) fail(`${key} 中 id 重复：${item.id}`);
      seen.add(item.id);
    }
  }

  // 团队
  for (const t of pack.teams) {
    if (!["科研团队", "企业", "平台"].includes(t.type)) fail(`团队 ${t.id} 类型非法`);
  }

  // 种质材料
  for (const g of pack.germplasm) {
    assertRef("teams", g.holder_team, `种质 ${g.id}`);
    for (const p of g.derived_from) assertRef("germplasm", p, `种质 ${g.id} 的亲本`);
    if (g.created_via_decision) assertRef("breeding_decisions", g.created_via_decision, `种质 ${g.id}`);
  }

  // 市场信号与育种决策
  for (const s of pack.market_signals) {
    if (s.source_enterprise) assertRef("teams", s.source_enterprise, `市场信号 ${s.id}`);
    if (s.sourced_from_feedback) assertRef("promotion_feedback", s.sourced_from_feedback, `市场信号 ${s.id}`);
  }
  for (const d of pack.breeding_decisions) {
    assertRef("germplasm", d.material_id, `决策 ${d.id}`);
    if (d.output_material_id) assertRef("germplasm", d.output_material_id, `决策 ${d.id} 的产出材料`);
    for (const sid of d.based_on_signal_ids ?? []) assertRef("market_signals", sid, `决策 ${d.id}`);
    for (const tid of d.based_on_trial_ids ?? []) assertRef("field_trials", tid, `决策 ${d.id}`);
  }

  // 试验地排期与田间试验
  for (const b of pack.plot_bookings) {
    assertRef("plots", b.plot_id, `排期 ${b.id}`);
    assertRef("teams", b.team_id, `排期 ${b.id}`);
    if (b.trial_id) assertRef("field_trials", b.trial_id, `排期 ${b.id}`);
    if (b.start_date > b.end_date) fail(`排期 ${b.id} 的开始日期晚于结束日期`);
    if (b.status === "已驳回" && !b.rejected_reason) fail(`排期 ${b.id} 被驳回但未记录原因`);
  }
  for (const t of pack.field_trials) {
    if (t.material_id) assertRef("germplasm", t.material_id, `试验 ${t.id}`);
    if (t.variety_version_id && !findVersion(pack, t.variety_version_id)) {
      fail(`试验 ${t.id} 引用了不存在的品种版本：${t.variety_version_id}`);
    }
    if (t.plot_booking_id) assertRef("plot_bookings", t.plot_booking_id, `试验 ${t.id}`);
    if (t.resulting_decision_id) assertRef("breeding_decisions", t.resulting_decision_id, `试验 ${t.id}`);
    if (t.outcome === "阴性" && !t.consequence) fail(`阴性试验 ${t.id} 必须记录处置后果`);
  }

  // 品种、版本、名称与审定
  for (const v of pack.varieties) {
    assertRef("germplasm", v.origin_material_id, `品种 ${v.id}`);
    if (!v.names?.length) fail(`品种 ${v.id} 缺少名称谱系`);
    if (!v.versions?.length) fail(`品种 ${v.id} 缺少版本谱系`);
    for (const ver of v.versions) assertRef("germplasm", ver.material_id, `品种版本 ${ver.id}`);
  }
  for (const r of pack.registrations) {
    const v = index.varieties.get(r.variety_id);
    if (!v) { fail(`审定 ${r.id} 引用了不存在的品种`); continue; }
    if (!v.versions.some((x) => x.id === r.variety_version_id)) {
      fail(`审定 ${r.id} 引用了不属于该品种的版本：${r.variety_version_id}`);
    }
    for (const tid of r.supporting_trial_ids) assertRef("field_trials", tid, `审定 ${r.id}`);
  }

  // 联合育种协议与知识产权：份额合计 100
  for (const ja of pack.joint_agreements) {
    const sum = ja.parties.reduce((a, p) => a + p.share_pct, 0);
    if (Math.abs(sum - 100) > 0.001) fail(`联合育种协议 ${ja.id} 各方份额合计为 ${sum}，应为 100`);
    for (const p of ja.parties) {
      assertRef("teams", p.team_id, `协议 ${ja.id}`);
      for (const m of p.contributed_material_ids ?? []) assertRef("germplasm", m, `协议 ${ja.id}`);
    }
  }
  for (const ipr of pack.ip_rights) {
    if (!findVersion(pack, ipr.variety_version_id)) fail(`知识产权 ${ipr.id} 引用了不存在的版本`);
    assertRef("joint_agreements", ipr.agreement_id, `知识产权 ${ipr.id}`);
    const sum = ipr.owners.reduce((a, o) => a + o.share_pct, 0);
    if (Math.abs(sum - 100) > 0.001) fail(`知识产权 ${ipr.id} 权利人份额合计为 ${sum}，应为 100`);
    for (const o of ipr.owners) assertRef("teams", o.team_id, `知识产权 ${ipr.id}`);
  }

  // 许可
  for (const lic of pack.licenses) {
    if (!findVersion(pack, lic.variety_version_id)) fail(`许可 ${lic.id} 引用了不存在的版本`);
    assertRef("teams", lic.licensee_id, `许可 ${lic.id}`);
    if (lic.start_date > lic.end_date) fail(`许可 ${lic.id} 的开始日期晚于结束日期`);
    if (!lic.consents?.length) fail(`许可 ${lic.id} 缺少共有人同意记录`);
    for (const c of lic.consents) assertRef("teams", c.team_id, `许可 ${lic.id} 的同意记录`);
  }

  // 企业授权
  for (const g of pack.enterprise_grants) {
    assertRef("teams", g.enterprise_id, `授权 ${g.id}`);
    for (const sc of g.scope) {
      if (!COLLECTIONS.includes(sc.resource_type)) fail(`授权 ${g.id} 含未知资料类型：${sc.resource_type}`);
      for (const rid of sc.resource_ids) {
        if (!index[sc.resource_type]?.has(rid)) fail(`授权 ${g.id} 引用了不存在的 ${sc.resource_type}：${rid}`);
      }
    }
  }

  // 推广反馈与销售批次
  for (const pf of pack.promotion_feedback) {
    assertRef("licenses", pf.license_id, `推广反馈 ${pf.id}`);
    if (pf.cultivation_package_id) assertRef("cultivation_packages", pf.cultivation_package_id, `推广反馈 ${pf.id}`);
    if (pf.follow_up_signal_id) assertRef("market_signals", pf.follow_up_signal_id, `推广反馈 ${pf.id}`);
  }
  for (const b of pack.sales_batches) {
    if (b.license_id) assertRef("licenses", b.license_id, `销售批次 ${b.id}`);
    if (!findVersion(pack, b.variety_version_id)) fail(`销售批次 ${b.id} 引用了不存在的版本`);
  }

  return errors;
}

export function buildIndex(pack) {
  const index = {};
  for (const key of COLLECTIONS) {
    index[key] = new Map((pack[key] ?? []).map((item) => [item.id, item]));
  }
  return index;
}

export function findVersion(pack, versionId) {
  for (const v of pack.varieties) {
    const ver = v.versions.find((x) => x.id === versionId);
    if (ver) return { variety: v, version: ver };
  }
  return null;
}
