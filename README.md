# 良种成果转化接力

保存种质材料、育种试验、审定许可和市场推广的连续关系，让企业需求前置到育种材料阶段，而不是品种审定后才第一次接触成果。

## 要回答的问题

- 某个市场销售的品种版本，血缘上来自哪些育种世代与种质来源？
- 哪一次育种决策是被哪条市场信息（或负面试验）改变的？
- 合作企业只能看到获准范围，其他团队的未公开材料如何不可见？
- 试验地时段是否被重复安排？联合育种品种权的对外许可是否取得全体共有人同意、区域是否超出审定适宜区？
- 品种更名后，旧批次标签如何识别？售出的种子能否证明来自获准版本、在许可区域与期限内？

## 领域资料

- `contracts/context.schema.json`：资料信封（domain / version / facts / sample_id）。
- `contracts/catalog.schema.json`：连续谱系目录契约，共 18 个业务集合。
- `fixtures/context.json`、`fixtures/catalog.json`：不含真实主体信息的虚构样例。编号均为虚构值，不含账号或凭据。

谱系主线：

```
种质 germplasm
  └─ 育种世代 breeding_generations（parent_ids 血缘链，含淘汰世代）
       ├─ 试验 trials（性状指标、达标/负面结果）× 试验地时段 trial_sites
       ├─ 育种决策 breeding_decisions ── 市场信息 market_signals（企业前置需求/推广反馈）
       └─ 品种版本 varieties[v]（不可变版本，联合育种标注团队）
             ├─ 名称 variety_names（含更名前后，按日期解析现行名）
             ├─ 审定登记 registrations（适宜区域）
             ├─ 品种权 plant_variety_rights（联合育种按份共有）
             ├─ 许可 licenses（类型/区域/期限/共有人同意）
             ├─ 配套栽培技术 cultivation_guides（按版本+区域聚合，不随团队散落）
             └─ 种子批次 seed_batches → 销售 sales（核验获准版本、区域、期限）
```

企业可见性由 `data_grants` 单独授权到种质/世代/品种版本；`enterpriseView` 对未获准血缘节点做脱敏（不返回编号与名称），已公开种质默认可见。

## 代码模块

- `src/schema.js`：零依赖的小型 JSON Schema 校验器（仅实现契约用到的关键字）。
- `src/context.js`：读取信封资料。
- `src/catalog.js`：目录解析与领域查询：
  - `checkIntegrity()` 跨集合引用完整性（亲本、时段、版本、许可/批次对应、共有份额合计 100 等）；
  - `lineage()` 品种版本血缘回溯；
  - `explainDecision()` / `decisionsDrivenBySignal()` 解释市场信息改变了哪次决策；
  - `negativeTrials()` 负面试验与据此作出的淘汰决策；
  - `checkScheduling()` 试验地时段双订与预约对账；
  - `checkLicense()` 独占/排他冲突、共有人同意、超审定适宜区；
  - `enterpriseView(id)` 企业获准视图与脱敏血缘；
  - `verifyBatch()` / `verifySale()` 批次与销售核验（未审定版本制种、旧名标签、非被许可企业、越区、超期等）。

业务规则问题以问题清单返回而不是中断加载，因此同一份样例同时承载正例与反例。

## 本地校验

```bash
npm test
```

样例中的正例：丰禾种业排他许可 v1「金早丰」、批次 bat-001、销售 sal-001 全链核验通过。
样例中刻意保留的反例（均由对应测试断言检出）：

- 2025 年春永州试点被水稻与玉米两个团队双订；
- 姊妹系 21F2-19 旱作负面淘汰，并据此终止世代；
- v1 排他许可与第二份普通许可并存、后者缺 40% 共有人同意且区域超出审定适宜区；
- 品种更名后 bat-002 仍用旧名「试24优」；
- bat-003 用在试 v2 版本制种且套用 v1 许可；
- sal-004 由无许可企业销售，sal-005 越出许可与审定适宜区域。
