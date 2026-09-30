import { readFileSync } from "node:fs";
import { validate } from "./schema.js";

const catalogSchema = JSON.parse(
  readFileSync(new URL("../contracts/catalog.schema.json", import.meta.url), "utf8")
);

const VERSION_KEY = (varietyId, versionNo) => `${varietyId}@${versionNo}`;

// 读取并校验谱系目录：先做契约结构校验，再做跨集合引用完整性校验。
// 业务规则冲突（许可冲突、越区销售等）不在此抛出，由各 check* 方法返回问题清单，
// 这样同一份资料可以同时承载正例与反例。
export function parseCatalog(rawText) {
  const value = JSON.parse(rawText);
  const schemaErrors = validate(catalogSchema, value);
  if (schemaErrors.length > 0) {
    throw new Error(`谱系目录不符合契约：\n${schemaErrors.map((e) => `- ${e}`).join("\n")}`);
  }
  const catalog = new Catalog(value);
  const integrityErrors = catalog.checkIntegrity();
  if (integrityErrors.length > 0) {
    throw new Error(`谱系目录引用不完整：\n${integrityErrors.map((e) => `- ${e}`).join("\n")}`);
  }
  return catalog;
}

class Catalog {
  constructor(data) {
    this.data = data;
    this.teams = index(data.teams);
    this.enterprises = index(data.enterprises);
    this.germplasm = index(data.germplasm);
    this.generations = index(data.breeding_generations);
    this.trials = index(data.trials);
    this.signals = index(data.market_signals);
    this.decisions = index(data.breeding_decisions);
    this.registrations = index(data.registrations);
    this.rights = index(data.plant_variety_rights);
    this.licenses = index(data.licenses);
    this.grants = index(data.data_grants);
    this.guides = index(data.cultivation_guides);
    this.feedbacks = index(data.promotion_feedbacks);
    this.batches = index(data.seed_batches);
    this.sales = index(data.sales);

    this.sites = index(data.trial_sites);
    this.slots = new Map();
    for (const site of data.trial_sites) {
      for (const slot of site.time_slots) this.slots.set(slot.id, { ...slot, site_id: site.id });
    }

    this.versions = new Map();
    for (const variety of data.varieties) {
      for (const ver of variety.versions) {
        this.versions.set(VERSION_KEY(variety.id, ver.version_no), { ...ver, variety_id: variety.id });
      }
    }
  }

  version(varietyId, versionNo) {
    return this.versions.get(VERSION_KEY(varietyId, versionNo));
  }

  // ---------- 结构完整性 ----------
  checkIntegrity() {
    const errors = [];
    const requireId = (map, id, where) => {
      if (!map.has(id)) errors.push(`${where} 引用了不存在的对象 ${id}`);
    };

    for (const ger of this.data.germplasm) {
      ger.owner_team_ids.forEach((t) => requireId(this.teams, t, `种质 ${ger.id}`));
    }
    for (const gen of this.data.breeding_generations) {
      requireId(this.teams, gen.team_id, `世代 ${gen.id}`);
      gen.parent_ids.forEach((p) => {
        if (!this.germplasm.has(p) && !this.generations.has(p)) {
          errors.push(`世代 ${gen.id} 的亲本 ${p} 既不是种质也不是更早世代`);
        }
      });
    }
    // 血缘链不允许成环
    for (const gen of this.data.breeding_generations) {
      const visiting = new Set();
      const walk = (id) => {
        if (visiting.has(id)) {
          errors.push(`血缘链在 ${id} 处成环`);
          return;
        }
        visiting.add(id);
        const g = this.generations.get(id);
        if (g) g.parent_ids.forEach(walk);
        visiting.delete(id);
      };
      walk(gen.id);
    }

    for (const site of this.data.trial_sites) {
      for (const slot of site.time_slots) {
        if (slot.booking) {
          requireId(this.teams, slot.booking.team_id, `时段 ${slot.id}`);
          if (slot.booking.trial_id) requireId(this.trials, slot.booking.trial_id, `时段 ${slot.id}`);
        }
      }
    }
    for (const tri of this.data.trials) {
      requireId(this.teams, tri.team_id, `试验 ${tri.id}`);
      requireId(this.sites, tri.site_id, `试验 ${tri.id}`);
      const slot = this.slots.get(tri.slot_id);
      if (!slot) {
        errors.push(`试验 ${tri.id} 引用了不存在的时段 ${tri.slot_id}`);
      } else if (slot.site_id !== tri.site_id) {
        errors.push(`试验 ${tri.id} 的时段 ${tri.slot_id} 不属于试验地 ${tri.site_id}`);
      }
      if (!this.generations.has(tri.subject_id)) {
        errors.push(`试验 ${tri.id} 的供试材料 ${tri.subject_id} 不是已登记世代`);
      }
    }

    for (const sig of this.data.market_signals) {
      requireId(this.enterprises, sig.enterprise_id, `市场信息 ${sig.id}`);
    }
    for (const dec of this.data.breeding_decisions) {
      requireId(this.teams, dec.team_id, `育种决策 ${dec.id}`);
      if (dec.generation_id) requireId(this.generations, dec.generation_id, `育种决策 ${dec.id}`);
      if (dec.variety_id && !this.data.varieties.some((v) => v.id === dec.variety_id)) {
        errors.push(`育种决策 ${dec.id} 引用了不存在的品种 ${dec.variety_id}`);
      }
      (dec.trial_ids ?? []).forEach((t) => requireId(this.trials, t, `育种决策 ${dec.id}`));
      (dec.based_on_signal_ids ?? []).forEach((s) => requireId(this.signals, s, `育种决策 ${dec.id}`));
    }

    const seenVersionNo = new Set();
    for (const variety of this.data.varieties) {
      for (const ver of variety.versions) {
        const key = VERSION_KEY(variety.id, ver.version_no);
        if (seenVersionNo.has(key)) errors.push(`品种 ${variety.id} 版本号 ${ver.version_no} 重复`);
        seenVersionNo.add(key);
        requireId(this.generations, ver.derived_from_generation_id, `版本 ${key}`);
        ver.breeding_team_ids.forEach((t) => requireId(this.teams, t, `版本 ${key}`));
      }
    }
    const currentName = new Map();
    for (const name of this.data.variety_names) {
      if (!this.data.varieties.some((v) => v.id === name.variety_id)) {
        errors.push(`名称 "${name.name}" 引用了不存在的品种 ${name.variety_id}`);
      }
      if (name.current) {
        if (currentName.has(name.variety_id)) {
          errors.push(`品种 ${name.variety_id} 同时存在两个现行名称`);
        }
        currentName.set(name.variety_id, name.name);
      }
    }
    const refVersion = (where, varietyId, versionNo) => {
      if (!this.version(varietyId, versionNo)) errors.push(`${where} 引用了不存在的版本 ${VERSION_KEY(varietyId, versionNo)}`);
    };
    for (const reg of this.data.registrations) {
      refVersion(`审定 ${reg.id}`, reg.variety_id, reg.version_no);
    }
    for (const pvr of this.data.plant_variety_rights) {
      refVersion(`品种权 ${pvr.id}`, pvr.variety_id, pvr.version_no);
      pvr.owners.forEach((o) => requireId(this.teams, o.team_id, `品种权 ${pvr.id}`));
      if (pvr.owners.length > 1) {
        const sum = pvr.owners.reduce((acc, o) => acc + o.share, 0);
        if (Math.abs(sum - 100) > 0.001) errors.push(`共有品种权 ${pvr.id} 份额合计为 ${sum}，应为 100`);
      }
    }
    for (const lic of this.data.licenses) {
      refVersion(`许可 ${lic.id}`, lic.variety_id, lic.version_no);
      requireId(this.enterprises, lic.licensee_enterprise_id, `许可 ${lic.id}`);
      lic.co_owner_consents.forEach((c) => requireId(this.teams, c.team_id, `许可 ${lic.id}`));
    }
    for (const grant of this.data.data_grants) {
      requireId(this.enterprises, grant.enterprise_id, `授权 ${grant.id}`);
      grant.scope.germplasm_ids.forEach((g) => requireId(this.germplasm, g, `授权 ${grant.id}`));
      grant.scope.generation_ids.forEach((g) => requireId(this.generations, g, `授权 ${grant.id}`));
      grant.scope.variety_version_refs.forEach((ref) => refVersion(`授权 ${grant.id}`, ref.variety_id, ref.version_no));
    }
    for (const gui of this.data.cultivation_guides) {
      refVersion(`栽培指南 ${gui.id}`, gui.variety_id, gui.version_no);
      requireId(this.teams, gui.team_id, `栽培指南 ${gui.id}`);
    }
    for (const fb of this.data.promotion_feedbacks) {
      refVersion(`推广反馈 ${fb.id}`, fb.variety_id, fb.version_no);
      requireId(this.enterprises, fb.enterprise_id, `推广反馈 ${fb.id}`);
      if (fb.resulted_signal_id) requireId(this.signals, fb.resulted_signal_id, `推广反馈 ${fb.id}`);
    }
    for (const bat of this.data.seed_batches) {
      refVersion(`种子批次 ${bat.id}`, bat.variety_id, bat.version_no);
      requireId(this.licenses, bat.license_id, `种子批次 ${bat.id}`);
    }
    for (const sal of this.data.sales) {
      requireId(this.batches, sal.batch_id, `销售 ${sal.id}`);
      requireId(this.enterprises, sal.enterprise_id, `销售 ${sal.id}`);
    }
    return [...new Set(errors)];
  }

  // ---------- 连续谱系 ----------
  // 平台侧完整血缘：品种版本 → 定型世代 → 各代材料 → 种质资源。
  lineage(varietyId, versionNo) {
    const root = this.version(varietyId, versionNo);
    if (!root) throw new Error(`版本不存在：${VERSION_KEY(varietyId, versionNo)}`);
    const nodes = [];
    const seen = new Set();
    const visit = (id, depth) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (this.generations.has(id)) {
        const gen = this.generations.get(id);
        nodes.push({ kind: "generation", depth, id, code: gen.code, team_id: gen.team_id, generation: gen.generation, year: gen.year, status: gen.status });
        gen.parent_ids.forEach((p) => visit(p, depth + 1));
      } else if (this.germplasm.has(id)) {
        const ger = this.germplasm.get(id);
        nodes.push({ kind: "germplasm", depth, id, name: ger.name, source_kind: ger.source_kind, owner_team_ids: ger.owner_team_ids });
      }
    };
    visit(root.derived_from_generation_id, 0);
    return nodes;
  }

  // ---------- 市场信息 → 育种决策 的可解释链 ----------
  explainDecision(decisionId) {
    const dec = this.decisions.get(decisionId);
    if (!dec) throw new Error(`育种决策不存在：${decisionId}`);
    return {
      decision: dec,
      based_on_signals: (dec.based_on_signal_ids ?? []).map((id) => this.signals.get(id)),
      based_on_trials: (dec.trial_ids ?? []).map((id) => this.trials.get(id)),
      narrative: `${dec.date} ${this.teams.get(dec.team_id)?.name}「${dec.action}」：${dec.rationale}` +
        ((dec.based_on_signal_ids ?? []).length > 0
          ? ` 触发该决策的市场信息：${dec.based_on_signal_ids.map((id) => this.signals.get(id)?.summary).join("；")}`
          : "")
    };
  }

  decisionsDrivenBySignal(signalId) {
    return this.data.breeding_decisions
      .filter((d) => (d.based_on_signal_ids ?? []).includes(signalId))
      .map((d) => this.explainDecision(d.id));
  }

  negativeTrials() {
    return this.data.trials
      .filter((t) => t.outcome === "负面淘汰" || t.outcome === "终止观察")
      .map((t) => ({ trial: t, decisions: this.data.breeding_decisions.filter((d) => (d.trial_ids ?? []).includes(t.id)) }));
  }

  // ---------- 更名 ----------
  currentName(varietyId, date) {
    const names = this.data.variety_names
      .filter((n) => n.variety_id === varietyId && (!date || n.effective_date <= date))
      .sort((a, b) => (a.effective_date < b.effective_date ? 1 : -1));
    return names.find((n) => n.current)?.name ?? names[0]?.name ?? null;
  }

  // ---------- 试验地时段 ----------
  // 同一时段被多个团队/供试材料占用即冲突；预约登记与试验记录互相对账。
  checkScheduling() {
    const findings = [];
    for (const [slotId, slot] of this.slots) {
      const users = this.data.trials.filter((t) => t.slot_id === slotId);
      const subjects = new Set(users.map((t) => `${t.team_id}/${t.subject_id}`));
      if (subjects.size > 1) {
        findings.push({
          code: "SLOT_DOUBLE_BOOKED",
          slot_id: slotId,
          site_id: slot.site_id,
          message: `时段 ${slot.site_id} ${slot.year}${slot.season}季 被多方同时占用：${[...subjects].join("、")}`,
          trial_ids: users.map((t) => t.id)
        });
      }
      if (slot.booking?.trial_id && !users.some((t) => t.id === slot.booking.trial_id)) {
        findings.push({
          code: "SLOT_BOOKING_TRIAL_MISMATCH",
          slot_id: slotId,
          message: `时段 ${slotId} 预约登记的试验 ${slot.booking.trial_id} 与试验记录不一致`
        });
      }
      for (const t of users) {
        if (slot.booking && t.team_id !== slot.booking.team_id) {
          findings.push({
            code: "SLOT_TEAM_CONFLICT",
            slot_id: slotId,
            trial_id: t.id,
            message: `试验 ${t.id}（${t.team_id}）占用了已预约给 ${slot.booking.team_id} 的时段 ${slotId}`
          });
        }
      }
    }
    return findings;
  }

  // ---------- 许可 ----------
  rightsFor(varietyId, versionNo) {
    return this.data.plant_variety_rights.find((p) => p.variety_id === varietyId && p.version_no === versionNo);
  }

  checkLicense(licenseId) {
    const lic = this.licenses.get(licenseId);
    if (!lic) throw new Error(`许可不存在：${licenseId}`);
    const findings = [];
    const pvr = this.rightsFor(lic.variety_id, lic.version_no);

    if (pvr && pvr.owners.length > 1) {
      for (const owner of pvr.owners) {
        const consent = lic.co_owner_consents.find((c) => c.team_id === owner.team_id);
        if (!consent || !consent.consented) {
          findings.push({
            code: "LICENSE_MISSING_CO_OWNER_CONSENT",
            license_id: lic.id,
            team_id: owner.team_id,
            message: `共有品种权人 ${owner.team_id}（份额 ${owner.share}%）未同意许可 ${lic.id}`
          });
        }
      }
    }

    if (lic.status === "生效") {
      for (const other of this.data.licenses) {
        if (other.id === lic.id || other.status !== "生效") continue;
        if (other.variety_id !== lic.variety_id || other.version_no !== lic.version_no) continue;
        if (lic.type === "独占" || lic.type === "排他" || other.type === "独占" || other.type === "排他") {
          findings.push({
            code: "LICENSE_EXCLUSIVITY_CONFLICT",
            license_id: lic.id,
            conflicting_license_id: other.id,
            message: `许可 ${lic.id}（${lic.type}）与同期生效的 ${other.id}（${other.type}）在版本 ${lic.variety_id}@${lic.version_no} 上互不相容`
          });
        }
      }
    }

    const reg = this.data.registrations.find(
      (r) => r.variety_id === lic.variety_id && r.version_no === lic.version_no && r.status === "通过"
    );
    if (reg) {
      const outside = lic.regions.filter((region) => !reg.adapted_regions.includes(region));
      if (outside.length > 0) {
        findings.push({
          code: "LICENSE_REGION_OUTSIDE_ADAPTATION",
          license_id: lic.id,
          regions: outside,
          message: `许可 ${lic.id} 授权区域 ${outside.join("、")} 超出审定 ${reg.number} 的适宜区域 ${reg.adapted_regions.join("、")}`
        });
      }
    }
    return findings;
  }

  // ---------- 企业获准视图 ----------
  enterpriseView(enterpriseId) {
    if (!this.enterprises.has(enterpriseId)) throw new Error(`企业不存在：${enterpriseId}`);
    const grants = this.data.data_grants.filter((g) => g.enterprise_id === enterpriseId);
    const canSeeGer = new Set();
    const canSeeGen = new Set();
    const canSeeVer = new Set();
    for (const g of grants) {
      g.scope.germplasm_ids.forEach((id) => canSeeGer.add(id));
      g.scope.generation_ids.forEach((id) => canSeeGen.add(id));
      g.scope.variety_version_refs.forEach((ref) => canSeeVer.add(VERSION_KEY(ref.variety_id, ref.version_no)));
    }
    // 已公开种质对所有合作企业可见；未公开材料严格限于获准范围。
    const germplasm = this.data.germplasm.filter((g) => canSeeGer.has(g.id) || g.public_status === "已公开");
    const generations = this.data.breeding_generations.filter((g) => canSeeGen.has(g.id));
    const versions = [...canSeeVer].map((key) => {
      const [varietyId, versionNo] = key.split("@");
      return this.version(varietyId, versionNo);
    });
    const visibleGenIds = new Set(generations.map((g) => g.id));

    // 获准世代的血缘中，未获准亲本做脱敏处理，不暴露编号与名称。
    const lineageOf = (generationId) => {
      const redacted = (depth) => ({ kind: "redacted", depth, label: "未获授权的协作方材料" });
      const walk = (id, depth, acc) => {
        if (this.germplasm.has(id)) {
          const ger = this.germplasm.get(id);
          acc.push(canSeeGer.has(id) || ger.public_status === "已公开"
            ? { kind: "germplasm", depth, id, name: ger.name, source_kind: ger.source_kind }
            : redacted(depth));
        } else if (this.generations.has(id)) {
          const gen = this.generations.get(id);
          acc.push(visibleGenIds.has(id)
            ? { kind: "generation", depth, id, code: gen.code, generation: gen.generation, traits: gen.traits }
            : redacted(depth));
          if (visibleGenIds.has(id)) gen.parent_ids.forEach((p) => walk(p, depth + 1, acc));
        }
        return acc;
      };
      return walk(generationId, 0, []);
    };

    return {
      enterprise_id: enterpriseId,
      germplasm,
      generations,
      variety_versions: versions,
      trials: this.data.trials.filter((t) => visibleGenIds.has(t.subject_id)),
      cultivation_guides: this.data.cultivation_guides.filter(
        (g) => canSeeVer.has(VERSION_KEY(g.variety_id, g.version_no))
      ),
      lineageOf,
      canSee: { germplasm: canSeeGer, generations: canSeeGen, versions: canSeeVer }
    };
  }

  // ---------- 批次与销售核验：证明种子来自获准版本 ----------
  verifyBatch(batchId, atDate) {
    const bat = this.batches.get(batchId);
    if (!bat) throw new Error(`种子批次不存在：${batchId}`);
    const date = atDate ?? bat.produced_date;
    const findings = [];
    const ver = this.version(bat.variety_id, bat.version_no);

    const reg = this.data.registrations.find(
      (r) => r.variety_id === bat.variety_id && r.version_no === bat.version_no && r.status === "通过"
    );
    if (!reg) {
      findings.push({ code: "BATCH_UNREGISTERED_VERSION", batch_id: bat.id, message: `批次 ${bat.id} 来自未通过审定登记的版本 ${bat.variety_id}@${bat.version_no}，不得作为商品种子生产` });
    } else if (ver?.status !== "已审定") {
      findings.push({ code: "BATCH_VERSION_NOT_APPROVED", batch_id: bat.id, message: `批次 ${bat.id} 的版本状态为 ${ver?.status}，不可商业化制种` });
    }

    const dueName = this.currentName(bat.variety_id, date);
    if (dueName && bat.labeled_name !== dueName) {
      findings.push({ code: "BATCH_STALE_LABEL_NAME", batch_id: bat.id, message: `批次 ${bat.id} 标称名称「${bat.labeled_name}」已不是现行名称，${date} 应标注「${dueName}」` });
    }

    const lic = this.licenses.get(bat.license_id);
    if (lic.variety_id !== bat.variety_id || lic.version_no !== bat.version_no) {
      findings.push({ code: "BATCH_LICENSE_VERSION_MISMATCH", batch_id: bat.id, message: `批次 ${bat.id} 所依许可 ${lic.id} 授权的是 ${lic.variety_id}@${lic.version_no}，与批次版本不一致` });
    }
    if (lic.status !== "生效") {
      findings.push({ code: "BATCH_LICENSE_INACTIVE", batch_id: bat.id, message: `批次 ${bat.id} 所依许可 ${lic.id} 状态为 ${lic.status}` });
    } else if (date < lic.start_date || (lic.end_date && date > lic.end_date)) {
      findings.push({ code: "BATCH_LICENSE_OUT_OF_TERM", batch_id: bat.id, message: `批次 ${bat.id} 生产日期 ${date} 不在许可 ${lic.id} 期限内` });
    }
    return { batch: bat, license: lic, registration: reg, findings };
  }

  verifySale(saleId) {
    const sal = this.sales.get(saleId);
    if (!sal) throw new Error(`销售记录不存在：${saleId}`);
    const batchCheck = this.verifyBatch(sal.batch_id, sal.date);
    const findings = [...batchCheck.findings.map((f) => ({ ...f, sale_id: sal.id }))];
    const lic = batchCheck.license;

    if (sal.enterprise_id !== lic.licensee_enterprise_id) {
      findings.push({ code: "SALE_BY_NON_LICENSEE", sale_id: sal.id, message: `销售方 ${sal.enterprise_id} 不是批次所依许可 ${lic.id} 的被许可企业 ${lic.licensee_enterprise_id}` });
    }
    if (!lic.regions.includes(sal.region_code)) {
      findings.push({ code: "SALE_REGION_OUTSIDE_LICENSE", sale_id: sal.id, message: `销售 ${sal.id} 区域 ${sal.region_code} 不在许可 ${lic.id} 授权区域 ${lic.regions.join("、")} 内` });
    }
    if (sal.date < lic.start_date || (lic.end_date && sal.date > lic.end_date)) {
      findings.push({ code: "SALE_OUTSIDE_LICENSE_TERM", sale_id: sal.id, message: `销售 ${sal.id} 日期 ${sal.date} 不在许可 ${lic.id} 期限内` });
    }
    if (batchCheck.registration && !batchCheck.registration.adapted_regions.includes(sal.region_code)) {
      findings.push({ code: "SALE_REGION_OUTSIDE_ADAPTATION", sale_id: sal.id, message: `销售 ${sal.id} 越出审定 ${batchCheck.registration.number} 适宜区域，属于越区推广` });
    }
    return {
      sale: sal,
      batch: batchCheck.batch,
      variety_id: batchCheck.batch.variety_id,
      version_no: batchCheck.batch.version_no,
      license: lic,
      findings
    };
  }
}

function index(list) {
  const map = new Map();
  for (const item of list) {
    if (map.has(item.id)) throw new Error(`标识重复：${item.id}`);
    map.set(item.id, item);
  }
  return map;
}
