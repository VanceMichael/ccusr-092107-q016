// 市场信息 → 育种决策 的可解释链条：
// 企业需求（含推广反馈回流）在材料阶段如何改变具体决策，以及决策产出的世代与后续结果。

import { buildIndex } from "./pack.js";

// 解释一次育种决策受到哪些市场信息/试验影响。
export function explainDecision(pack, decisionId) {
  const idx = buildIndex(pack);
  const d = idx.breeding_decisions.get(decisionId);
  if (!d) throw new Error(`决策不存在：${decisionId}`);

  const signals = (d.based_on_signal_ids ?? []).map((id) => {
    const s = idx.market_signals.get(id);
    return {
      signal_id: id,
      date: s.date,
      source: s.sourced_from_feedback
        ? `推广反馈 ${s.sourced_from_feedback} 回流`
        : `企业 ${s.source_enterprise ?? "未知"} 前置提出`,
      content: s.content,
      demand_traits: s.demand_traits,
    };
  });
  const trials = (d.based_on_trial_ids ?? []).map((id) => {
    const t = idx.field_trials.get(id);
    return { trial_id: id, outcome: t.outcome, findings: t.findings };
  });

  return {
    decision_id: d.id,
    date: d.date,
    action: d.action,
    target_material: d.material_id,
    output_material: d.output_material_id ?? null,
    triggered_by: signals,
    grounded_in_trials: trials,
    rationale: d.rationale,
  };
}

// 从一条市场信号正向追踪：它改变了哪些决策，产出了哪一代材料，最终落到哪个品种版本/审定。
export function traceSignalImpact(pack, signalId) {
  const idx = buildIndex(pack);
  if (!idx.market_signals.has(signalId)) throw new Error(`市场信号不存在：${signalId}`);

  const decisions = pack.breeding_decisions.filter((d) => (d.based_on_signal_ids ?? []).includes(signalId));
  const materials = new Set();
  for (const d of decisions) {
    if (d.output_material_id) materials.add(d.output_material_id);
    materials.add(d.material_id);
  }

  const resulting_versions = [];
  for (const v of pack.varieties) {
    for (const ver of v.versions) {
      if (materials.has(ver.material_id)) {
        const regs = pack.registrations.filter((r) => r.variety_version_id === ver.id);
        resulting_versions.push({
          variety: v.current_name,
          version_id: ver.id,
          label: ver.label,
          status: ver.status,
          registrations: regs.map((r) => ({ cert_no: r.cert_no, regions: r.regions, date: r.decision_date })),
        });
      }
    }
  }

  return {
    signal_id: signalId,
    changed_decisions: decisions.map((d) => ({ id: d.id, action: d.action, date: d.date, rationale: d.rationale })),
    resulting_materials: [...materials],
    resulting_versions,
  };
}

// 推广反馈闭环：反馈 → 市场信号 → 决策 → 新材料/版本。
export function feedbackLoop(pack, feedbackId) {
  const idx = buildIndex(pack);
  const pf = idx.promotion_feedback.get(feedbackId);
  if (!pf) throw new Error(`推广反馈不存在：${feedbackId}`);
  if (!pf.follow_up_signal_id) return { feedback_id: feedbackId, closed: false, note: "该反馈尚未转化为市场信号" };

  const impact = traceSignalImpact(pack, pf.follow_up_signal_id);
  return {
    feedback_id: feedbackId,
    closed: impact.changed_decisions.length > 0,
    negative_findings: pf.performance.filter((p) => p.assessment === "差").map((p) => `${p.indicator}：${p.value ?? ""}`),
    signal_id: pf.follow_up_signal_id,
    impact,
  };
}
