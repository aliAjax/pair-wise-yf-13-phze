import { useMemo, useRef, useState } from "react";
import {
  addBilge,
  addFault,
  addReading,
  cancelTransfer,
  confirmHandover,
  createTransfer,
  DEVICE_FILTERS,
  FAULT_STATUSES,
  finishTransfer,
  openShift,
  resetAll,
  resolveFault,
  reviewTransfer,
  saveShiftNote,
  SHIFT_LABELS,
  startTransfer,
  switchShift,
  TRANSFER_STATUS_TEXT,
  useAppState,
  BILGE_LEVELS,
  type Shift,
  type Tank,
  type Transfer,
} from "./state";
import {
  checkTransferDraft,
  dateKey,
  deviceGroup,
  deviationRate,
  fmtDateTime,
  fmtNum,
  fmtTime,
  isoToLocalInput,
  localInputToISO,
  summarizeShift,
  TOLERANCE,
} from "./rules";

/* ------------------------------------------------------------------ */
/* 通用小组件                                                          */
/* ------------------------------------------------------------------ */

type Notify = (text: string, kind?: "ok" | "err") => void;

function Panel({
  title,
  tag,
  children,
  className = "",
}: {
  title: string;
  tag?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {tag && <span className="panel-tag">{tag}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  unit,
  children,
}: {
  label: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {unit && <em>{unit}</em>}
      </span>
      {children}
    </label>
  );
}

function StatusPill({ status }: { status: Transfer["status"] }) {
  return <span className={`pill pill-${status}`}>{TRANSFER_STATUS_TEXT[status]}</span>;
}

/* ------------------------------------------------------------------ */
/* 班次切换栏                                                          */
/* ------------------------------------------------------------------ */

function ShiftBar({ notify }: { notify: Notify }) {
  const st = useAppState();
  const today = dateKey();

  const handleClick = (label: string) => {
    const existing = st.shifts.find((s) => s.date === today && s.label === label);
    const res = existing
      ? switchShift(existing.id)
      : openShift(label as Shift["label"]);
    if (!res.ok) notify(res.reason ?? "操作失败", "err");
  };

  return (
    <Panel title="当班班次" tag={today}>
      <div className="shift-grid">
        {SHIFT_LABELS.map((label) => {
          const shift = st.shifts.find((s) => s.date === today && s.label === label);
          const isActive = shift?.id === st.activeShiftId;
          return (
            <button
              key={label}
              className={`shift-chip ${isActive ? "active" : ""} ${
                shift && !shift.handedOver ? "opened" : ""
              } ${shift?.handedOver ? "done" : ""}`}
              onClick={() => handleClick(label)}
              disabled={shift?.handedOver}
              title={shift?.handedOver ? "该班次已交班" : ""}
            >
              <b>{label}</b>
              <small>
                {shift?.handedOver
                  ? "✓ 已交班"
                  : isActive
                    ? "当班中"
                    : shift
                      ? "未交班"
                      : "点击开班"}
              </small>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 四项指标看板 + 登记                                                  */
/* ------------------------------------------------------------------ */

const EMPTY_READING = { rpm: "", lube: "", temp: "", fuel: "" };

function MetricsBoard() {
  const st = useAppState();
  const shift = st.shifts.find((s) => s.id === st.activeShiftId);
  const shiftReadings = shift
    ? st.readings.filter((r) => r.shiftId === shift.id)
    : [];
  const latest = shiftReadings[shiftReadings.length - 1];
  const locked = !shift || shift.handedOver;

  const cards = [
    { label: "主机转速", value: latest ? fmtNum(latest.rpm, 0) : "—", unit: "rpm" },
    {
      label: "滑油回路压力",
      value: latest ? fmtNum(latest.lubePressure, 2) : "—",
      unit: "MPa",
    },
    {
      label: "冷却水温",
      value: latest ? fmtNum(latest.coolantTemp, 1) : "—",
      unit: "℃",
    },
    {
      label: "日用柜耗油量",
      value: latest ? fmtNum(latest.fuelUsed, 1) : "—",
      unit: "L/班累计口径",
    },
  ];

  return (
    <Panel
      title="机舱参数看板"
      tag={shift ? shift.label : "无当班班次"}
      className="metrics-panel"
    >
      <div className="metric-grid">
        {cards.map((c) => (
          <article key={c.label}>
            <small>{c.label}</small>
            <strong>{c.value}</strong>
            <em>{c.unit}</em>
          </article>
        ))}
      </div>
      {locked && (
        <p className="hint warn">
          {shift ? "本班次已交班，不可再登记。" : "请先在上方切换到当班班次后再登记。"}
        </p>
      )}
    </Panel>
  );
}

function ReadingForm({ notify }: { notify: Notify }) {
  const st = useAppState();
  const shift = st.shifts.find((s) => s.id === st.activeShiftId);
  const locked = !shift || shift.handedOver;
  const [form, setForm] = useState(EMPTY_READING);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addReading({
      rpm: parseFloat(form.rpm),
      lubePressure: parseFloat(form.lube),
      coolantTemp: parseFloat(form.temp),
      fuelUsed: parseFloat(form.fuel),
    });
    if (!res.ok) {
      notify(res.reason ?? "登记失败", "err");
      return;
    }
    notify("四项指标已登记");
    setForm(EMPTY_READING);
  };

  return (
    <Panel title="参数登记" tag="主机转数 · 滑油 · 水温 · 油耗">
      <form className="form" onSubmit={submit}>
        <div className="form-grid four">
          <Field label="主机转数" unit="rpm">
            <input
              type="number"
              step="1"
              min="0"
              required
              disabled={locked}
              value={form.rpm}
              onChange={set("rpm")}
              placeholder="如 85"
            />
          </Field>
          <Field label="滑油回路压力" unit="MPa">
            <input
              type="number"
              step="0.01"
              min="0"
              required
              disabled={locked}
              value={form.lube}
              onChange={set("lube")}
              placeholder="如 0.42"
            />
          </Field>
          <Field label="冷却水温" unit="℃">
            <input
              type="number"
              step="0.1"
              min="0"
              required
              disabled={locked}
              value={form.temp}
              onChange={set("temp")}
              placeholder="如 72.0"
            />
          </Field>
          <Field label="日用柜耗油量" unit="L">
            <input
              type="number"
              step="0.1"
              min="0"
              required
              disabled={locked}
              value={form.fuel}
              onChange={set("fuel")}
              placeholder="本班耗油 如 26"
            />
          </Field>
        </div>
        <button className="primary" type="submit" disabled={locked}>
          登记参数
        </button>
      </form>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 舱底水 + 设备异常登记                                                */
/* ------------------------------------------------------------------ */

function ExtraForms({ notify }: { notify: Notify }) {
  const st = useAppState();
  const shift = st.shifts.find((s) => s.id === st.activeShiftId);
  const locked = !shift || shift.handedOver;

  const [level, setLevel] = useState<(typeof BILGE_LEVELS)[number]>("正常");
  const [bilgeNote, setBilgeNote] = useState("");
  const [device, setDevice] = useState("");
  const [desc, setDesc] = useState("");

  const submitBilge = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addBilge(level, bilgeNote);
    if (!res.ok) {
      notify(res.reason ?? "保存失败", "err");
      return;
    }
    notify("舱底水状态已记录");
    setLevel("正常");
    setBilgeNote("");
  };

  const submitFault = (e: React.FormEvent) => {
    e.preventDefault();
    const res = addFault(device, desc);
    if (!res.ok) {
      notify(res.reason ?? "保存失败", "err");
      return;
    }
    notify("设备异常已加入时间线");
    setDevice("");
    setDesc("");
  };

  return (
    <div className="extra-grid">
      <Panel title="新增舱底水状态">
        <form className="form" onSubmit={submitBilge}>
          <Field label="液位状态">
            <select
              value={level}
              disabled={locked}
              onChange={(e) => setLevel(e.target.value as typeof level)}
            >
              {BILGE_LEVELS.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </Field>
          <Field label="情况说明">
            <input
              value={bilgeNote}
              disabled={locked}
              onChange={(e) => setBilgeNote(e.target.value)}
              placeholder="如：左舱污水井水位上升"
            />
          </Field>
          <button className="primary" type="submit" disabled={locked}>
            记录舱底水
          </button>
        </form>
      </Panel>

      <Panel title="新增设备异常">
        <form className="form" onSubmit={submitFault}>
          <Field label="设备名称">
            <input
              value={device}
              disabled={locked}
              onChange={(e) => setDevice(e.target.value)}
              placeholder="如：发电机#2 / 主机滑油泵"
            />
          </Field>
          <Field label="异常描述">
            <input
              value={desc}
              disabled={locked}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="现象、读数、初步处置"
            />
          </Field>
          <button className="primary" type="submit" disabled={locked}>
            登记异常
          </button>
        </form>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 异常时间线                                                          */
/* ------------------------------------------------------------------ */

function FaultTimeline({ notify }: { notify: Notify }) {
  const st = useAppState();
  const shiftMap = new Map(st.shifts.map((s) => [s.id, s]));
  const faults = [...st.faults].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );

  return (
    <Panel title="异常时间线" tag={`${faults.length} 条`}>
      {faults.length === 0 ? (
        <p className="hint">暂无设备异常记录。</p>
      ) : (
        <ol className="timeline">
          {faults.map((f) => (
            <li key={f.id} className={f.status === "已处理" ? "resolved" : ""}>
              <div className="tl-dot" />
              <div className="tl-body">
                <div className="tl-meta">
                  <time>{fmtDateTime(f.at)}</time>
                  <span className="badge">{f.device}</span>
                  <span className={`tag-${f.status === "已处理" ? "ok" : "warn"}`}>
                    {f.status}
                  </span>
                  <small>{shiftMap.get(f.shiftId)?.label ?? "未知班次"}</small>
                </div>
                <p>{f.description}</p>
                {f.status !== "已处理" && (
                  <button
                    className="mini"
                    onClick={() => {
                      resolveFault(f.id);
                      notify("异常已标记为已处理");
                    }}
                  >
                    标记已处理
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 设备筛选历史记录                                                     */
/* ------------------------------------------------------------------ */

interface HistoryEntry {
  id: string;
  at: string;
  group: string;
  shiftLabel: string;
  title: string;
  detail: string;
}

function HistoryBoard() {
  const st = useAppState();
  const [filter, setFilter] = useState<(typeof DEVICE_FILTERS)[number]>("全部");
  const shiftMap = new Map(st.shifts.map((s) => [s.id, s]));
  const tankMap = new Map(st.tanks.map((t) => [t.id, t]));

  const entries = useMemo<HistoryEntry[]>(() => {
    const list: HistoryEntry[] = [];
    for (const r of st.readings) {
      list.push({
        id: r.id,
        at: r.at,
        group: "主机",
        shiftLabel: shiftMap.get(r.shiftId)?.label ?? "",
        title: "机舱参数登记",
        detail: `转速 ${fmtNum(r.rpm, 0)} rpm · 滑油 ${fmtNum(
          r.lubePressure,
          2
        )} MPa · 水温 ${fmtNum(r.coolantTemp, 1)} ℃ · 油耗 ${fmtNum(
          r.fuelUsed,
          1
        )} L`,
      });
    }
    for (const b of st.bilges) {
      list.push({
        id: b.id,
        at: b.at,
        group: "舱底水",
        shiftLabel: shiftMap.get(b.shiftId)?.label ?? "",
        title: `舱底水状态 · ${b.level}`,
        detail: b.note || "无补充说明",
      });
    }
    for (const f of st.faults) {
      list.push({
        id: f.id,
        at: f.at,
        group: deviceGroup(f.device),
        shiftLabel: shiftMap.get(f.shiftId)?.label ?? "",
        title: `异常 · ${f.device}（${f.status}）`,
        detail: f.description,
      });
    }
    for (const t of st.transfers) {
      const from = tankMap.get(t.fromTankId)?.name ?? "?";
      const to = tankMap.get(t.toTankId)?.name ?? "?";
      list.push({
        id: t.id,
        at: t.startISO,
        group: "燃油系统",
        shiftLabel: "",
        title: `驳运 ${t.no} · ${TRANSFER_STATUS_TEXT[t.status]}`,
        detail: `${from} → ${to}｜申报 ${fmtNum(t.declared, 0)} L${
          t.actual != null ? `｜实收 ${fmtNum(t.actual, 0)} L` : ""
        }｜计划 ${fmtDateTime(t.startISO)}–${fmtTime(t.endISO)}`,
      });
    }
    return list
      .filter((e) => filter === "全部" || e.group === filter)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [st, filter]);

  return (
    <Panel title="历史记录" tag="按设备筛选">
      <div className="chips">
        {DEVICE_FILTERS.map((d) => (
          <button
            key={d}
            className={filter === d ? "selected" : ""}
            onClick={() => setFilter(d)}
          >
            {d}
          </button>
        ))}
      </div>
      {entries.length === 0 ? (
        <p className="hint">该设备分类下暂无记录。</p>
      ) : (
        <div className="records">
          {entries.map((e) => (
            <article key={e.id}>
              <time>{fmtDateTime(e.at)}</time>
              <div>
                <h3>
                  <span className="badge">{e.group}</span>
                  {e.title}
                  {e.shiftLabel && <small>　{e.shiftLabel}</small>}
                </h3>
                <p>{e.detail}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 燃油舱驳运                                                           */
/* ------------------------------------------------------------------ */

function TankCard({ tank }: { tank: Tank }) {
  const pct = Math.min(100, (tank.stock / tank.capacity) * 100);
  return (
    <div className="tank-card">
      <div className="tank-head">
        <b>{tank.name}</b>
        <span className="badge">{tank.kind === "storage" ? "储存舱" : "日用柜"}</span>
      </div>
      <div className="tank-bar">
        <i style={{ width: `${pct.toFixed(1)}%` }} />
      </div>
      <p>
        存量 <strong>{fmtNum(tank.stock, 0)}</strong> / {fmtNum(tank.capacity, 0)} L
        <small>　剩余空间 {fmtNum(tank.capacity - tank.stock, 0)} L</small>
      </p>
    </div>
  );
}

function TransferPanel({ notify }: { notify: Notify }) {
  const st = useAppState();
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [start, setStart] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [end, setEnd] = useState(() =>
    isoToLocalInput(new Date(Date.now() + 2 * 3600_000).toISOString())
  );
  const [declared, setDeclared] = useState("");
  const [finishingId, setFinishingId] = useState<string | null>(null);
  const [actual, setActual] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const draft = {
      fromTankId: fromId,
      toTankId: toId,
      startISO: localInputToISO(start),
      endISO: localInputToISO(end),
      declared: parseFloat(declared),
    };
    const check = checkTransferDraft(draft, st.tanks, st.transfers);
    if (!check.ok) {
      // 起点存量不足 / 终点空间不足 / 时段重叠：整单不保存，舱量和日志不动
      notify(check.reason, "err");
      return;
    }
    const res = createTransfer(draft);
    if (!res.ok) {
      notify(res.reason ?? "申报失败", "err");
      return;
    }
    notify("驳运申报单已保存");
    setFromId("");
    setToId("");
    setDeclared("");
  };

  const doFinish = (t: Transfer) => {
    const value = parseFloat(actual);
    const res = finishTransfer(t.id, value);
    if (!res.ok) {
      notify(res.reason ?? "完工登记失败", "err");
      return;
    }
    const rate = deviationRate(value, t.declared);
    if (rate > TOLERANCE) {
      notify(
        `实收偏差 ${(rate * 100).toFixed(2)}% 超过 2%：起点舱已扣，终点舱暂不入账，单据待复核，复核前不得修正。`,
        "err"
      );
    } else {
      notify(`驳运单 ${t.no} 已完工，两舱量已同步更新。`);
    }
    setFinishingId(null);
    setActual("");
  };

  const transfers = [...st.transfers].sort(
    (a, b) => new Date(b.startISO).getTime() - new Date(a.startISO).getTime()
  );

  return (
    <Panel title="燃油舱驳运" tag="申报 · 完工 · 复核">
      <div className="tank-grid">
        {st.tanks.map((t) => (
          <TankCard key={t.id} tank={t} />
        ))}
      </div>

      <form className="form transfer-form" onSubmit={submit}>
        <h3>新增驳运申报</h3>
        <p className="hint">
          起点存量不足、终点空间不足或计划时段重叠时，整单不保存，舱量与日志均不改动。
        </p>
        <div className="form-grid">
          <Field label="起点舱">
            <select required value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">选择起点舱</option>
              {st.tanks.map((t) => (
                <option key={t.id} value={t.id} disabled={t.id === toId}>
                  {t.name}（存量 {fmtNum(t.stock, 0)} L）
                </option>
              ))}
            </select>
          </Field>
          <Field label="终点舱">
            <select required value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">选择终点舱</option>
              {st.tanks.map((t) => (
                <option key={t.id} value={t.id} disabled={t.id === fromId}>
                  {t.name}（余容 {fmtNum(t.capacity - t.stock, 0)} L）
                </option>
              ))}
            </select>
          </Field>
          <Field label="计划开始">
            <input
              type="datetime-local"
              required
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="计划结束">
            <input
              type="datetime-local"
              required
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </Field>
          <Field label="申报驳运量" unit="L">
            <input
              type="number"
              step="1"
              min="0"
              required
              value={declared}
              onChange={(e) => setDeclared(e.target.value)}
              placeholder="如 2000"
            />
          </Field>
        </div>
        <button className="primary" type="submit">
          提交申报
        </button>
      </form>

      <div className="transfer-list">
        <h3>驳运单（{transfers.length}）</h3>
        {transfers.length === 0 ? (
          <p className="hint">暂无驳运单。</p>
        ) : (
          transfers.map((t) => {
            const from = st.tanks.find((x) => x.id === t.fromTankId);
            const to = st.tanks.find((x) => x.id === t.toTankId);
            return (
              <article key={t.id} className={`transfer-row status-${t.status}`}>
                <div className="tr-main">
                  <div className="tr-title">
                    <b>{t.no}</b>
                    <StatusPill status={t.status} />
                  </div>
                  <p>
                    {from?.name ?? "?"} → {to?.name ?? "?"}
                  </p>
                  <p className="muted">
                    计划 {fmtDateTime(t.startISO)} – {fmtDateTime(t.endISO)}｜申报{" "}
                    {fmtNum(t.declared, 0)} L
                    {t.actual != null && (
                      <>
                        ｜实收 {fmtNum(t.actual, 0)} L｜偏差{" "}
                        <b
                          className={
                            (t.deviation ?? 0) > TOLERANCE ? "dev-over" : "dev-ok"
                          }
                        >
                          {((t.deviation ?? 0) * 100).toFixed(2)}%
                        </b>
                      </>
                    )}
                  </p>
                  {t.status === "review" && (
                    <p className="hint warn">
                      偏差超过 2%，终点舱暂不入账；复核前不得修正本单。
                    </p>
                  )}
                </div>
                <div className="tr-actions">
                  {t.status === "planned" && (
                    <>
                      <button
                        className="mini primary"
                        onClick={() => {
                          const r = startTransfer(t.id);
                          if (!r.ok) notify(r.reason ?? "操作失败", "err");
                          else notify(`驳运单 ${t.no} 已开始`);
                        }}
                      >
                        开始驳运
                      </button>
                      <button
                        className="mini"
                        onClick={() => {
                          const r = cancelTransfer(t.id);
                          if (!r.ok) notify(r.reason ?? "操作失败", "err");
                          else notify(`驳运单 ${t.no} 已撤销`);
                        }}
                      >
                        撤销
                      </button>
                    </>
                  )}
                  {t.status === "running" &&
                    (finishingId === t.id ? (
                      <span className="finish-inline">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          autoFocus
                          placeholder="实收量 L"
                          value={actual}
                          onChange={(e) => setActual(e.target.value)}
                        />
                        <button
                          className="mini primary"
                          onClick={() => doFinish(t)}
                        >
                          确认完工
                        </button>
                        <button
                          className="mini"
                          onClick={() => {
                            setFinishingId(null);
                            setActual("");
                          }}
                        >
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        className="mini primary"
                        onClick={() => {
                          setFinishingId(t.id);
                          setActual("");
                        }}
                      >
                        完工登记
                      </button>
                    ))}
                  {t.status === "review" && (
                    <button
                      className="mini primary"
                      onClick={() => {
                        const r = reviewTransfer(t.id);
                        if (!r.ok) notify(r.reason ?? "复核失败", "err");
                        else notify(`驳运单 ${t.no} 复核通过，终点舱已按实收入账。`);
                      }}
                    >
                      复核入账
                    </button>
                  )}
                </div>
              </article>
            );
          })
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 交接摘要                                                             */
/* ------------------------------------------------------------------ */

function HandoverPanel({ notify }: { notify: Notify }) {
  const st = useAppState();
  const shift = st.shifts.find((s) => s.id === st.activeShiftId);

  if (!shift) {
    return (
      <Panel title="交接班摘要">
        <p className="hint warn">请先切换到当班班次。</p>
      </Panel>
    );
  }

  const summary = summarizeShift(
    shift,
    st.readings,
    st.bilges,
    st.faults,
    st.transfers
  );
  const locked = shift.handedOver;

  const doConfirm = () => {
    const res = confirmHandover();
    if (!res.ok) {
      notify(res.reason ?? "交班失败", "err");
      return;
    }
    notify(`${shift.label} 已交班`);
  };

  return (
    <Panel
      title="交接班摘要"
      tag={`${shift.label} · ${shift.date}${locked ? " · 已交班" : ""}`}
    >
      {summary.blockers.length > 0 && (
        <p className="banner-block">
          驳运未结束（{summary.blockers.map((b) => b.no).join("、")}），不能确认交班。
        </p>
      )}

      <div className="summary-grid">
        <div>
          <small>末次参数读数</small>
          {summary.lastReading ? (
            <table className="kv">
              <tbody>
                <tr>
                  <td>主机转数</td>
                  <td>{fmtNum(summary.lastReading.rpm, 0)} rpm</td>
                </tr>
                <tr>
                  <td>滑油回路压力</td>
                  <td>{fmtNum(summary.lastReading.lubePressure, 2)} MPa</td>
                </tr>
                <tr>
                  <td>冷却水温</td>
                  <td>{fmtNum(summary.lastReading.coolantTemp, 1)} ℃</td>
                </tr>
                <tr>
                  <td>本班日用油耗量</td>
                  <td>{fmtNum(summary.fuelTotal, 1)} L</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="hint">本班尚无参数登记。</p>
          )}
        </div>
        <div>
          <small>舱底水与异常</small>
          <p className="kv-line">
            舱底水登记：{summary.bilges.length} 次
            {summary.latestBilge && (
              <>
                ，末次「{summary.latestBilge.level}」
              </>
            )}
          </p>
          <p className="kv-line">
            设备异常：{summary.faults.length} 项，
            <b className={summary.openFaults.length ? "dev-over" : "dev-ok"}>
              未闭环 {summary.openFaults.length} 项
            </b>
          </p>
          <small>本班驳运</small>
          {summary.transfers.length === 0 ? (
            <p className="hint">本班时段内无驳运安排。</p>
          ) : (
            <ul className="mini-list">
              {summary.transfers.map((t) => (
                <li key={t.id}>
                  {t.no} <StatusPill status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Field label="交接备注">
        <textarea
          rows={3}
          value={shift.note}
          disabled={locked}
          placeholder="向下一班次交代注意事项（自动保存到浏览器）"
          onChange={(e) => saveShiftNote(e.target.value)}
        />
      </Field>

      <div className="handover-foot">
        {locked ? (
          <span className="tag-ok">本班次已于 {fmtDateTime(shift.handedOverAt!)} 交班</span>
        ) : (
          <button
            className="primary"
            onClick={doConfirm}
            disabled={summary.blockers.length > 0}
            title={
              summary.blockers.length > 0 ? "驳运未结束，不能确认交班" : "确认交班"
            }
          >
            确认交班
          </button>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 工作台总装                                                          */
/* ------------------------------------------------------------------ */

export default function Workbench() {
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const notify: Notify = (text, kind = "ok") => {
    setMsg({ text, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 4200);
  };

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p>ENGINE ROOM LOG</p>
          <h1>轮机日志工作台</h1>
        </div>
        <div className="topbar-right">
          <span>数据仅保存在本浏览器</span>
          <button
            className="ghost"
            onClick={() => {
              if (window.confirm("清空本机全部轮机日志数据并恢复示例？")) {
                resetAll();
                setMsg({ text: "已清空并恢复示例数据", kind: "ok" });
              }
            }}
          >
            清空本机数据
          </button>
        </div>
      </header>

      {msg && (
        <div className={`banner ${msg.kind === "err" ? "banner-err" : "banner-ok"}`}>
          {msg.text}
        </div>
      )}

      <ShiftBar notify={notify} />

      <MetricsBoard />

      <div className="grid-two">
        <ReadingForm notify={notify} />
        <ExtraForms notify={notify} />
      </div>

      <div className="grid-two">
        <FaultTimeline notify={notify} />
        <HandoverPanel notify={notify} />
      </div>

      <TransferPanel notify={notify} />

      <HistoryBoard />

      <footer className="foot">
        纯前端工作台：状态（src/state.ts）、规则（src/rules.ts）、页面（src/pages.tsx）分离 ·
        刷新保留 · 不接服务 · 无第三方依赖
      </footer>
    </main>
  );
}
