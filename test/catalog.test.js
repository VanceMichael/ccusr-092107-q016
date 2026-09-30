import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseContext } from "../src/context.js";
import { parseCatalog } from "../src/catalog.js";
import { validate } from "../src/schema.js";
import contextSchema from "../contracts/context.schema.json" with { type: "json" };
import catalogSchema from "../contracts/catalog.schema.json" with { type: "json" };

const load = async () => {
  const [ctxRaw, catRaw] = await Promise.all([
    readFile(new URL("../fixtures/context.json", import.meta.url), "utf8"),
    readFile(new URL("../fixtures/catalog.json", import.meta.url), "utf8")
  ]);
  return { ctxRaw, catRaw, context: parseContext(ctxRaw), catalog: parseCatalog(catRaw) };
};

test("信封资料：领域标识、版本与事实完整且符合契约", async () => {
  const { context } = await load();
  assert.equal(context.domain, "seed-commercialization");
  assert.ok(context.version >= 2);
  assert.ok(context.facts.length >= 3);
  assert.deepEqual(validate(contextSchema, context), []);
});

test("谱系目录符合契约且引用完整", async () => {
  const { catalog, catRaw } = await load();
  assert.deepEqual(validate(catalogSchema, JSON.parse(catRaw)), []);
  assert.deepEqual(catalog.checkIntegrity(), []);
});

test("连续谱系：品种版本可回溯到世代、亲本与种质来源", async () => {
  const { catalog } = await load();
  const chain = catalog.lineage("var-jingzao", "v1");
  const ids = chain.map((n) => n.id);
  // 定型株系 → 回交世代 → F2/F1 → 地方种、引进系、抗性供体
  assert.ok(ids.includes("gen-stable-2023"));
  assert.ok(ids.includes("gen-bc1-2022"));
  assert.ok(ids.includes("ger-local"));
  assert.ok(ids.includes("ger-intro"));
  assert.ok(ids.includes("ger-donor"));
  // 深度方向：种质应比世代离根更远
  const local = chain.find((n) => n.id === "ger-local");
  const stable = chain.find((n) => n.id === "gen-stable-2023");
  assert.ok(local.depth > stable.depth);
});

test("负面试验被保留，并支撑终止世代决策", async () => {
  const { catalog } = await load();
  const negatives = catalog.negativeTrials();
  const tri002 = negatives.find((n) => n.trial.id === "tri-002");
  assert.ok(tri002, "tri-002 旱作负面试验应被检出");
  assert.equal(tri002.trial.indicators.every((i) => !i.meets_target), true);
  assert.equal(tri002.decisions.some((d) => d.action === "终止世代"), true);
  // 被负面试验淘汰的姊妹系没有进入任何品种版本
  const chain = catalog.lineage("var-jingzao", "v1").map((n) => n.id);
  assert.ok(!chain.includes("gen-sib-upland"));
});

test("市场信息前置：材料阶段的需求改变了具体育种决策", async () => {
  const { catalog } = await load();
  const explained = catalog.explainDecision("dec-001");
  assert.equal(explained.based_on_signals[0].id, "sig-001");
  assert.match(explained.narrative, /抢早/);

  // 同一条企业前置需求能反查它影响过的决策
  const driven = catalog.decisionsDrivenBySignal("sig-001");
  assert.ok(driven.some((d) => d.decision.id === "dec-001"));
});

test("推广反馈闭环：田间反馈→市场信息→新一轮育种决策", async () => {
  const { catalog } = await load();
  const fb = catalog.data.promotion_feedbacks.find((f) => f.id === "fb-001");
  assert.equal(fb.resulted_signal_id, "sig-003");
  const driven = catalog.decisionsDrivenBySignal("sig-003");
  const dec005 = driven.find((d) => d.decision.id === "dec-005");
  assert.ok(dec005, "机收落粒反馈应回流到 2025 轮的抗落粒选择决策");
  assert.equal(dec005.decision.generation_id, "gen-cycle2-2025");
});

test("试验地时段冲突可被发现：同一春播时段被两个团队双订", async () => {
  const { catalog } = await load();
  const findings = catalog.checkScheduling();
  const double = findings.find((f) => f.code === "SLOT_DOUBLE_BOOKED");
  assert.ok(double, "永州试点 2025 春季应被检出双订");
  assert.equal(double.slot_id, "slot-yz-2025-spring");
  assert.ok(double.trial_ids.includes("tri-004"));
  assert.ok(double.trial_ids.includes("tri-005"));
  assert.ok(findings.some((f) => f.code === "SLOT_TEAM_CONFLICT" && f.trial_id === "tri-004"));
});

test("联合育种：品种权按份共有，份额合计 100", async () => {
  const { catalog } = await load();
  const pvr = catalog.rightsFor("var-jingzao", "v1");
  assert.equal(pvr.owners.length, 2);
  assert.equal(pvr.owners.reduce((a, o) => a + o.share, 0), 100);
  const ver = catalog.version("var-jingzao", "v1");
  assert.equal(ver.joint_breeding, true);
});

test("许可核验：排他许可与第二份许可冲突；缺共有人同意；区域超审定范围", async () => {
  const { catalog } = await load();
  const lic1 = catalog.checkLicense("lic-001");
  // lic-001 自身共有人同意齐备，但与 lic-002 构成排他/普通并存冲突
  assert.ok(lic1.some((f) => f.code === "LICENSE_EXCLUSIVITY_CONFLICT" && f.conflicting_license_id === "lic-002"));
  assert.ok(!lic1.some((f) => f.code === "LICENSE_MISSING_CO_OWNER_CONSENT"));

  const lic2 = catalog.checkLicense("lic-002");
  assert.ok(lic2.some((f) => f.code === "LICENSE_MISSING_CO_OWNER_CONSENT" && f.team_id === "team-rice-b"),
    "40% 共有人未同意应被检出");
  assert.ok(lic2.some((f) => f.code === "LICENSE_EXCLUSIVITY_CONFLICT" && f.conflicting_license_id === "lic-001"));
  assert.ok(lic2.some((f) => f.code === "LICENSE_REGION_OUTSIDE_ADAPTATION"),
    "R-EAST 不在审定适宜区域内应被检出");
});

test("品种更名：现行名称解析正确，历史名称仍可追溯到品种", async () => {
  const { catalog } = await load();
  assert.equal(catalog.currentName("var-jingzao", "2024-01-01"), "试24优");
  assert.equal(catalog.currentName("var-jingzao", "2025-03-01"), "金早丰");
  const rename = catalog.explainDecision("dec-004");
  assert.equal(rename.decision.action, "更名");
  assert.equal(rename.decision.variety_id, "var-jingzao");
});

test("授权隔离：丰禾只能看获准材料，看不到玉米团队与水稻实验室未公开种质", async () => {
  const { catalog } = await load();
  const view = catalog.enterpriseView("ent-seedco");
  const gerIds = view.germplasm.map((g) => g.id);
  assert.ok(gerIds.includes("ger-local"));
  assert.ok(gerIds.includes("ger-intro"), "已公开引进系默认可见");
  assert.ok(!gerIds.includes("ger-donor"), "其他团队未公开抗性供体不可见");
  assert.ok(!gerIds.includes("ger-maize"), "其他团队未公开玉米种质不可见");

  const genIds = view.generations.map((g) => g.id);
  assert.ok(genIds.includes("gen-stable-2023"));
  assert.ok(!genIds.includes("gen-maize-01"));
  assert.ok(!genIds.includes("gen-cycle2-2025"), "在育新一轮群体不在授权范围");
  assert.ok(!view.variety_versions.some((v) => v.variety_id === "var-maize-7"));
  // 试验记录同样只限获准世代
  assert.ok(!view.trials.some((t) => t.id === "tri-004"));
});

test("授权视图中的血缘：未获准亲本以脱敏节点出现，不暴露编号与名称", async () => {
  const { catalog } = await load();
  const view = catalog.enterpriseView("ent-seedco");
  const chain = view.lineageOf("gen-bc1-2022");
  // gen-bc1-2022 的亲本之一 ger-donor 未授权
  assert.ok(chain.some((n) => n.kind === "redacted"), "未授权亲本应被脱敏");
  const donor = chain.find((n) => n.id === "ger-donor");
  assert.equal(donor, undefined);
  assert.ok(!JSON.stringify(chain).includes("BL-7"), "脱敏链不得泄露未公开材料名称");
  // 获准亲本正常可见
  assert.ok(chain.some((n) => n.id === "gen-f2-2021"));
});

test("无授权企业：除已公开种质外看不到任何谱系内容", async () => {
  const { catalog } = await load();
  const view = catalog.enterpriseView("ent-outsider");
  assert.deepEqual(view.generations, []);
  assert.deepEqual(view.variety_versions, []);
  assert.deepEqual(view.cultivation_guides, []);
  assert.equal(view.germplasm.every((g) => g.public_status === "已公开"), true);
});

test("配套栽培技术随品种版本和区域集中沉淀，不随团队散落", async () => {
  const { catalog } = await load();
  const guides = catalog.data.cultivation_guides.filter(
    (g) => g.variety_id === "var-jingzao" && g.version_no === "v1" && g.region_code === "R-SOUTH"
  );
  const teams = new Set(guides.map((g) => g.team_id));
  assert.ok(teams.has("team-rice-a"));
  assert.ok(teams.has("team-rice-b"), "两个团队的配套技术在同一品种版本+区域下聚合");
});

test("批次核验：合规批次通过；旧名标签批次被标记", async () => {
  const { catalog } = await load();
  const ok = catalog.verifyBatch("bat-001");
  assert.deepEqual(ok.findings, []);

  const stale = catalog.verifyBatch("bat-002");
  assert.ok(stale.findings.some((f) => f.code === "BATCH_STALE_LABEL_NAME"));
  assert.match(stale.findings[0].message, /金早丰/);
});

test("批次核验：未审定版本制种、许可版本不符均被标记", async () => {
  const { catalog } = await load();
  const bat3 = catalog.verifyBatch("bat-003");
  assert.ok(bat3.findings.some((f) => f.code === "BATCH_UNREGISTERED_VERSION"), "v2 在试版本不得商品制种");
  assert.ok(bat3.findings.some((f) => f.code === "BATCH_LICENSE_VERSION_MISMATCH"), "lic-002 是 v1 许可不能支撑 v2 批次");
});

test("销售核验：正规销售可证明来自获准版本、区域与期限", async () => {
  const { catalog } = await load();
  const sal1 = catalog.verifySale("sal-001");
  assert.deepEqual(sal1.findings, []);
  assert.equal(sal1.version_no, "v1");
  assert.equal(sal1.license.id, "lic-001");
});

test("销售核验：无许可企业销售、旧名批次、越区等问题全部可追溯", async () => {
  const { catalog } = await load();
  const sal2 = catalog.verifySale("sal-002");
  assert.ok(sal2.findings.some((f) => f.code === "BATCH_STALE_LABEL_NAME"));

  const sal3 = catalog.verifySale("sal-003");
  assert.ok(sal3.findings.some((f) => f.code === "BATCH_UNREGISTERED_VERSION"),
    "在试 v2 批次流出销售同样应被拦截");

  const sal5 = catalog.verifySale("sal-005");
  assert.ok(sal5.findings.some((f) => f.code === "SALE_REGION_OUTSIDE_ADAPTATION"),
    "R-EAST 超出审定适宜区域");
  assert.ok(sal5.findings.some((f) => f.code === "SALE_REGION_OUTSIDE_LICENSE"),
    "R-EAST 也不在许可授权区域内");

  const sal4 = catalog.verifySale("sal-004");
  assert.ok(sal4.findings.some((f) => f.code === "SALE_BY_NON_LICENSEE"),
    "远途贸易不是被许可企业");
});

test("畸形资料无法通过校验：坏日期、未知枚举、份额越界均报错", () => {
  assert.deepEqual(validate(catalogSchema, JSON.parse(JSON.stringify({
    teams: [], enterprises: [], germplasm: [], breeding_generations: [],
    trial_sites: [], trials: [], market_signals: [], breeding_decisions: [],
    varieties: [], variety_names: [], registrations: [], plant_variety_rights: [],
    licenses: [], data_grants: [], cultivation_guides: [], promotion_feedbacks: [],
    seed_batches: [], sales: []
  }))), []);

  const badDate = { market_signals: [{ id: "sig-x", enterprise_id: "ent-x", received_date: "2025-13-40",
    channel: "订单咨询", summary: "x", demands: [] }] };
  assert.ok(validate(catalogSchema, {
    ...emptyCatalog(), ...badDate
  }).some((e) => e.includes("YYYY-MM-DD")));

  const badShare = { plant_variety_rights: [{ id: "pvr-x", variety_id: "var-x", version_no: "v1",
    number: "n", status: "授权", owners: [{ team_id: "team-x", share: 120 }] }] };
  assert.ok(validate(catalogSchema, { ...emptyCatalog(), ...badShare }).length > 0);
});

function emptyCatalog() {
  return {
    teams: [], enterprises: [], germplasm: [], breeding_generations: [],
    trial_sites: [], trials: [], market_signals: [], breeding_decisions: [],
    varieties: [], variety_names: [], registrations: [], plant_variety_rights: [],
    licenses: [], data_grants: [], cultivation_guides: [], promotion_feedbacks: [],
    seed_batches: [], sales: []
  };
}
