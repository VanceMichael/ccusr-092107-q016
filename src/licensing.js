// 许可规则：共有人书面同意、许可类型冲突、期限与区域，以及销售批次溯源。

import { buildIndex, findVersion } from "./pack.js";

const ACTIVE = new Set(["有效"]);

function overlap(a, b) {
  return a.start_date <= b.end_date && b.start_date <= a.end_date;
}

// 联合育种成果对外许可所需的同意是否齐备。
export function consentStatus(pack, license) {
  const idx = buildIndex(pack);
  const ipr = pack.ip_rights.find(
    (x) => x.variety_version_id === license.variety_version_id && x.status === "授权",
  );
  if (!ipr) return { required_rule: null, missing: [], complete: false, reason: "对应版本没有授权品种权，无法核验共有人同意" };

  const ja = idx.joint_agreements.get(ipr.agreement_id);
  const required = new Set(ja.parties.map((p) => p.team_id));
  const consented = new Set(
    (license.consents ?? []).filter((c) => c.consented).map((c) => c.team_id),
  );
  const teams = idx.teams;
  const missing = [...required]
    .filter((id) => !consented.has(id))
    .map((id) => teams.get(id)?.name ?? id);

  return {
    required_rule: ja.consent_rule,
    missing,
    complete: missing.length === 0,
  };
}

// 找出许可之间的类型冲突：同一版本、时段重叠、区域相交时，
// 独占许可与任何其他许可互斥（含两个独占）。
export function findLicenseConflicts(pack, { asOf } = {}) {
  const conflicts = [];
  const lics = pack.licenses.filter(
    (l) => ACTIVE.has(l.status) && (!asOf || (l.start_date <= asOf && asOf <= l.end_date)),
  );
  for (let i = 0; i < lics.length; i++) {
    for (let j = i + 1; j < lics.length; j++) {
      const a = lics[i];
      const b = lics[j];
      if (a.variety_version_id !== b.variety_version_id) continue;
      if (!overlap(a, b)) continue;
      const regionHit = a.regions.some((r) => b.regions.includes(r));
      if (!regionHit) continue;
      if (a.license_type === "独占" || b.license_type === "独占") {
        conflicts.push({
          license_a: a.id,
          license_b: b.id,
          version: a.variety_version_id,
          regions: a.regions.filter((r) => b.regions.includes(r)),
          reason: `独占许可 ${a.license_type === "独占" ? a.id : b.id} 的区域/期限内存在另一项许可`,
        });
      }
    }
  }
  return conflicts;
}

// 平台受理一项新许可申请：共有人同意齐备，且不与现行有效许可发生独占冲突时方可生效。
export function evaluateLicense(pack, candidate) {
  const blockers = [];
  const found = findVersion(pack, candidate.variety_version_id);
  if (!found) blockers.push("对应品种版本不存在");
  else if (found.version.status !== "已审定") blockers.push("对应版本尚未审定");

  const consent = consentStatus(pack, candidate);
  if (!found || !pack.ip_rights.some((x) => x.variety_version_id === candidate.variety_version_id && x.status === "授权")) {
    if (consent.reason) blockers.push(consent.reason);
  } else if (!consent.complete) {
    blockers.push(`缺少共有人书面同意：${consent.missing.join("、")}`);
  }

  for (const lic of pack.licenses) {
    if (!ACTIVE.has(lic.status)) continue;
    if (lic.variety_version_id !== candidate.variety_version_id) continue;
    if (!overlap(lic, candidate)) continue;
    const regionHit = lic.regions.some((r) => candidate.regions.includes(r));
    if (!regionHit) continue;
    if (lic.license_type === "独占" || candidate.license_type === "独占") {
      blockers.push(`与现行${lic.license_type === "独占" ? "独占" : ""}许可 ${lic.id} 在期限 ${lic.start_date}~${lic.end_date}、区域 ${lic.regions.join("、")} 上冲突`);
    }
  }

  return { status: blockers.length ? "驳回" : "准予生效", blockers };
}

// 核验一个销售批次：能否证明所售种子来自获准版本。
export function verifySalesBatch(pack, batchId, { asOf } = {}) {
  const idx = buildIndex(pack);
  const batch = idx.sales_batches.get(batchId);
  if (!batch) throw new Error(`销售批次不存在：${batchId}`);

  const on = asOf ?? batch.date;
  const add = (code, detail) => violations.push({ code, detail });
  const violations = [];

  const found = findVersion(pack, batch.variety_version_id);
  if (!found) add("VERSION_UNKNOWN", "版本不存在");
  const version = found?.version;

  if (version && version.status !== "已审定") {
    add("VERSION_NOT_REGISTERED", `版本 ${version.id}（${version.label}）尚未审定，不得作为销售种子`);
  }

  const reg = pack.registrations.find(
    (r) => r.variety_version_id === batch.variety_version_id && r.status === "有效",
  );
  if (!reg) {
    add("REGISTRATION_MISSING", "该版本没有有效审定登记");
  } else if (!reg.regions.includes(batch.region)) {
    add("REGION_OUT_OF_SCOPE", `销售区域 ${batch.region} 不在审定区域 ${reg.regions.join("、")} 内`);
  }

  if (!batch.license_id) {
    add("LICENSE_MISSING", "销售批次未关联任何许可");
  } else {
    const lic = idx.licenses.get(batch.license_id);
    if (!lic) {
      add("LICENSE_MISSING", "关联许可不存在");
    } else {
      if (lic.variety_version_id !== batch.variety_version_id) {
        add("LICENSE_VERSION_MISMATCH", `许可 ${lic.id} 授权的是另一版本`);
      }
      if (lic.status !== "有效") add("LICENSE_NOT_ACTIVE", `许可 ${lic.id} 状态为 ${lic.status}`);
      if (on < lic.start_date || on > lic.end_date) {
        add("LICENSE_EXPIRED", `销售日期 ${on} 不在许可期限 ${lic.start_date}~${lic.end_date} 内`);
      }
      if (!lic.regions.includes(batch.region)) {
        add("REGION_NOT_LICENSED", `销售区域 ${batch.region} 不在许可区域 ${lic.regions.join("、")} 内`);
      }
      const consent = consentStatus(pack, lic);
      if (!consent.complete) add("CONSENT_INCOMPLETE", `缺少共有人同意：${consent.missing.join("、") || consent.reason}`);
    }
  }

  return {
    batch_id: batch.id,
    compliant: violations.length === 0,
    violations,
    provenance: found
      ? {
          variety: found.variety.current_name,
          version: version.label,
          version_id: version.id,
          registered_regions: reg?.regions ?? [],
          license_id: batch.license_id,
        }
      : null,
  };
}
