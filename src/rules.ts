import type {
  BilgeRecord,
  FaultRecord,
  MetricReading,
  Shift,
  Tank,
  Transfer,
} from "./state";

/** 驳运完工实收偏差允许上限：2% */
export const TOLERANCE = 0.02;

/* ------------------------------------------------------------------ */
/* 时间工具                                                            */
/* ------------------------------------------------------------------ */

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地日期 YYYY-MM-DD */
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** datetime-local 输入值 -> ISO 字符串（输入值按本地时区解释） */
export function localInputToISO(value: string): string {
  return new Date(value).toISOString();
}

/** ISO 字符串 -> datetime-local 输入值 */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function fmtNum(n: number, digits = 1): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/* ------------------------------------------------------------------ */
/* 班次时段                                                            */
/* ------------------------------------------------------------------ */

/** 由「08-12班」+ 日期得到该班次的时间窗（24 点归到次日 0 点） */
export function shiftWindow(
  label: string,
  date: string
): { startISO: string; endISO: string } | null {
  const m = /^(\d{2})-(\d{2})班$/.exec(label);
  if (!m) return null;
  const startHour = Number(m[1]);
  const endHourRaw = Number(m[2]);
  const start = new Date(`${date}T${pad2(startHour)}:00:00`);
  const endDay = endHourRaw === 24 ? addDays(date, 1) : date;
  const endHour = endHourRaw === 24 ? 0 : endHourRaw;
  const end = new Date(`${endDay}T${pad2(endHour)}:00:00`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

/* ------------------------------------------------------------------ */
/* 驳运单规则                                                          */
/* ------------------------------------------------------------------ */

export interface TransferDraft {
  fromTankId: string;
  toTankId: string;
  startISO: string;
  endISO: string;
  declared: number;
}

export type TransferCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** 半开区间时段重叠判定：端点相接不算重叠 */
export function intervalsOverlap(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): boolean {
  return new Date(startA) < new Date(endB) && new Date(startB) < new Date(endA);
}

/**
 * 申报校验：起点存量不足 / 终点空间不足 / 计划时段重叠，
 * 任一不通过都返回原因 —— 调用方必须整单不保存，舱量和日志不动。
 */
export function checkTransferDraft(
  draft: TransferDraft,
  tanks: Tank[],
  existing: Transfer[]
): TransferCheck {
  if (!draft.fromTankId || !draft.toTankId) {
    return { ok: false, reason: "请选择起点舱和终点舱。" };
  }
  if (draft.fromTankId === draft.toTankId) {
    return { ok: false, reason: "起点舱与终点舱不能是同一个舱柜。" };
  }
  if (!(draft.declared > 0)) {
    return { ok: false, reason: "申报驳运量必须大于 0。" };
  }
  if (!(new Date(draft.startISO) < new Date(draft.endISO))) {
    return { ok: false, reason: "计划开始时间必须早于结束时间。" };
  }

  const from = tanks.find((t) => t.id === draft.fromTankId);
  const to = tanks.find((t) => t.id === draft.toTankId);
  if (!from || !to) {
    return { ok: false, reason: "舱柜信息缺失，请重新选择。" };
  }
  if (from.stock < draft.declared) {
    return {
      ok: false,
      reason: `起点舱「${from.name}」存量 ${fmtNum(
        from.stock
      )} L，不足申报量 ${fmtNum(draft.declared)} L，整单不予保存。`,
    };
  }
  const free = to.capacity - to.stock;
  if (free < draft.declared) {
    return {
      ok: false,
      reason: `终点舱「${to.name}」剩余空间 ${fmtNum(
        free
      )} L，不足申报量 ${fmtNum(draft.declared)} L，整单不予保存。`,
    };
  }
  const conflict = existing.find((t) =>
    intervalsOverlap(draft.startISO, draft.endISO, t.startISO, t.endISO)
  );
  if (conflict) {
    return {
      ok: false,
      reason: `计划时段与驳运单 ${conflict.no}（${fmtDateTime(
        conflict.startISO
      )} 至 ${fmtDateTime(conflict.endISO)}）重叠，整单不予保存。`,
    };
  }
  return { ok: true };
}

/** 实收相对申报的偏差率（绝对值） */
export function deviationRate(actual: number, declared: number): number {
  if (declared <= 0) return Infinity;
  return Math.abs(actual - declared) / declared;
}

export interface FinishOutcome {
  status: Extract<Transfer["status"], "completed" | "review">;
  rate: number;
}

/** 完工判定：偏差超过 2% 进入待复核，未超过则正常完工 */
export function evaluateFinish(
  actual: number,
  declared: number
): FinishOutcome | { ok: false; reason: string } {
  if (!(actual > 0)) {
    return { ok: false, reason: "实收量必须大于 0。" };
  }
  const rate = deviationRate(actual, declared);
  return { status: rate > TOLERANCE ? "review" : "completed", rate };
}

/**
 * 完工过账：起点舱先按申报量扣除。
 * 偏差 ≤ 2%：终点舱按实收量同步入账；
 * 偏差 > 2%：终点舱暂不入账（等待复核）。
 */
export function tanksAfterFinish(
  tanks: Tank[],
  transfer: Transfer,
  actual: number
): Tank[] {
  const outcome = evaluateFinish(actual, transfer.declared);
  const creditDestination = "status" in outcome && outcome.status === "completed";
  return tanks.map((tk) => {
    if (tk.id === transfer.fromTankId) {
      return { ...tk, stock: round3(tk.stock - transfer.declared) };
    }
    if (tk.id === transfer.toTankId && creditDestination) {
      return { ...tk, stock: round3(tk.stock + actual) };
    }
    return tk;
  });
}

/** 复核通过：终点舱按实收量补入账 */
export function tanksAfterReview(tanks: Tank[], transfer: Transfer): Tank[] {
  const actual = transfer.actual ?? 0;
  return tanks.map((tk) =>
    tk.id === transfer.toTankId
      ? { ...tk, stock: round3(tk.stock + actual) }
      : tk
  );
}

export function isUnfinished(t: Transfer): boolean {
  return t.status === "planned" || t.status === "running";
}

/** 与某班次时间窗相交的驳运单 */
export function transfersTouchingShift(
  transfers: Transfer[],
  shift: Shift
): Transfer[] {
  const win = shiftWindow(shift.label, shift.date);
  if (!win) return [];
  return transfers.filter((t) =>
    intervalsOverlap(t.startISO, t.endISO, win.startISO, win.endISO)
  );
}

/** 交班阻断原因：时间窗相交且尚未完工的驳运单 */
export function handoverBlockers(
  transfers: Transfer[],
  shift: Shift
): Transfer[] {
  return transfersTouchingShift(transfers, shift).filter(isUnfinished);
}

/* ------------------------------------------------------------------ */
/* 设备分组与交接摘要                                                   */
/* ------------------------------------------------------------------ */

export function deviceGroup(device: string): string {
  if (device.includes("发电机")) return "发电机";
  if (device.includes("泵")) return "泵组";
  if (device.includes("舱底")) return "舱底水";
  if (device.includes("燃油") || device.includes("油柜") || device.includes("油舱"))
    return "燃油系统";
  return "主机";
}

export interface ShiftSummary {
  shift: Shift;
  readings: MetricReading[];
  lastReading?: MetricReading;
  fuelTotal: number;
  bilges: BilgeRecord[];
  latestBilge?: BilgeRecord;
  faults: FaultRecord[];
  openFaults: FaultRecord[];
  transfers: Transfer[];
  blockers: Transfer[];
}

export function summarizeShift(
  shift: Shift,
  readings: MetricReading[],
  bilges: BilgeRecord[],
  faults: FaultRecord[],
  transfers: Transfer[]
): ShiftSummary {
  const rs = readings.filter((r) => r.shiftId === shift.id);
  const bs = bilges.filter((b) => b.shiftId === shift.id);
  const fs = faults.filter((f) => f.shiftId === shift.id);
  const ts = transfersTouchingShift(transfers, shift);
  return {
    shift,
    readings: rs,
    lastReading: rs[rs.length - 1],
    fuelTotal: round3(rs.reduce((sum, r) => sum + r.fuelUsed, 0)),
    bilges: bs,
    latestBilge: bs[bs.length - 1],
    faults: fs,
    openFaults: fs.filter((f) => f.status !== "已处理"),
    transfers: ts,
    blockers: ts.filter(isUnfinished),
  };
}
