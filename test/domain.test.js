import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parsePack, validatePack } from "../src/pack.js";
import { materialAncestry, versionLineage, evidenceTimeline } from "../src/lineage.js";
import { findSchedulingConflicts, evaluateBooking } from "../src/scheduling.js";
import {
  consentStatus,
  findLicenseConflicts,
  evaluateLicense,
  verifySalesBatch,
} from "../src/licensing.js";
import { visibleView, checkGrantSafety, grantFor } from "../src/access.js";
import { explainDecision, traceSignalImpact, feedbackLoop } from "../src/market-trace.js";

const loadPack = async () =>
  parsePack(await readFile(new URL("../fixtures/domain-pack.json", import.meta.url), "utf8"));

test("样例资料包结构完整、引用闭合", async () => {
  const pack = await loadPack();
  assert.equal(pack.domain, "seed-commercialization");
  assert.equal(pack.version, 2);
  assert.deepEqual(validatePack(pack), []);
});

test("连续谱系：从审定版本回溯到地方品种与野生抗源，世代齐全", async () => {
  const pack = await loadPack();
  const lineage = versionLineage(pack, "vv-001-1");
  const ids = lineage.material_chain.map((g) => g.id);
  assert.deepEqual(ids, ["g-001", "g-002", "g-003", "g-004", "g-005", "g-007"]);
  assert.deepEqual(
    lineage.material_chain.map((g) => g.generation_label),
    ["P", "P", "F1", "BC1F1", "F5", "F6"],
  );
  // 名称沿革保留株系名、原审定名与更名记录
  assert.equal(lineage.current_name, "仓粳优1号");
  assert.ok(lineage.name_history.some((n) => n.name === "苏仓粳1号" && n.type === "审定名"));
  assert.ok(lineage.name_history.some((n) => n.type === "更名"));
  // 审定区域与配套栽培技术随版本归集，不再散落各团队
  assert.ok(lineage.registrations.some((r) => r.regions.includes("长江中下游")));
  assert.ok(lineage.cultivation_packages.some((c) => c.id === "cp-02" && c.techniques.length > 0));
});

test("阴性试验留在证据链中，被淘汰的姊妹系不出现在报审版本谱系内", async () => {
  const pack = await loadPack();
  const chain = materialAncestry(pack, "g-005").map((g) => g.id);
  assert.ok(!chain.includes("g-006"), "阴性淘汰材料不得混入报审材料谱系");

  const timeline = evidenceTimeline(pack, "vv-001-0").map((e) => e.ref);
  assert.ok(timeline.includes("ft-01"));
  assert.ok(timeline.includes("d-04"));
  assert.ok(!timeline.includes("ft-neg-01"));

  const negTrial = pack.field_trials.find((t) => t.id === "ft-neg-01");
  assert.equal(negTrial.outcome, "阴性");
  assert.match(negTrial.consequence, /淘汰/);
  assert.equal(negTrial.resulting_decision_id, "d-05");
});

test("试验地排期：重叠申请被驳回，且驳回记录不占用时段", async () => {
  const pack = await loadPack();
  // 样例中 bk-02 与 bk-01 同地块时段重叠；因为 bk-02 已驳回，现存排期无冲突
  assert.deepEqual(findSchedulingConflicts(pack), []);
  const rejected = pack.plot_bookings.find((b) => b.id === "bk-02");
  assert.equal(rejected.status, "已驳回");
  assert.match(rejected.rejected_reason, /bk-01/);

  const overlap = evaluateBooking(pack, {
    id: "bk-new",
    plot_id: "plot-1",
    start_date: "2023-08-01",
    end_date: "2023-09-10",
  });
  assert.equal(overlap.status, "已驳回");
  assert.match(overlap.rejected_reason, /bk-01/);

  const otherPlot = evaluateBooking(pack, {
    id: "bk-new2",
    plot_id: "plot-2",
    start_date: "2023-06-10",
    end_date: "2023-09-30",
  });
  assert.equal(otherPlot.status, "已排定");
});

test("许可同意：联合育种成果须全体共有人书面同意", async () => {
  const pack = await loadPack();
  const lic02 = pack.licenses.find((l) => l.id === "lic-02");
  const status = consentStatus(pack, lic02);
  assert.equal(status.required_rule, "全体共有人书面同意");
  assert.equal(status.complete, false);
  assert.ok(status.missing.some((n) => n.includes("禾丰")));

  const lic01 = pack.licenses.find((l) => l.id === "lic-01");
  assert.equal(consentStatus(pack, lic01).complete, true);
});

test("许可冲突：独占许可区域期限内的重复许可被驳回", async () => {
  const pack = await loadPack();
  // 样例中现行许可区域/版本互不重叠
  assert.deepEqual(findLicenseConflicts(pack, { asOf: "2026-08-01" }), []);

  const apply = (regions, type = "普通") =>
    evaluateLicense(pack, {
      id: "lic-apply",
      variety_version_id: "vv-001-0",
      licensee_id: "ent-l",
      license_type: type,
      regions,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      consents: [
        { team_id: "team-a", consented: true },
        { team_id: "ent-h", consented: true },
      ],
    });

  const blocked = apply(["黄淮稻区"]);
  assert.equal(blocked.status, "驳回");
  assert.ok(blocked.blockers.some((b) => b.includes("lic-01")));

  // 再申请一份独占许可同样互斥；同意齐备也不能越过独占冲突
  const exclusiveBlocked = apply(["黄淮稻区"], "独占");
  assert.equal(exclusiveBlocked.status, "驳回");
});

test("销售溯源：合法批次可证明来自获准版本", async () => {
  const pack = await loadPack();
  const ok = verifySalesBatch(pack, "sb-ok", { asOf: "2026-03-10" });
  assert.equal(ok.compliant, true);
  assert.equal(ok.provenance.variety, "仓粳优1号");
  assert.equal(ok.provenance.version_id, "vv-001-0");
  assert.ok(ok.provenance.registered_regions.includes("黄淮稻区"));

  const ok2 = verifySalesBatch(pack, "sb-ok2");
  assert.equal(ok2.compliant, true);
  assert.equal(ok2.provenance.version_id, "vv-001-1");
});

test("销售溯源：过期许可、越区销售、未审定版本均判不合规", async () => {
  const pack = await loadPack();

  const expired = verifySalesBatch(pack, "sb-bad-expired");
  assert.equal(expired.compliant, false);
  assert.ok(expired.violations.some((v) => v.code === "LICENSE_EXPIRED"));
  assert.ok(expired.violations.some((v) => v.code === "LICENSE_NOT_ACTIVE"));

  const outOfRegion = verifySalesBatch(pack, "sb-bad-region");
  assert.equal(outOfRegion.compliant, false);
  assert.ok(outOfRegion.violations.some((v) => v.code === "REGION_NOT_LICENSED"));

  const unregistered = verifySalesBatch(pack, "sb-bad-version");
  assert.equal(unregistered.compliant, false);
  const codes = unregistered.violations.map((v) => v.code);
  assert.ok(codes.includes("VERSION_NOT_REGISTERED"));
  assert.ok(codes.includes("REGISTRATION_MISSING"));
  assert.ok(codes.includes("LICENSE_MISSING"));
});

test("企业视图：只能看到获准范围，看不到其他团队未公开材料", async () => {
  const pack = await loadPack();
  assert.deepEqual(checkGrantSafety(pack), []);

  const hView = visibleView(pack, "ent-h");
  const germIds = hView.collections.germplasm.map((g) => g.id);
  assert.deepEqual(germIds, ["g-003", "g-004", "g-005", "g-007"]);
  assert.ok(!germIds.includes("g-006"));
  assert.ok(!germIds.includes("g-008"));
  assert.ok(!germIds.includes("g-001"), "其他团队的未公开亲本不在授权清单");

  const lView = visibleView(pack, "ent-l");
  assert.equal(lView.collections.germplasm, undefined, "审定后接触的企业看不到任何育种世代材料");
  assert.deepEqual(
    lView.collections.varieties.map((v) => v.id),
    ["v-001"],
  );
  assert.equal(lView.collections.field_trials, undefined);
});

test("授权安全：把合作谱系外的未公开材料授权给企业会被发现", async () => {
  const pack = await loadPack();
  const grant = grantFor(pack, "ent-l");
  grant.scope.push({ resource_type: "germplasm", resource_ids: ["g-006"] });
  const errors = checkGrantSafety(pack);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /g-006/);
});

test("市场信息前置：企业需求在材料阶段改变了具体育种决策", async () => {
  const pack = await loadPack();
  const d03 = explainDecision(pack, "d-03");
  assert.equal(d03.action, "定向选择");
  assert.deepEqual(d03.triggered_by.map((s) => s.signal_id), ["ms-01"]);
  assert.ok(d03.triggered_by[0].demand_traits.includes("耐低氧出苗"));
  assert.match(d03.rationale, /直播/);

  const impact = traceSignalImpact(pack, "ms-01");
  assert.deepEqual(impact.changed_decisions.map((d) => d.id), ["d-03", "d-04"]);
  assert.ok(impact.resulting_materials.includes("g-005"));
  const registered = impact.resulting_versions.find((v) => v.version_id === "vv-001-0");
  assert.ok(registered);
  assert.equal(registered.status, "已审定");
});

test("推广反馈闭环：负面反馈回流为信号并改变耐热改良决策", async () => {
  const pack = await loadPack();
  const loop = feedbackLoop(pack, "pf-01");
  assert.equal(loop.closed, true);
  assert.equal(loop.signal_id, "ms-02");
  assert.ok(loop.negative_findings.some((x) => x.includes("花期耐热")));
  assert.deepEqual(loop.impact.changed_decisions.map((d) => d.id), ["d-06"]);

  const vv = loop.impact.resulting_versions.find((v) => v.version_id === "vv-001-1");
  assert.ok(vv, "反馈驱动的改良最终形成已审定扩区版本");
  assert.ok(vv.registrations[0].regions.includes("长江中下游"));
});
