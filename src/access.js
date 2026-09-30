// 企业授权视图：合作企业只能查看获准范围，且授权范围不得暴露其他团队的未公开材料。

import { materialAncestry } from "./lineage.js";

export function grantFor(pack, enterpriseId) {
  return pack.enterprise_grants.find((g) => g.enterprise_id === enterpriseId) ?? null;
}

// 依据授权清单裁剪资料包，返回企业可见的子集；清单之外的记录一律不出现。
export function visibleView(pack, enterpriseId) {
  const grant = grantFor(pack, enterpriseId);
  const view = { enterprise_id: enterpriseId, granted_via: grant?.granted_via ?? null, collections: {} };
  if (!grant) return view;

  for (const sc of grant.scope) {
    const allow = new Set(sc.resource_ids);
    view.collections[sc.resource_type] = (pack[sc.resource_type] ?? []).filter((item) => allow.has(item.id));
  }
  return view;
}

// 安全核验：被授权的种质若为未公开，必须有联合育种关系支撑，
// 即企业参与的协议所产出材料位于其亲本链或衍生链上。
export function checkGrantSafety(pack) {
  const errors = [];
  const byId = new Map(pack.germplasm.map((g) => [g.id, g]));

  // 预计算：材料 id → 经由联合协议可合法接触该材料的企业集合
  const accessibleByJoint = new Map();
  for (const ja of pack.joint_agreements) {
    const enterprises = ja.parties.map((p) => p.team_id);
    const closure = new Set(materialAncestry(pack, ja.resulting_material_id).map((g) => g.id));
    closure.add(ja.resulting_material_id);
    // 衍生材料（由协议成果继续选育而来）同样在合作谱系内
    for (const g of pack.germplasm) {
      if (closure.has(g.id)) continue;
      if (materialAncestry(pack, g.id).some((a) => a.id === ja.resulting_material_id)) closure.add(g.id);
    }
    for (const id of closure) {
      if (!accessibleByJoint.has(id)) accessibleByJoint.set(id, new Set());
      for (const e of enterprises) accessibleByJoint.get(id).add(e);
    }
  }

  for (const grant of pack.enterprise_grants) {
    const sc = grant.scope.find((s) => s.resource_type === "germplasm");
    if (!sc) continue;
    for (const id of sc.resource_ids) {
      const g = byId.get(id);
      if (!g || g.disclosure !== "未公开") continue;
      if (g.holder_team === grant.enterprise_id) continue;
      if (accessibleByJoint.get(id)?.has(grant.enterprise_id)) continue;
      errors.push(
        `授权 ${grant.id} 向企业 ${grant.enterprise_id} 暴露了其他团队的未公开材料 ${id}，且无联合育种协议支撑`,
      );
    }
  }
  return errors;
}
