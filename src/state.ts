// 业务文件一：状态层
// 数据结构、浏览器本地持久化、useStore 与各动作入口。
// 所有涉及业务规则的判定都委托给 rules.ts，状态层不自行解释规则。

import { useSyncExternalStore } from "react";
import {
  addAnomaly as addAnomalyRule,
  addBilge as addBilgeRule,
  addReading as addReadingRule,
  approveReview as approveReviewRule,
  createTransfer as createTransferRule,
  deleteTransfer as deleteTransferRule,
  finishTransfer as finishTransferRule,
  rejectReview as rejectReviewRule,
  resolveAnomaly as resolveAnomalyRule,
  startTransfer as startTransferRule,
  transfersBlocking,
  type Result,
} from "./rules";

export type Watch = "00-04" | "04-08" | "08-12" | "12-16" | "16-20" | "20-24";
export const WATCHES: Watch[] = ["00-04", "04-08", "08-12", "12-16", "16-20", "20-24"];

export interface Shift {
  id: string; // YYYY-MM-DD + 班次，如 2026-09-22/08-12
  date: string;
  watch: Watch;
  confirmed: boolean;
  handoverNote: string;
  confirmedAt?: string;
}

export interface Tank {
  id: string;
  name: string;
  capacity: number; // 立方米
  level: number; // 当前存量 立方米
  service?: boolean; // 日用柜
}

export interface Reading {
  id: string;
  shiftId: string;
  at: string;
  rpm: number; // 主机转速 r/min
  lubePressure: number; // 滑油回路压力 MPa
  coolingTemp: number; // 冷却水温 ℃
  fuelBurn: number; // 日用柜耗油量 立方米
}

export interface BilgeEntry {
  id: string;
  shiftId: string;
  at: string;
  levelStatus: "正常" | "偏高" | "高位报警";
  pumped: boolean;
  remark: string;
}

export type Severity = "一般" | "严重" | "紧急";
export type Equipment = "主机" | "发电机" | "泵组" | "舱底水" | "燃油驳运泵";
export const EQUIPMENTS: Equipment[] = ["主机", "发电机", "泵组", "舱底水", "燃油驳运泵"];

export interface Anomaly {
  id: string;
  shiftId: string;
  at: string;
  equipment: Equipment;
  description: string;
  severity: Severity;
  handled: boolean;
  handledAt?: string;
}

export type TransferStatus = "planned" | "running" | "review" | "done";
export type TransferFinishDecision = "accepted" | "review";

export interface Transfer {
  id: string;
  shiftId: string; // 登记班次
  fromTank: string;
  toTank: string;
  startAt: string;
  endAt: string;
  declared: number; // 申报量 立方米
  actual?: number; // 实收量 立方米
  status: TransferStatus;
  deviation?: number; // 偏差比例（实收-申报）/申报
  reviewNote?: string;
  finishedAt?: string;
  reviewDecision?: TransferFinishDecision;
  events: { at: string; type: "created" | "started" | "finished" | "reviewed"; note?: string }[];
}

export interface AppState {
  version: 1;
  shifts: Shift[];
  currentShiftId: string;
  tanks: Tank[];
  readings: Reading[];
  bilges: BilgeEntry[];
  anomalies: Anomaly[];
  transfers: Transfer[];
}

const STORAGE_KEY = "marine-engine-log:v1";
export const DAILY_TANK_ID = "service";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDateParts(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function watchAt(date: Date): Watch {
  const idx = Math.min(5, Math.floor(date.getHours() / 4));
  return WATCHES[idx];
}

export function shiftId(date: string, watch: Watch): string {
  return `${date}/${watch}`;
}

export function uid(prefix: string): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}

function seed(): AppState {
  const now = new Date();
  const date = localDateParts(now);
  const watch = watchAt(now);
  const sid = shiftId(date, watch);
  const iso = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();

  return {
    version: 1,
    shifts: [{ id: sid, date, watch, confirmed: false, handoverNote: "" }],
    currentShiftId: sid,
    tanks: [
      { id: "storage-p", name: "左燃油储存舱", capacity: 120, level: 86 },
      { id: "storage-s", name: "右燃油储存舱", capacity: 120, level: 54 },
      { id: "settling", name: "沉淀柜", capacity: 18, level: 9 },
      { id: "service", name: "日用柜", capacity: 12, level: 7.2, service: true },
    ],
    readings: [
      {
        id: uid("rd"),
        shiftId: sid,
        at: iso(95),
        rpm: 82,
        lubePressure: 0.42,
        coolingTemp: 76,
        fuelBurn: 0.18,
      },
      {
        id: uid("rd"),
        shiftId: sid,
        at: iso(40),
        rpm: 84,
        lubePressure: 0.41,
        coolingTemp: 78,
        fuelBurn: 0.21,
      },
    ],
    bilges: [
      {
        id: uid("bl"),
        shiftId: sid,
        at: iso(60),
        levelStatus: "正常",
        pumped: false,
        remark: "舱底水位正常，未见明显油污。",
      },
    ],
    anomalies: [
      {
        id: uid("an"),
        shiftId: sid,
        at: iso(55),
        equipment: "发电机",
        description: "2号发电机冷却水温偏高，已调低负荷并安排复查。",
        severity: "一般",
        handled: false,
      },
    ],
    transfers: [],
  };
}

function load(): AppState {
  const fallback = seed();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.version !== 1) return fallback;
    for (const key of ["shifts", "tanks", "readings", "bilges", "anomalies", "transfers"] as const) {
      if (!Array.isArray(parsed[key])) return fallback;
    }
    if (!parsed.shifts.some((s) => s.id === parsed.currentShiftId)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

let state: AppState = load();
const listeners = new Set<() => void>();

function persist(next: AppState) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储空间不足等情况：内存状态仍然生效，只是本次无法持久化
  }
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): AppState {
  return state;
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function currentShift(s: AppState): Shift {
  return s.shifts.find((x) => x.id === s.currentShiftId) ?? s.shifts[0];
}

function apply<T>(run: (draft: AppState) => Result<T>): Result<T> {
  const draft = structuredClone(state) as AppState;
  const result = run(draft);
  if (result.ok) persist(draft);
  return result;
}

// ---- 班次 ----

export function switchShift(date: string, watch: Watch): Result<{ shiftId: string; created: boolean }> {
  return apply((draft) => {
    const id = shiftId(date, watch);
    const existing = draft.shifts.find((s) => s.id === id);
    if (!existing) {
      draft.shifts.push({ id, date, watch, confirmed: false, handoverNote: "" });
    }
    draft.currentShiftId = id;
    return { ok: true, value: { shiftId: id, created: !existing } };
  });
}

export function setHandoverNote(note: string): Result<null> {
  return apply((draft) => {
    const sh = currentShift(draft);
    if (sh.confirmed) return { ok: false, errors: ["本班次已确认交班，备注锁定。"] };
    sh.handoverNote = note;
    return { ok: true, value: null };
  });
}

// ---- 机舱参数 / 舱底水 / 异常 ----

export type ReadingDraft = {
  at: string;
  rpm: number;
  lubePressure: number;
  coolingTemp: number;
  fuelBurn: number;
};

export function addReading(draft: ReadingDraft): Result<Reading> {
  return apply((s) => addReadingRule(s, currentShift(s).id, draft));
}

export type BilgeDraft = {
  at: string;
  levelStatus: BilgeEntry["levelStatus"];
  pumped: boolean;
  remark: string;
};

export function addBilge(draft: BilgeDraft): Result<BilgeEntry> {
  return apply((s) => addBilgeRule(s, currentShift(s).id, draft));
}

export type AnomalyDraft = {
  at: string;
  equipment: Equipment;
  description: string;
  severity: Severity;
};

export function addAnomaly(draft: AnomalyDraft): Result<Anomaly> {
  return apply((s) => addAnomalyRule(s, currentShift(s).id, draft));
}

export function resolveAnomaly(id: string, handled: boolean, at: string): Result<null> {
  return apply((s) => resolveAnomalyRule(s, currentShift(s).id, id, handled, at));
}

// ---- 燃油舱驳运 ----

export type TransferDraftInput = {
  fromTank: string;
  toTank: string;
  startAt: string;
  endAt: string;
  declared: number;
};

export function createTransfer(draft: TransferDraftInput): Result<Transfer> {
  return apply((s) => createTransferRule(s, currentShift(s).id, draft));
}

export function startTransfer(id: string, at: string): Result<null> {
  return apply((s) => startTransferRule(s, currentShift(s).id, id, at));
}

export function deleteTransfer(id: string): Result<null> {
  return apply((s) => deleteTransferRule(s, currentShift(s).id, id));
}

export function finishTransfer(id: string, actual: number, at: string): Result<Transfer> {
  return apply((s) => finishTransferRule(s, currentShift(s).id, id, actual, at));
}

export function approveReview(id: string, at: string, note: string): Result<null> {
  return apply((s) => approveReviewRule(s, currentShift(s).id, id, at, note));
}

export function rejectReview(id: string, at: string, note: string): Result<null> {
  return apply((s) => rejectReviewRule(s, currentShift(s).id, id, at, note));
}

// ---- 交班 ----

export function confirmHandover(at: string): Result<Shift> {
  return apply((s) => {
    const sh = currentShift(s);
    if (sh.confirmed) return { ok: false, errors: ["本班次已确认交班。"] };
    const blockers = transfersBlocking(s, sh.id);
    if (blockers.length > 0) {
      return {
        ok: false,
        errors: blockers.map((t) => {
          const from = s.tanks.find((x) => x.id === t.fromTank)?.name ?? t.fromTank;
          const to = s.tanks.find((x) => x.id === t.toTank)?.name ?? t.toTank;
          const label =
            t.status === "review"
              ? "偏差超 2%，待复核"
              : t.status === "running"
                ? "驳运进行中"
                : "计划时段尚未结束";
          return `驳运单 ${from} → ${to}：${label}，不能交班。`;
        }),
      };
    }
    sh.confirmed = true;
    sh.confirmedAt = at;
    return { ok: true, value: sh };
  });
}

export function resetAll(): void {
  persist(seed());
}
