// 业务文件三：页面层
// 轮机日志工作台：班次切换、四项指标看板、登记表单、驳运单流转、
// 异常时间线、交接摘要与设备筛选。所有规则判定调用 state/rules，页面不写规则。

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addAnomaly,
  addBilge,
  addReading,
  approveReview,
  confirmHandover,
  createTransfer,
  currentShift,
  deleteTransfer,
  EQUIPMENTS,
  finishTransfer,
  localDateParts,
  rejectReview,
  resetAll,
  resolveAnomaly,
  setHandoverNote,
  shiftId as makeShiftId,
  startTransfer,
  switchShift,
  WATCHES,
  watchAt,
  useStore,
  type Anomaly,
  type AppState,
  type Equipment,
  type Reading,
  type Severity,
  type Transfer,
  type Watch,
} from "./state";
import {
  fmt,
  fmtTime,
  formatDeviation,
  localInputValue,
  round3,
  transfersBlocking,
  type Result,
} from "./rules";

type Filter = Equipment | "全部";
const FILTERS: Filter[] = ["全部", ...EQUIPMENTS];

// ---------- 通用小部件 ----------

function useMsg() {
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 6000);
    return () => clearTimeout(t);
  }, [msg]);
  const show = <T,>(r: Result<T>, okText: string) =>
    setMsg(r.ok ? { kind: "ok", text: okText } : { kind: "err", text: r.errors.join("；") });
  return { msg, show, setMsg };
}

function FormMsg({ msg }: { msg: { kind: "ok" | "err"; text: string } | null }) {
  if (!msg) return null;
  return <p className={msg.kind === "ok" ? "form-msg ok" : "form-msg err"}>{msg.text}</p>;
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const TRANSFER_STATUS: Record<Transfer["status"], { label: string; tone: string }> = {
  planned: { label: "待开工", tone: "muted" },
  running: { label: "进行中", tone: "blue" },
  review: { label: "待复核", tone: "orange" },
  done: { label: "已完成", tone: "green" },
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ---------- 班次切换 ----------

function ShiftBar({ s }: { s: AppState }) {
  const sh = currentShift(s);
  const [date, setDate] = useState(sh.date);
  const [watch, setWatch] = useState(sh.watch);
  const { msg, show } = useMsg();

  useEffect(() => {
    setDate(sh.date);
    setWatch(sh.watch);
  }, [sh.id]);

  const jump = (offset: number) => {
    const startHour = WATCHES.indexOf(sh.watch) * 4;
    const base = new Date(`${sh.date}T00:00:00`);
    base.setHours(startHour + offset);
    show(switchShift(localDateParts(base), watchAt(base)), "已切换班次。");
  };

  return (
    <section className="panel shift-bar">
      <div className="shift-current">
        <small>当前当班班次{sh.confirmed && "（已交班锁定）"}</small>
        <h2>
          {sh.date} <b>{sh.watch}</b> 班
        </h2>
      </div>
      <div className="shift-switch">
        <label>
          <span>值班日期</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span>班次时段</span>
          <select value={watch} onChange={(e) => setWatch(e.target.value as Watch)}>
            {WATCHES.map((w) => (
              <option key={w} value={w}>
                {w} 班
              </option>
            ))}
          </select>
        </label>
        <div className="shift-actions">
          <button onClick={() => show(switchShift(date, watch), "已切换/开立班次。")}>
            切换 / 开班
          </button>
          <button onClick={() => jump(-4)} title="向前切换一个班次">
            上一班
          </button>
          <button onClick={() => jump(4)} title="向后切换一个班次">
            下一班
          </button>
        </div>
      </div>
      <FormMsg msg={msg} />
    </section>
  );
}

// ---------- 四项指标看板 ----------

function shiftReadings(s: AppState, shiftId: string): Reading[] {
  return s.readings
    .filter((r) => r.shiftId === shiftId)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function MetricCards({ s }: { s: AppState }) {
  const sh = currentShift(s);
  const list = shiftReadings(s, sh.id);
  const latest = list[list.length - 1];
  const prev = list[list.length - 2];
  const fuelTotal = round3(list.reduce((sum, r) => sum + r.fuelBurn, 0));
  const service = s.tanks.find((t) => t.service);

  const delta = (key: "rpm" | "lubePressure" | "coolingTemp") => {
    if (!latest || !prev) return null;
    const d = round3(latest[key] - prev[key]);
    return d === 0 ? "持平" : d > 0 ? `▲ ${Math.abs(d)}` : `▼ ${Math.abs(d)}`;
  };

  const cards = [
    {
      name: "主机转速",
      value: latest ? String(latest.rpm) : "—",
      unit: "r/min",
      sub: latest ? `较上次：${delta("rpm")}` : "本班暂无登记",
    },
    {
      name: "滑油回路压力",
      value: latest ? latest.lubePressure.toFixed(2) : "—",
      unit: "MPa",
      sub: latest ? `较上次：${delta("lubePressure")}` : "本班暂无登记",
    },
    {
      name: "冷却水温",
      value: latest ? String(latest.coolingTemp) : "—",
      unit: "℃",
      sub: latest ? `较上次：${delta("coolingTemp")}` : "本班暂无登记",
    },
    {
      name: "日用柜耗油",
      value: String(fuelTotal),
      unit: "m³",
      sub: service ? `日用柜存量 ${service.level}m³ / ${service.capacity}m³` : "本班暂无登记",
    },
  ];

  return (
    <section className="metrics">
      {cards.map((c) => (
        <article key={c.name}>
          <small>{c.name}</small>
          <strong>
            {c.value} <em>{c.unit}</em>
          </strong>
          <span className="metric-sub">{c.sub}</span>
        </article>
      ))}
    </section>
  );
}

// ---------- 机舱参数登记 ----------

function ReadingForm({ locked }: { locked: boolean }) {
  const [at, setAt] = useState(() => localInputValue(new Date()));
  const [rpm, setRpm] = useState("84");
  const [lube, setLube] = useState("0.42");
  const [cool, setCool] = useState("78");
  const [burn, setBurn] = useState("0.2");
  const { msg, show } = useMsg();

  const submit = () => {
    const r = addReading({
      at,
      rpm: parseFloat(rpm),
      lubePressure: parseFloat(lube),
      coolingTemp: parseFloat(cool),
      fuelBurn: parseFloat(burn),
    });
    if (r.ok) {
      show(r, "参数已登记，日用柜存量已同步扣减。");
      setAt(localInputValue(new Date()));
    } else show(r, "");
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>机舱参数</p>
          <h2>主机四项指标登记</h2>
        </div>
        <Badge tone="blue">主机</Badge>
      </div>
      <fieldset className="form-grid" disabled={locked}>
        <label className="full">
          <span>登记时间</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label>
          <span>主机转速 (r/min)</span>
          <input inputMode="decimal" value={rpm} onChange={(e) => setRpm(e.target.value)} />
        </label>
        <label>
          <span>滑油回路压力 (MPa)</span>
          <input inputMode="decimal" value={lube} onChange={(e) => setLube(e.target.value)} />
        </label>
        <label>
          <span>冷却水温 (℃)</span>
          <input inputMode="decimal" value={cool} onChange={(e) => setCool(e.target.value)} />
        </label>
        <label>
          <span>日用柜耗油量 (m³)</span>
          <input inputMode="decimal" value={burn} onChange={(e) => setBurn(e.target.value)} />
        </label>
        <div className="full form-actions">
          <button className="primary" type="button" onClick={submit}>
            登记参数
          </button>
          <span className="hint">耗油将实时扣减日用柜存量；存量不足则整笔不保存。</span>
        </div>
      </fieldset>
      <FormMsg msg={msg} />
    </section>
  );
}

// ---------- 舱底水 ----------

function BilgeForm({ s, locked }: { s: AppState; locked: boolean }) {
  const sh = currentShift(s);
  const [at, setAt] = useState(() => localInputValue(new Date()));
  const [status, setStatus] = useState<BilgeStatus>("正常");
  const [pumped, setPumped] = useState(false);
  const [remark, setRemark] = useState("");
  const { msg, show } = useMsg();

  const entries = s.bilges
    .filter((b) => b.shiftId === sh.id)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const submit = () => {
    const r = addBilge({ at, levelStatus: status, pumped, remark });
    if (r.ok) {
      show(r, "舱底水状态已记录。");
      setRemark("");
      setPumped(false);
      setStatus("正常");
    } else show(r, "");
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>舱底水</p>
          <h2>舱底水状态</h2>
        </div>
        <Badge tone="teal">舱底水</Badge>
      </div>
      <fieldset className="form-grid" disabled={locked}>
        <label>
          <span>记录时间</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label>
          <span>液位状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as BilgeStatus)}>
            {(["正常", "偏高", "高位报警"] as BilgeStatus[]).map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={pumped} onChange={(e) => setPumped(e.target.checked)} />
          <span>已进行舱底水泵排</span>
        </label>
        <label className="full">
          <span>巡检备注</span>
          <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="如：左舷污水井见少量油花" />
        </label>
        <div className="full form-actions">
          <button className="primary" type="button" onClick={submit}>
            新增舱底水记录
          </button>
        </div>
      </fieldset>
      <FormMsg msg={msg} />
      <div className="mini-list">
        {entries.length === 0 && <p className="empty">本班暂无舱底水记录</p>}
        {entries.map((b) => (
          <div className="mini-item" key={b.id}>
            <span className="mini-time">{fmtTime(b.at)}</span>
            <Badge
              tone={b.levelStatus === "正常" ? "green" : b.levelStatus === "偏高" ? "orange" : "red"}
            >
              {b.levelStatus}
            </Badge>
            <span className="mini-text">
              {b.pumped ? "已泵排" : "未泵排"}
              {b.remark ? ` · ${b.remark}` : ""}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

type BilgeStatus = "正常" | "偏高" | "高位报警";

// ---------- 设备异常 ----------

function AnomalyForm({
  s,
  locked,
  filter,
}: {
  s: AppState;
  locked: boolean;
  filter: Filter;
}) {
  const sh = currentShift(s);
  const [at, setAt] = useState(() => localInputValue(new Date()));
  const [equipment, setEquipment] = useState<Equipment>("主机");
  const [severity, setSeverity] = useState<Severity>("一般");
  const [description, setDescription] = useState("");
  const { msg, show } = useMsg();

  const submit = () => {
    const r = addAnomaly({ at, equipment, severity, description });
    if (r.ok) {
      show(r, "异常已登记到时间线。");
      setDescription("");
    } else show(r, "");
  };

  const list = s.anomalies
    .filter((a) => a.shiftId === sh.id)
    .filter((a) => filter === "全部" || a.equipment === filter)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>巡检异常</p>
          <h2>设备异常登记 / 时间线</h2>
        </div>
      </div>
      <fieldset className="form-grid" disabled={locked}>
        <label>
          <span>异常时间</span>
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        <label>
          <span>关联设备</span>
          <select value={equipment} onChange={(e) => setEquipment(e.target.value as Equipment)}>
            {EQUIPMENTS.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label>
          <span>严重程度</span>
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            <option>一般</option>
            <option>严重</option>
            <option>紧急</option>
          </select>
        </label>
        <label className="full">
          <span>异常描述</span>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="现象、声响、参数变化、已采取措施"
          />
        </label>
        <div className="full form-actions">
          <button className="primary" type="button" onClick={submit}>
            新增异常
          </button>
        </div>
      </fieldset>
      <FormMsg msg={msg} />

      <ol className="timeline">
        {list.length === 0 && <p className="empty">本班暂无异常记录{filter !== "全部" ? `（${filter}）` : ""}</p>}
        {list.map((a: Anomaly) => (
          <li key={a.id} className={`tl-item sev-${a.severity}${a.handled ? " handled" : ""}`}>
            <span className="tl-dot" />
            <div className="tl-body">
              <div className="tl-head">
                <time>{fmt(a.at)}</time>
                <Badge
                  tone={a.severity === "紧急" ? "red" : a.severity === "严重" ? "orange" : "blue"}
                >
                  {a.severity}
                </Badge>
                <Badge tone="muted">{a.equipment}</Badge>
                {a.handled && <Badge tone="green">已处理</Badge>}
              </div>
              <p>{a.description}</p>
              {!locked && (
                <button
                  className="link-btn"
                  onClick={() =>
                    show(
                      resolveAnomaly(a.id, !a.handled, new Date().toISOString()),
                      a.handled ? "已重新标记为未处理。" : "已标记处理。",
                    )
                  }
                >
                  {a.handled ? "撤销处理标记" : "标记已处理"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- 燃油舱驳运 ----------

function TransferPanel({ s, locked }: { s: AppState; locked: boolean }) {
  const sh = currentShift(s);
  const tankName = (id: string) => s.tanks.find((t) => t.id === id)?.name ?? id;
  const [from, setFrom] = useState(s.tanks[0]?.id ?? "");
  const [to, setTo] = useState(s.tanks[3]?.id ?? s.tanks[1]?.id ?? "");
  const [startAt, setStartAt] = useState(() => localInputValue(new Date()));
  const [endAt, setEndAt] = useState(() =>
    localInputValue(new Date(Date.now() + 2 * 3600_000)),
  );
  const [declared, setDeclared] = useState("2");
  const { msg, show } = useMsg();

  const fromTank = s.tanks.find((t) => t.id === from);
  const toTank = s.tanks.find((t) => t.id === to);
  const declaredNum = parseFloat(declared);

  const orders = s.transfers
    .filter((t) => t.shiftId === sh.id)
    .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt));

  const submit = () => {
    const r = createTransfer({
      fromTank: from,
      toTank: to,
      startAt,
      endAt,
      declared: declaredNum,
    });
    if (r.ok) show(r, "驳运单已保存（尚未动账）。");
    else show(r, "");
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>燃油舱驳运</p>
          <h2>新增驳运单</h2>
        </div>
        <Badge tone="orange">燃油驳运泵</Badge>
      </div>

      <fieldset className="form-grid" disabled={locked}>
        <label>
          <span>起点舱（出）</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {s.tanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}（存 {t.level}/{t.capacity}m³）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>终点舱（入）</span>
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {s.tanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}（空位 {round3(t.capacity - t.level)}/{t.capacity}m³）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>计划开始</span>
          <input
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </label>
        <label>
          <span>计划结束</span>
          <input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
        </label>
        <label className="full">
          <span>申报驳运量 (m³)</span>
          <input
            inputMode="decimal"
            value={declared}
            onChange={(e) => setDeclared(e.target.value)}
          />
        </label>
        <div className="full check-line">
          <span className="hint">
            三关校验：起点存量 {fromTank ? `${fromTank.level}m³` : "—"}、终点空位{" "}
            {toTank ? `${round3(toTank.capacity - toTank.level)}m³` : "—"}、时段不得重叠；
            任一不过则整单不保存，舱量与日志均不动。
          </span>
        </div>
        <div className="full form-actions">
          <button className="primary" type="button" onClick={submit}>
            保存驳运单
          </button>
        </div>
      </fieldset>
      <FormMsg msg={msg} />

      <div className="order-list">
        {orders.length === 0 && <p className="empty">本班暂无驳运单</p>}
        {orders.map((t) => (
          <TransferOrderCard
            key={t.id}
            t={t}
            locked={locked}
            fromName={tankName(t.fromTank)}
            toName={tankName(t.toTank)}
            show={show}
          />
        ))}
      </div>
    </section>
  );
}

function TransferOrderCard({
  t,
  locked,
  fromName,
  toName,
  show,
}: {
  t: Transfer;
  locked: boolean;
  fromName: string;
  toName: string;
  show: <T,>(r: Result<T>, ok: string) => void;
}) {
  const [actual, setActual] = useState("");
  const [note, setNote] = useState("");
  const meta = TRANSFER_STATUS[t.status];

  return (
    <article className={`order-card status-${t.status}`}>
      <div className="order-head">
        <div>
          <strong>
            {fromName} → {toName}
          </strong>
          <span className="order-window">
            {fmt(t.startAt)} ~ {fmt(t.endAt)}
          </span>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <div className="order-nums">
        <span>
          申报 <b>{t.declared}</b> m³
        </span>
        <span>
          实收 <b>{t.actual ?? "—"}</b> m³
        </span>
        <span>
          偏差 <b className={t.status === "review" ? "text-orange" : ""}>{formatDeviation(t)}</b>
        </span>
      </div>

      {t.status === "review" && (
        <p className="order-warn">
          偏差超过 2%：起点舱已扣 {t.actual}m³，终点舱暂不入账；复核前驳运单不得修正。
        </p>
      )}

      {!locked && (
        <div className="order-actions">
          {t.status === "planned" && (
            <>
              <button onClick={() => show(startTransfer(t.id, new Date().toISOString()), "驳运已开工。")}>
                标记开工
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm("确认删除该待开工驳运单？"))
                    show(deleteTransfer(t.id), "驳运单已删除。");
                }}
              >
                删除
              </button>
            </>
          )}
          {(t.status === "planned" || t.status === "running") && (
            <div className="finish-row">
              <input
                inputMode="decimal"
                placeholder="完工实收量 m³"
                value={actual}
                onChange={(e) => setActual(e.target.value)}
              />
              <button
                className="primary"
                onClick={() =>
                  show(finishTransfer(t.id, parseFloat(actual), new Date().toISOString()), "驳运完工登记完成。")
                }
              >
                登记完工
              </button>
            </div>
          )}
          {t.status === "review" && (
            <div className="review-row">
              <input
                placeholder="复核意见（可选）"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                className="primary"
                onClick={() => {
                  show(approveReview(t.id, new Date().toISOString(), note), "复核通过，终点舱已入账。");
                  setNote("");
                }}
              >
                复核通过
              </button>
              <button
                onClick={() => {
                  if (window.confirm("复核退回后驳运单将回到进行中，可重新登记完工。确认退回？")) {
                    show(rejectReview(t.id, new Date().toISOString(), note), "已退回，驳运单回到进行中。");
                    setNote("");
                    setActual("");
                  }
                }}
              >
                复核退回
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// ---------- 交接摘要 ----------

function HandoverPanel({ s }: { s: AppState }) {
  const sh = currentShift(s);
  const readings = shiftReadings(s, sh.id);
  const fuelTotal = round3(readings.reduce((x, r) => x + r.fuelBurn, 0));
  const bilges = s.bilges.filter((b) => b.shiftId === sh.id);
  const anomalies = s.anomalies.filter((a) => a.shiftId === sh.id);
  const openAnomalies = anomalies.filter((a) => !a.handled);
  const transfers = s.transfers.filter((t) => t.shiftId === sh.id);
  const blockers = transfersBlocking(s, sh.id);

  const [note, setNote] = useState(sh.handoverNote);
  useEffect(() => setNote(sh.handoverNote), [sh.id, sh.confirmed]);
  const { msg, show } = useMsg();

  const doConfirm = () => {
    if (blockers.length > 0) return;
    if (!window.confirm("确认交班后本班所有记录将锁定，仅可切换到其他班次查看。确认继续？")) return;
    show(confirmHandover(new Date().toISOString()), "交班已确认，本班次锁定。");
  };

  return (
    <section className="panel handover">
      <div className="heading">
        <div>
          <p>交接班摘要</p>
          <h2>
            {sh.date} {sh.watch} 班
          </h2>
        </div>
        {sh.confirmed ? (
          <Badge tone="green">已交班 {sh.confirmedAt ? fmt(sh.confirmedAt) : ""}</Badge>
        ) : (
          <Badge tone="blue">当班中</Badge>
        )}
      </div>

      <div className="summary-grid">
        <div>
          <small>参数登记</small>
          <strong>{readings.length}</strong> 次
        </div>
        <div>
          <small>本班耗油</small>
          <strong>{fuelTotal}</strong> m³
        </div>
        <div>
          <small>舱底水记录</small>
          <strong>{bilges.length}</strong> 条
          {bilges.some((b) => b.levelStatus !== "正常") && <em className="text-orange">（含报警）</em>}
        </div>
        <div>
          <small>设备异常</small>
          <strong>
            {openAnomalies.length}/{anomalies.length}
          </strong>
          <em> 未处理/总数</em>
        </div>
        <div>
          <small>驳运单</small>
          <strong>{transfers.length}</strong> 单
          {blockers.length > 0 && <em className="text-orange">（{blockers.length} 单未结束）</em>}
        </div>
      </div>

      {openAnomalies.length > 0 && (
        <div className="summary-block">
          <h4>待处理异常</h4>
          <ul>
            {openAnomalies.map((a) => (
              <li key={a.id}>
                <Badge tone="muted">{a.equipment}</Badge> {fmtTime(a.at)} {a.description}
              </li>
            ))}
          </ul>
        </div>
      )}

      {blockers.length > 0 && (
        <div className="summary-block">
          <h4>交班拦截：驳运未结束</h4>
          <ul>
            {blockers.map((t) => (
              <li key={t.id}>
                <Badge tone={t.status === "review" ? "orange" : "blue"}>
                  {TRANSFER_STATUS[t.status].label}
                </Badge>{" "}
                {s.tanks.find((x) => x.id === t.fromTank)?.name} →{" "}
                {s.tanks.find((x) => x.id === t.toTank)?.name}
                {t.status === "review" && "（偏差超 2%，必须先复核）"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="note-label">
        <span>交接备注</span>
        <textarea
          rows={3}
          value={note}
          disabled={sh.confirmed}
          placeholder="下班需重点关注的设备、参数趋势、遗留事项"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== sh.handoverNote) show(setHandoverNote(note), "交接备注已保存。");
          }}
        />
      </label>

      <FormMsg msg={msg} />
      <div className="form-actions">
        <button className="primary" disabled={sh.confirmed || blockers.length > 0} onClick={doConfirm}>
          确认交班
        </button>
        {blockers.length > 0 && (
          <span className="hint">存在未结束驳运（含待复核），不能确认交班。</span>
        )}
      </div>
    </section>
  );
}

// ---------- 设备筛选 + 油舱存量 ----------

type HistoryItem = {
  id: string;
  at: string;
  shiftId: string;
  equipment: Equipment;
  kind: string;
  summary: string;
};

function buildHistory(s: AppState): HistoryItem[] {
  const tankName = (id: string) => s.tanks.find((t) => t.id === id)?.name ?? id;
  const items: HistoryItem[] = [
    ...s.readings.map((r) => ({
      id: r.id,
      at: r.at,
      shiftId: r.shiftId,
      equipment: "主机" as Equipment,
      kind: "参数登记",
      summary: `转速 ${r.rpm}r/min · 油压 ${r.lubePressure}MPa · 水温 ${r.coolingTemp}℃ · 耗油 ${r.fuelBurn}m³`,
    })),
    ...s.bilges.map((b) => ({
      id: b.id,
      at: b.at,
      shiftId: b.shiftId,
      equipment: "舱底水" as Equipment,
      kind: "舱底水",
      summary: `${b.levelStatus}${b.pumped ? " · 已泵排" : ""}${b.remark ? ` · ${b.remark}` : ""}`,
    })),
    ...s.anomalies.map((a) => ({
      id: a.id,
      at: a.at,
      shiftId: a.shiftId,
      equipment: a.equipment,
      kind: a.handled ? "异常（已处理）" : "异常（未处理）",
      summary: `[${a.severity}] ${a.description}`,
    })),
    ...s.transfers.map((t) => ({
      id: t.id,
      at: t.finishedAt ?? t.startAt,
      shiftId: t.shiftId,
      equipment: "燃油驳运泵" as Equipment,
      kind: `驳运·${TRANSFER_STATUS[t.status].label}`,
      summary: `${tankName(t.fromTank)} → ${tankName(t.toTank)} · 申报 ${t.declared}m³ · 实收 ${
        t.actual ?? "—"
      }m³ · 偏差 ${formatDeviation(t)}`,
    })),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function Sidebar({
  s,
  filter,
  setFilter,
  history,
}: {
  s: AppState;
  filter: Filter;
  setFilter: (f: Filter) => void;
  history: HistoryItem[];
}) {
  return (
    <aside className="sidebar">
      <section className="panel">
        <h2>设备筛选</h2>
        <div className="chips">
          {FILTERS.map((f) => {
            const count = f === "全部" ? history.length : history.filter((h) => h.equipment === f).length;
            return (
              <button
                key={f}
                className={filter === f ? "chip active" : "chip"}
                onClick={() => setFilter(f)}
              >
                {f} <em>{count}</em>
              </button>
            );
          })}
        </div>
        <p className="hint">筛选同时作用于异常时间线与历史记录。</p>
      </section>

      <section className="panel">
        <h2>油舱存量</h2>
        <div className="tank-list">
          {s.tanks.map((t) => {
            const pct = Math.min(100, Math.round((t.level / t.capacity) * 100));
            return (
              <div key={t.id} className="tank-item">
                <div className="tank-head">
                  <span>
                    {t.name}
                    {t.service && <Badge tone="teal">日用柜</Badge>}
                  </span>
                  <span className="tank-num">
                    {t.level}/{t.capacity}m³
                  </span>
                </div>
                <div className="tank-bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </aside>
  );
}

// ---------- 历史记录 ----------

function HistoryPanel({ history, filter }: { history: HistoryItem[]; filter: Filter }) {
  const list = history.filter((h) => filter === "全部" || h.equipment === filter).slice(0, 60);
  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>历史记录</p>
          <h2>全班次工作台流水{filter !== "全部" ? ` · ${filter}` : ""}</h2>
        </div>
      </div>
      <div className="records">
        {list.length === 0 && <p className="empty">没有符合筛选条件的记录</p>}
        {list.map((h, i) => (
          <article key={h.id}>
            <b>{String(list.length - i).padStart(2, "0")}</b>
            <div>
              <h3>
                <Badge tone="muted">{h.equipment}</Badge> {h.kind}
              </h3>
              <p>
                {fmt(h.at)} · {h.shiftId} · {h.summary}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------- 工作台总装 ----------

export default function Workbench() {
  const s = useStore();
  const sh = currentShift(s);
  const [filter, setFilter] = useState<Filter>("全部");
  const history = useMemo(() => buildHistory(s), [s]);
  const now = useClock();

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <p className="eyebrow">轮机日志工作台 · 数据仅存于本机浏览器</p>
          <h1>船舶轮机值班记录</h1>
        </div>
        <div className="topbar-right">
          <span className="clock">
            船时 {fmt(now.toISOString())} · 应值班 {watchAt(now)} 班
          </span>
          <button
            className="ghost"
            onClick={() => {
              if (window.confirm("将清空本机全部轮机日志数据并恢复示例数据，确认继续？")) resetAll();
            }}
          >
            清空本地数据
          </button>
        </div>
      </header>

      <ShiftBar s={s} />

      <MetricCards s={s} />

      <div className="workspace">
        <Sidebar s={s} filter={filter} setFilter={setFilter} history={history} />
        <div className="main-col">
          <ReadingForm key={`r-${sh.id}`} locked={sh.confirmed} />
          <div className="two-col">
            <BilgeForm key={`b-${sh.id}`} s={s} locked={sh.confirmed} />
            <AnomalyForm key={`a-${sh.id}`} s={s} locked={sh.confirmed} filter={filter} />
          </div>
          <TransferPanel key={`t-${sh.id}`} s={s} locked={sh.confirmed} />
        </div>
      </div>

      <HandoverPanel s={s} />
      <HistoryPanel history={history} filter={filter} />

      <footer className="foot">
        不接服务、不加依赖：状态（state.ts）、规则（rules.ts）、页面（pages.tsx）三分，刷新自动保留。
      </footer>
    </main>
  );
}
