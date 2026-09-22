// 业务文件二：规则层
// 纯函数业务规则：校验、驳运三关（存量/空间/时段重叠）、2% 偏差复核、交班拦截。
// 每个函数直接改写传入的 draft（状态层已做深拷贝），不触碰存储与界面。

import {
  DAILY_TANK_ID,
  uid,
  type Anomaly,
  type AnomalyDraft,
  type AppState,
  type BilgeDraft,
  type BilgeEntry,
  type Reading,
  type ReadingDraft,
  type Shift,
  type Transfer,
  type TransferDraftInput,
} from "./state";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const DEVIATION_LIMIT = 0.02; // 完工实收偏差超过 2% 即待复核

function getShift(s: AppState, shiftId: string): Shift | undefined {
  return s.shifts.find((x) => x.id === shiftId);
}

function locked(s: AppState, shiftId: string): string[] {
  const sh = getShift(s, shiftId);
  return sh?.confirmed ? ["本班次已确认交班，记录已锁定。"] : [];
}

function parseTime(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function isNum(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function deviationPct(t: Transfer): number | null {
  if (t.actual === undefined || t.declared === 0) return null;
  return (t.actual - t.declared) / t.declared;
}

export function formatDeviation(t: Transfer): string {
  const d = deviationPct(t);
  if (d === null) return "—";
  const pct = (d * 100).toFixed(2) + "%";
  return (d >= 0 ? "+" : "") + pct;
}

// 时段重叠判定（半开区间，首尾相接不算重叠）
export function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function transferErrors(
  s: AppState,
  data: { fromTank: string; toTank: string; startAt: string; endAt: string; declared: number },
  excludeId?: string,
): string[] {
  const errors: string[] = [];
  const from = s.tanks.find((t) => t.id === data.fromTank);
  const to = s.tanks.find((t) => t.id === data.toTank);

  if (!from) errors.push("请选择有效的起点舱。");
  if (!to) errors.push("请选择有效的终点舱。");
  if (from && to && from.id === to.id) errors.push("起点舱与终点舱不能相同。");

  if (!isNum(data.declared) || data.declared <= 0) {
    errors.push("申报量必须大于 0。");
  } else if (from && data.declared > from.level) {
    // 第一关：起点存量不足 —— 整单不保存
    errors.push(
      `起点存量不足：${from.name}当前 ${from.level}m³，申报驳运 ${round3(data.declared)}m³。`,
    );
  }

  if (to && isNum(data.declared) && data.declared > to.capacity - to.level) {
    // 第二关：终点空间不足 —— 整单不保存
    errors.push(
      `终点空间不足：${to.name}尚可容纳 ${round3(to.capacity - to.level)}m³，申报 ${round3(data.declared)}m³。`,
    );
  }

  const start = parseTime(data.startAt);
  const end = parseTime(data.endAt);
  if (start === null || end === null) {
    errors.push("请填写完整的计划起止时段。");
  } else if (start >= end) {
    errors.push("计划开始时间必须早于结束时间。");
  } else {
    // 第三关：时段重叠 —— 与任何已保存驳运单重叠都整单不保存
    const clash = s.transfers.find(
      (t) =>
        t.id !== excludeId &&
        windowsOverlap(start, end, Date.parse(t.startAt), Date.parse(t.endAt)),
    );
    if (clash) {
      const cf = s.tanks.find((x) => x.id === clash.fromTank)?.name ?? clash.fromTank;
      const ct = s.tanks.find((x) => x.id === clash.toTank)?.name ?? clash.toTank;
      errors.push(
        `计划时段与驳运单 ${cf} → ${ct}（${fmt(clash.startAt)} ~ ${fmt(clash.endAt)}）重叠。`,
      );
    }
  }

  return errors;
}

// ---- 四项指标登记 ----

export function addReading(
  s: AppState,
  shiftId: string,
  draft: ReadingDraft,
): Result<Reading> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };

  const errors: string[] = [];
  const at = parseTime(draft.at);
  if (at === null) errors.push("请选择登记时间。");

  const checks: [keyof Omit<ReadingDraft, "at">, string, number, number][] = [
    ["rpm", "主机转速", 0, 1000],
    ["lubePressure", "滑油回路压力", 0, 2],
    ["coolingTemp", "冷却水温", 0, 130],
    ["fuelBurn", "日用柜耗油量", 0, 100],
  ];
  for (const [key, label, min, max] of checks) {
    const v = draft[key];
    if (!isNum(v) || v < min || v > max) errors.push(`${label}超出合理范围（${min}~${max}）。`);
  }

  // 日用柜耗油量同步扣减日用柜存量；存量不足不保存
  const service = s.tanks.find((t) => t.id === DAILY_TANK_ID);
  if (service && isNum(draft.fuelBurn) && draft.fuelBurn >= 0 && draft.fuelBurn > service.level) {
    errors.push(
      `日用柜存量不足：当前 ${service.level}m³，本次耗油 ${round3(draft.fuelBurn)}m³，舱量与日志均不改动。`,
    );
  }

  if (errors.length) return { ok: false, errors };

  const reading: Reading = {
    id: uid("rd"),
    shiftId,
    at: new Date(at!).toISOString(),
    rpm: draft.rpm,
    lubePressure: draft.lubePressure,
    coolingTemp: draft.coolingTemp,
    fuelBurn: draft.fuelBurn,
  };
  s.readings.push(reading);
  service!.level = round3(service!.level - draft.fuelBurn);
  return { ok: true, value: reading };
}

// ---- 舱底水 ----

export function addBilge(s: AppState, shiftId: string, draft: BilgeDraft): Result<BilgeEntry> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  if (parseTime(draft.at) === null) return { ok: false, errors: ["请选择记录时间。"] };

  const entry: BilgeEntry = {
    id: uid("bl"),
    shiftId,
    at: new Date(draft.at).toISOString(),
    levelStatus: draft.levelStatus,
    pumped: draft.pumped,
    remark: draft.remark.trim(),
  };
  s.bilges.push(entry);
  return { ok: true, value: entry };
}

// ---- 设备异常 ----

export function addAnomaly(
  s: AppState,
  shiftId: string,
  draft: AnomalyDraft,
): Result<Anomaly> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };

  const errors: string[] = [];
  if (parseTime(draft.at) === null) errors.push("请选择异常时间。");
  if (!draft.description.trim()) errors.push("请填写异常描述。");

  if (errors.length) return { ok: false, errors };

  const anomaly: Anomaly = {
    id: uid("an"),
    shiftId,
    at: new Date(draft.at).toISOString(),
    equipment: draft.equipment,
    description: draft.description.trim(),
    severity: draft.severity,
    handled: false,
  };
  s.anomalies.push(anomaly);
  return { ok: true, value: anomaly };
}

export function resolveAnomaly(
  s: AppState,
  shiftId: string,
  id: string,
  handled: boolean,
  at: string,
): Result<null> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  const item = s.anomalies.find((a) => a.id === id && a.shiftId === shiftId);
  if (!item) return { ok: false, errors: ["未找到该异常记录。"] };
  item.handled = handled;
  item.handledAt = handled ? new Date(at).toISOString() : undefined;
  return { ok: true, value: null };
}

// ---- 燃油舱驳运单 ----

export function createTransfer(
  s: AppState,
  shiftId: string,
  draft: TransferDraftInput,
): Result<Transfer> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };

  const errors = transferErrors(s, draft);
  if (errors.length) {
    // 任一关不过：整单不保存，舱量和日志不动
    return { ok: false, errors };
  }

  const t: Transfer = {
    id: uid("tr"),
    shiftId,
    fromTank: draft.fromTank,
    toTank: draft.toTank,
    startAt: new Date(draft.startAt).toISOString(),
    endAt: new Date(draft.endAt).toISOString(),
    declared: draft.declared,
    status: "planned",
    events: [{ at: new Date().toISOString(), type: "created" }],
  };
  s.transfers.push(t);
  return { ok: true, value: t };
}

export function startTransfer(s: AppState, shiftId: string, id: string, at: string): Result<null> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  const t = s.transfers.find((x) => x.id === id && x.shiftId === shiftId);
  if (!t) return { ok: false, errors: ["未找到该驳运单。"] };
  if (t.status !== "planned") return { ok: false, errors: ["只有待开工的驳运单可以标记开工。"] };
  t.status = "running";
  t.events.push({ at: new Date(at).toISOString(), type: "started" });
  return { ok: true, value: null };
}

export function deleteTransfer(s: AppState, shiftId: string, id: string): Result<null> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  const t = s.transfers.find((x) => x.id === id && x.shiftId === shiftId);
  if (!t) return { ok: false, errors: ["未找到该驳运单。"] };
  if (t.status !== "planned")
    return { ok: false, errors: ["驳运已开工，不能删除；请先完工或完成复核。"] };
  s.transfers = s.transfers.filter((x) => x.id !== id);
  return { ok: true, value: null };
}

export function finishTransfer(
  s: AppState,
  shiftId: string,
  id: string,
  actualInput: number,
  at: string,
): Result<Transfer> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };

  const t = s.transfers.find((x) => x.id === id && x.shiftId === shiftId);
  if (!t) return { ok: false, errors: ["未找到该驳运单。"] };
  if (t.status !== "planned" && t.status !== "running")
    return { ok: false, errors: ["该驳运单已完工，不能重复登记实收。"] };
  if (!isNum(actualInput) || actualInput <= 0)
    return { ok: false, errors: ["实收量必须大于 0。"] };

  const actual = round3(actualInput);
  const from = s.tanks.find((x) => x.id === t.fromTank);
  const to = s.tanks.find((x) => x.id === t.toTank);
  if (!from || !to) return { ok: false, errors: ["驳运单关联的舱柜缺失。"] };

  const errors: string[] = [];
  if (actual > from.level)
    errors.push(`起点存量不足：${from.name}当前 ${from.level}m³，实收 ${actual}m³。`);
  if (actual > to.capacity - to.level)
    errors.push(
      `终点空间不足：${to.name}尚可容纳 ${round3(to.capacity - to.level)}m³，实收 ${actual}m³。`,
    );
  if (errors.length) return { ok: false, errors };

  const deviation = (actual - t.declared) / t.declared;
  const nowIso = new Date(at).toISOString();

  if (t.status === "planned") {
    t.status = "running";
    t.events.push({ at: nowIso, type: "started", note: "完工时自动开工" });
  }

  // 起点舱先扣（按实收量）
  from.level = round3(from.level - actual);

  if (Math.abs(deviation) > DEVIATION_LIMIT) {
    // 偏差超过 2%：终点舱暂不入账，整单待复核，复核前不得修正
    t.status = "review";
    t.actual = actual;
    t.deviation = deviation;
    t.finishedAt = nowIso;
    t.reviewDecision = "review";
    t.events.push({ at: nowIso, type: "finished", note: "完工，偏差超 2%，待复核" });
    return { ok: true, value: t };
  }

  // 偏差在 2% 以内：终点舱按实收入账，驳运完成
  to.level = round3(to.level + actual);
  t.status = "done";
  t.actual = actual;
  t.deviation = deviation;
  t.finishedAt = nowIso;
  t.reviewDecision = "accepted";
  t.events.push({ at: nowIso, type: "finished", note: "完工，偏差在 2% 以内" });
  return { ok: true, value: t };
}

export function approveReview(
  s: AppState,
  shiftId: string,
  id: string,
  at: string,
  note: string,
): Result<null> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  const t = s.transfers.find((x) => x.id === id && x.shiftId === shiftId);
  if (!t) return { ok: false, errors: ["未找到该驳运单。"] };
  if (t.status !== "review" || t.actual === undefined)
    return { ok: false, errors: ["只有待复核的驳运单可以执行复核。"] };

  const to = s.tanks.find((x) => x.id === t.toTank);
  if (!to) return { ok: false, errors: ["驳运单关联的舱柜缺失。"] };
  if (t.actual > to.capacity - to.level)
    return {
      ok: false,
      errors: [`终点空间不足：${to.name}当前无法容纳实收 ${t.actual}m³，请先处理舱量。`],
    };

  to.level = round3(to.level + t.actual);
  t.status = "done";
  t.reviewNote = note.trim() || "复核通过，终点舱补入账。";
  t.events.push({ at: new Date(at).toISOString(), type: "reviewed", note: t.reviewNote });
  return { ok: true, value: null };
}

export function rejectReview(
  s: AppState,
  shiftId: string,
  id: string,
  at: string,
  note: string,
): Result<null> {
  const lockErrors = locked(s, shiftId);
  if (lockErrors.length) return { ok: false, errors: lockErrors };
  const t = s.transfers.find((x) => x.id === id && x.shiftId === shiftId);
  if (!t) return { ok: false, errors: ["未找到该驳运单。"] };
  if (t.status !== "review" || t.actual === undefined)
    return { ok: false, errors: ["只有待复核的驳运单可以执行复核。"] };

  // 退回：驳运单回到进行中，起点已扣油量保持不动，等待重新完工登记（修正只能在此时进行）
  const text = note.trim() || "复核退回，驳运单回到进行中，请重新登记完工。";
  t.status = "running";
  t.reviewDecision = undefined;
  t.actual = undefined;
  t.deviation = undefined;
  t.finishedAt = undefined;
  t.reviewNote = text;
  t.events.push({ at: new Date(at).toISOString(), type: "reviewed", note: text });
  return { ok: true, value: null };
}

// ---- 交班 ----

// 驳运未结束（待开工/进行中/待复核）时不能确认交班
export function transfersBlocking(s: AppState, shiftId: string): Transfer[] {
  return s.transfers
    .filter((t) => t.shiftId === shiftId)
    .filter((t) => t.status === "planned" || t.status === "running" || t.status === "review");
}

// ---- 展示辅助 ----

export function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function localInputValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
