import { useSyncExternalStore } from "react";
import {
  dateKey,
  evaluateFinish,
  handoverBlockers,
  round3,
  tanksAfterFinish,
  tanksAfterReview,
  type TransferDraft,
} from "./rules";

/* ------------------------------------------------------------------ */
/* 类型定义                                                            */
/* ------------------------------------------------------------------ */

export type ShiftLabel =
  | "00-04班"
  | "04-08班"
  | "08-12班"
  | "12-16班"
  | "16-20班"
  | "20-24班";

export const SHIFT_LABELS: ShiftLabel[] = [
  "00-04班",
  "04-08班",
  "08-12班",
  "12-16班",
  "16-20班",
  "20-24班",
];

export type TransferStatus =
  | "planned"
  | "running"
  | "completed"
  | "review"
  | "reviewed";

export const TRANSFER_STATUS_TEXT: Record<TransferStatus, string> = {
  planned: "待驳运",
  running: "驳运中",
  completed: "已完工",
  review: "待复核",
  reviewed: "已复核",
};

export const DEVICE_FILTERS = [
  "全部",
  "主机",
  "发电机",
  "泵组",
  "舱底水",
  "燃油系统",
] as const;

export const BILGE_LEVELS = ["正常", "偏高", "警戒线"] as const;
export const FAULT_STATUSES = ["待处理", "已处理"] as const;

export interface Shift {
  id: string;
  label: ShiftLabel;
  date: string; // YYYY-MM-DD
  note: string; // 交接备注
  handedOver: boolean;
  handedOverAt?: string;
}

export interface MetricReading {
  id: string;
  shiftId: string;
  at: string;
  rpm: number; // 主机转速 rpm
  lubePressure: number; // 滑油回路压力 MPa
  coolantTemp: number; // 冷却水温 ℃
  fuelUsed: number; // 日用柜耗油量 L
}

export interface BilgeRecord {
  id: string;
  shiftId: string;
  at: string;
  level: (typeof BILGE_LEVELS)[number];
  note: string;
}

export interface FaultRecord {
  id: string;
  shiftId: string;
  at: string;
  device: string;
  description: string;
  status: (typeof FAULT_STATUSES)[number];
}

export interface Tank {
  id: string;
  name: string;
  kind: "storage" | "service";
  capacity: number; // L
  stock: number; // L
}

export interface Transfer {
  id: string;
  no: string; // 驳运单编号
  fromTankId: string;
  toTankId: string;
  startISO: string; // 计划开始
  endISO: string; // 计划结束
  declared: number; // 申报量 L
  actual?: number; // 完工实收量 L
  status: TransferStatus;
  createdAt: string;
  finishedAt?: string;
  deviation?: number;
  reviewedAt?: string;
}

export interface AppState {
  version: number;
  activeShiftId: string;
  shifts: Shift[];
  readings: MetricReading[];
  bilges: BilgeRecord[];
  faults: FaultRecord[];
  tanks: Tank[];
  transfers: Transfer[];
}

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */

function seedState(): AppState {
  const today = dateKey();
  const prev: Shift = {
    id: `s-${today}-04-08`,
    label: "04-08班",
    date: today,
    note: "发电机#2 冷却水温偏高，已复查；舱底水接近警戒线，接班注意观察。",
    handedOver: true,
    handedOverAt: `${today}T08:00:00`,
  };
  const current: Shift = {
    id: `s-${today}-08-12`,
    label: "08-12班",
    date: today,
    note: "",
    handedOver: false,
  };

  const reading = (
    label: string,
    hm: string,
    rpm: number,
    lube: number,
    temp: number,
    fuel: number
  ): MetricReading => ({
    id: `r-${today}-${hm.replace(":", "")}`,
    shiftId: label === "prev" ? prev.id : current.id,
    at: `${today}T${hm}:00`,
    rpm,
    lubePressure: lube,
    coolantTemp: temp,
    fuelUsed: fuel,
  });

  return {
    version: 1,
    activeShiftId: current.id,
    shifts: [prev, current],
    readings: [
      reading("prev", "06:00", 82, 0.42, 74, 28),
      reading("prev", "07:30", 83, 0.41, 76, 30),
      reading("cur", "09:00", 85, 0.43, 72, 26),
    ],
    bilges: [
      {
        id: "b-seed-1",
        shiftId: prev.id,
        at: `${today}T07:40:00`,
        level: "警戒线",
        note: "舱底水位接近警戒线，已加强值守。",
      },
    ],
    faults: [
      {
        id: "f-seed-1",
        shiftId: prev.id,
        at: `${today}T05:20:00`,
        device: "发电机#2",
        description: "冷却水温偏高，巡检时达到 88℃。",
        status: "已处理",
      },
    ],
    tanks: [
      { id: "tank-storage-p", name: "左燃油储存舱", kind: "storage", capacity: 60000, stock: 42000 },
      { id: "tank-storage-s", name: "右燃油储存舱", kind: "storage", capacity: 60000, stock: 38500 },
      { id: "tank-service-p", name: "主机日用油柜", kind: "service", capacity: 8000, stock: 2600 },
      { id: "tank-service-g", name: "发电机日用油柜", kind: "service", capacity: 4000, stock: 1200 },
    ],
    transfers: [],
  };
}

/* ------------------------------------------------------------------ */
/* Store + localStorage 持久化（数据只放浏览器，不接服务）               */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "engine-log-workbench-v1";

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      if (parsed && parsed.version === 1 && parsed.shifts?.length) {
        return parsed;
      }
    }
  } catch {
    // 存储损坏时回落到种子数据
  }
  return seedState();
}

let state: AppState = loadState();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 容量受限时静默保留内存态
  }
}

function setState(next: AppState) {
  state = next;
  persist();
  listeners.forEach((l) => l());
}

export function getState(): AppState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

let seq = Date.now();
function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq.toString(36)}`;
}

function nextTransferNo(st: AppState): string {
  const year = new Date().getFullYear();
  const count = st.transfers.filter((t) => t.no.includes(`BY${year}`)).length + 1;
  return `BY${year}-${String(count).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */
/* 动作                                                                */
/* ------------------------------------------------------------------ */

/** 切换当班班次：已交班的班次不能再次进入 */
export function switchShift(shiftId: string): { ok: boolean; reason?: string } {
  const target = state.shifts.find((s) => s.id === shiftId);
  if (!target) return { ok: false, reason: "班次不存在。" };
  if (target.handedOver) {
    return { ok: false, reason: `${target.label} 已交班，不能切回。` };
  }
  if (state.activeShiftId === shiftId) return { ok: true };
  setState({ ...state, activeShiftId: shiftId });
  return { ok: true };
}

/** 打开/创建当日某班次（班次切换时按需创建） */
export function openShift(
  label: ShiftLabel
): { ok: boolean; reason?: string } {
  const today = dateKey();
  let shift = state.shifts.find((s) => s.date === today && s.label === label);
  if (!shift) {
    shift = {
      id: uid(`s-${today}`),
      label,
      date: today,
      note: "",
      handedOver: false,
    };
    setState({ ...state, shifts: [...state.shifts, shift], activeShiftId: shift.id });
    return { ok: true };
  }
  return switchShift(shift.id);
}

export interface ReadingInput {
  rpm: number;
  lubePressure: number;
  coolantTemp: number;
  fuelUsed: number;
}

export function addReading(input: ReadingInput): { ok: boolean; reason?: string } {
  const shift = state.shifts.find((s) => s.id === state.activeShiftId);
  if (!shift || shift.handedOver) {
    return { ok: false, reason: "请先切换到一个未交班的当班班次。" };
  }
  if (
    [input.rpm, input.lubePressure, input.coolantTemp, input.fuelUsed].some(
      (v) => !Number.isFinite(v)
    )
  ) {
    return { ok: false, reason: "四项指标均需填写有效数字。" };
  }
  if (input.rpm < 0 || input.lubePressure < 0 || input.coolantTemp < 0 || input.fuelUsed < 0) {
    return { ok: false, reason: "指标数值不能为负。" };
  }
  const record: MetricReading = {
    id: uid("r"),
    shiftId: shift.id,
    at: new Date().toISOString(),
    rpm: input.rpm,
    lubePressure: input.lubePressure,
    coolantTemp: input.coolantTemp,
    fuelUsed: input.fuelUsed,
  };
  setState({ ...state, readings: [...state.readings, record] });
  return { ok: true };
}

export function addBilge(
  level: BilgeRecord["level"],
  note: string
): { ok: boolean; reason?: string } {
  const shift = state.shifts.find((s) => s.id === state.activeShiftId);
  if (!shift || shift.handedOver) {
    return { ok: false, reason: "请先切换到一个未交班的当班班次。" };
  }
  const record: BilgeRecord = {
    id: uid("b"),
    shiftId: shift.id,
    at: new Date().toISOString(),
    level,
    note: note.trim(),
  };
  setState({ ...state, bilges: [...state.bilges, record] });
  return { ok: true };
}

export function addFault(
  device: string,
  description: string
): { ok: boolean; reason?: string } {
  const shift = state.shifts.find((s) => s.id === state.activeShiftId);
  if (!shift || shift.handedOver) {
    return { ok: false, reason: "请先切换到一个未交班的当班班次。" };
  }
  if (!device.trim() || !description.trim()) {
    return { ok: false, reason: "设备名称和异常描述都要填写。" };
  }
  const record: FaultRecord = {
    id: uid("f"),
    shiftId: shift.id,
    at: new Date().toISOString(),
    device: device.trim(),
    description: description.trim(),
    status: "待处理",
  };
  setState({ ...state, faults: [...state.faults, record] });
  return { ok: true };
}

export function resolveFault(id: string) {
  setState({
    ...state,
    faults: state.faults.map((f) =>
      f.id === id ? { ...f, status: "已处理" } : f
    ),
  });
}

export function saveShiftNote(note: string) {
  setState({
    ...state,
    shifts: state.shifts.map((s) =>
      s.id === state.activeShiftId ? { ...s, note } : s
    ),
  });
}

/** 确认交班：驳运未结束（与班次时间窗相交的待驳运/驳运中单）则阻断 */
export function confirmHandover(): { ok: boolean; reason?: string } {
  const shift = state.shifts.find((s) => s.id === state.activeShiftId);
  if (!shift) return { ok: false, reason: "当前没有当班班次。" };
  if (shift.handedOver) return { ok: false, reason: "本班次已经交班。" };
  const blockers = handoverBlockers(state.transfers, shift);
  if (blockers.length > 0) {
    return {
      ok: false,
      reason: `驳运未结束（${blockers.map((b) => b.no).join("、")}），不能确认交班。`,
    };
  }
  const handed: Shift = {
    ...shift,
    handedOver: true,
    handedOverAt: new Date().toISOString(),
  };
  const shifts = state.shifts.map((s) => (s.id === shift.id ? handed : s));
  setState({ ...state, shifts });
  return { ok: true };
}

/* ---------------- 燃油舱驳运 ---------------- */

/**
 * 新增驳运申报单。调用方先过 checkTransferDraft，
 * 不通过则整单不保存，舱量和日志不动。
 */
export function createTransfer(draft: TransferDraft): {
  ok: boolean;
  reason?: string;
} {
  const transfer: Transfer = {
    id: uid("tr"),
    no: nextTransferNo(state),
    fromTankId: draft.fromTankId,
    toTankId: draft.toTankId,
    startISO: draft.startISO,
    endISO: draft.endISO,
    declared: round3(draft.declared),
    status: "planned",
    createdAt: new Date().toISOString(),
  };
  setState({ ...state, transfers: [...state.transfers, transfer] });
  return { ok: true };
}

export function startTransfer(id: string): { ok: boolean; reason?: string } {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return { ok: false, reason: "驳运单不存在。" };
  if (t.status !== "planned") {
    return { ok: false, reason: "只有待驳运单可以开始。" };
  }
  setState({
    ...state,
    transfers: state.transfers.map((x) =>
      x.id === id ? { ...x, status: "running" } : x
    ),
  });
  return { ok: true };
}

/**
 * 完工登记：起点舱先按申报量扣除；
 * 偏差超过 2% → 待复核，终点舱暂不入账；偏差 ≤ 2% → 终点按实收入账。
 */
export function finishTransfer(
  id: string,
  actual: number
): { ok: boolean; reason?: string } {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return { ok: false, reason: "驳运单不存在。" };
  if (t.status !== "running") {
    return { ok: false, reason: "只有驳运中的单据可以登记完工。" };
  }
  const outcome = evaluateFinish(actual, t.declared);
  if ("ok" in outcome && !outcome.ok) {
    return { ok: false, reason: outcome.reason };
  }
  const result = outcome as { status: "completed" | "review"; rate: number };
  const updated: Transfer = {
    ...t,
    actual: round3(actual),
    deviation: result.rate,
    status: result.status,
    finishedAt: new Date().toISOString(),
  };
  setState({
    ...state,
    tanks: tanksAfterFinish(state.tanks, updated, actual),
    transfers: state.transfers.map((x) => (x.id === id ? updated : x)),
  });
  return { ok: true };
}

/**
 * 复核通过：终点舱按实收量补入账。
 * 待复核单据在复核前不得修正 —— 页面层不提供任何编辑入口。
 */
export function reviewTransfer(id: string): { ok: boolean; reason?: string } {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return { ok: false, reason: "驳运单不存在。" };
  if (t.status !== "review" || t.actual == null) {
    return { ok: false, reason: "只有待复核单据可以复核入账。" };
  }
  const updated: Transfer = {
    ...t,
    status: "reviewed",
    reviewedAt: new Date().toISOString(),
  };
  setState({
    ...state,
    tanks: tanksAfterReview(state.tanks, updated),
    transfers: state.transfers.map((x) => (x.id === id ? updated : x)),
  });
  return { ok: true };
}

/** 仅未开工的待驳运单可以撤销；驳运中/待复核单据不得改动 */
export function cancelTransfer(id: string): { ok: boolean; reason?: string } {
  const t = state.transfers.find((x) => x.id === id);
  if (!t) return { ok: false, reason: "驳运单不存在。" };
  if (t.status !== "planned") {
    return {
      ok: false,
      reason:
        t.status === "review"
          ? "待复核单据复核前不得修正或撤销。"
          : "驳运已开始，不能撤销。",
    };
  }
  setState({
    ...state,
    transfers: state.transfers.filter((x) => x.id !== id),
  });
  return { ok: true };
}

/** 清空浏览器本地数据并回到种子状态 */
export function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
  setState(seedState());
}
