"use client";

import { useEffect, useState, useCallback } from "react";
import { Activity, ArrowUpLeft, Check, ChevronDown, Clock3, Globe2, RefreshCw, Search, ShieldCheck, Wifi } from "lucide-react";
import type { PublicStatus } from "@/server/public-status";
import styles from "./public-status.module.css";

const labels: Record<string, string> = { healthy: "اتصال مناسب", degraded: "کندی یا ناپایداری", offline: "اختلال اتصال", unknown: "در حال بررسی" };
const date = (value: number | string) => new Intl.DateTimeFormat("fa-IR", { timeZone: "Asia/Tehran", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));

export function StatusPage({ initialData }: { initialData?: PublicStatus }) {
  const [data, setData] = useState<PublicStatus | undefined>(initialData);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [days, setDays] = useState(30);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const res = await fetch("/api/status", { cache: "no-store", signal });
      if (!res.ok) throw new Error();
      setData(await res.json()); setError(false);
    } catch { if (!signal?.aborted) setError(true); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (!initialData) void refresh(controller.signal);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(controller.signal); }, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh, initialData]);
  const healthy = data?.nodes.filter(s => s.status === "healthy").length ?? 0;
  const degraded = data?.nodes.filter(s => s.status === "degraded" || s.status === "offline").length ?? 0;
  const unknown = data?.nodes.filter(s => s.status === "unknown").length ?? 0;
  const stale = error || Boolean(data && Date.now() - data.updatedAt > 90000);
  const allOk = Boolean(data?.nodes.length && healthy === data.nodes.length && !stale);
  const shown = data?.nodes.filter(s => `${s.name} ${s.location}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || (filter === "issues" ? s.status !== "healthy" : s.status === "healthy")));
  return <main className={styles.page} dir="rtl" lang="fa">
    <div className={styles.shell}>
      <header className={styles.header}>
        <a href="/status" className={styles.brand}><span className={styles.logo}><Activity size={23}/></span><span dir="ltr">NodeGuard<span className={styles.brandSub}> / status</span></span></a>
        <a className={styles.headerLink} href="#nodes">وضعیت نودها <ArrowUpLeft size={15}/></a>
      </header>
      <section className={styles.hero}>
        <div className={styles.eyebrow}><span className={styles.dot}/> شفاف، لحظه‌به‌لحظه</div>
        <h1>نبض شبکه، در یک نگاه.</h1>
        <p>نام نود را مثل برنامه V2ray خود پیدا کنید و از وضعیت اتصال آن باخبر شوید.</p>
      </section>
      {data?.simulation && <div className={styles.notice}>حالت نمایشی · اطلاعات این محیط آزمایشی است و وضعیت واقعی سرویس را نشان نمی‌دهد.</div>}
      <section className={`${styles.summary} ${allOk ? styles.good : styles.attention}`} aria-live="polite">
        <span className={styles.summaryIcon}>{allOk ? <ShieldCheck size={31}/> : <Activity size={31}/>}</span>
        <div><h2>{stale ? "ارتباط با سامانه پایش برقرار نیست" : !data ? "در حال دریافت وضعیت شبکه…" : !data.nodes.length ? "هنوز نودی ثبت نشده است" : allOk ? "همه نودها آماده اتصال هستند" : degraded ? "بخشی از شبکه با اختلال روبه‌رو است" : "وضعیت برخی نودها نیازمند بررسی است"}</h2><p>{stale ? "اطلاعات نمایش‌داده‌شده ممکن است قدیمی باشد." : "وضعیت بر اساس آخرین مشاهدات سامانه پایش گزارش می‌شود."}</p></div>
        <span className={styles.live}><span className={styles.dot}/>{stale ? "قطع ارتباط" : "پایش خودکار"}</span>
      </section>
      <div className={styles.stats}>
        {[{ icon: Globe2, value: data?.nodes.length, label: "کل نودها" }, { icon: Check, value: healthy, label: "اتصال مناسب" }, { icon: Wifi, value: degraded, label: "کندی یا اختلال" }, { icon: Clock3, value: unknown, label: "نیازمند بررسی" }].map(({icon: Icon, value, label}) => <div key={label}><Icon size={18}/><strong>{data ? value?.toLocaleString("fa-IR") : "—"}</strong><span>{label}</span></div>)}
      </div>
      <section id="nodes" className={styles.section}>
        <div className={styles.sectionHead}><div><h2>وضعیت نودها</h2><p>کیفیت لحظه‌ای اتصال نودها</p></div>{data?.historyEnabled && <label className={styles.range}><select aria-label="بازه تاریخچه" value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>۳۰ روز گذشته</option><option value={7}>۷ روز گذشته</option></select><ChevronDown size={14}/></label>}</div>
        <div className={styles.tools}><div className={styles.tabs}>{[["all","همه نودها"],["healthy","اتصال مناسب"],["issues","نیازمند توجه"]].map(([key,label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? styles.active : ""} onClick={() => setFilter(key)}>{label}</button>)}</div><label className={styles.search}><Search size={16}/><input aria-label="جستجوی نود" placeholder="نام نود را جستجو کنید…" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
        <div className={styles.serverList}>
          {!data && <div className={styles.empty}>{error ? "دریافت اطلاعات ممکن نشد. دوباره تلاش کنید." : "در حال دریافت اطلاعات نودها…"}</div>}
          {data && !shown?.length && <div className={styles.empty}>نودی با این نام پیدا نشد.</div>}
          {shown?.map((s,i) => <details open className={styles.server} key={`${s.name}-${i}`}>
            <summary><span className={styles.serverIdentity}><span className={styles.country}>{s.country}</span><span><strong>{s.name}</strong><small>{s.location}</small></span></span><span className={styles.badge} data-state={stale ? "unknown" : s.status}><span className={styles.dot}/>{labels[stale ? "unknown" : s.status]}</span><ChevronDown className={styles.expand} size={17}/></summary>
            <p className={styles.nodeMessage}>{stale ? "اطلاعات تازه در دسترس نیست؛ کمی بعد دوباره بررسی کنید." : s.status === "healthy" ? "می‌توانید از این نود استفاده کنید." : s.status === "degraded" ? "ممکن است اتصال کند شود یا گاهی قطع و وصل شود. در صورت مشکل، نود دیگری انتخاب کنید." : s.status === "offline" ? "این نود فعلاً اتصال قابل استفاده ندارد. نود دیگری انتخاب کنید." : "هنوز اطلاعات کافی برای تأیید اتصال نداریم. کمی بعد دوباره بررسی کنید."}</p>
            <div className={styles.qualityGrid}>{[
              { name: "امکان اتصال", state: s.connection, good: "برقرار", bad: "قطع", weak: "ناپایدار" },
              { name: "سرعت اتصال", state: s.speed, good: "مناسب", bad: "نامشخص", weak: s.speedLabel },
              { name: "پایداری اتصال", state: s.stability, good: "پایدار", bad: "ناپایدار", weak: "قطع و وصل احتمالی" },
            ].map(q => <div key={q.name}><span>{q.name}</span><strong data-state={stale ? "unknown" : q.state}><i className={styles.dot}/>{stale || q.state === "unknown" ? "در حال بررسی" : q.state === "healthy" ? q.good : q.state === "offline" ? q.bad : q.weak}</strong></div>)}</div>
            {data?.historyEnabled && <div className={styles.history}><div className={styles.bars}>{s.history.slice(-days).map(d => <span key={d.at} tabIndex={0} data-state={d.status} title={`${date(d.at)} · ${labels[d.status]}`}/>)}</div><div className={styles.historyCaption}><span>{days === 30 ? "۳۰" : "۷"} روز پیش</span><span>امروز</span></div></div>}
          </details>)}
        </div>
        <div className={styles.legend}>{[["healthy","اتصال مناسب"],["degraded","کندی یا ناپایداری"],["offline","اختلال اتصال"],["unknown","اطلاعات کافی نداریم"]].map(([key,label])=><span key={key}><i data-state={key}/>{label}</span>)}</div>
      </section>
      <section className={styles.incidents}><div className={styles.sectionHead}><div><h2>آخرین رخدادها</h2><p>آخرین تغییرات اتصال نودها</p></div><span className={styles.muted}>به وقت تهران</span></div>{data?.incidents.length ? data.incidents.map((incident,i)=><article key={i}><span className={styles.incidentDot} data-resolved={incident.resolved}/><div><span className={styles.incidentLabel}>{incident.resolved ? "رفع شده" : "در حال بررسی"}</span><h3>{incident.title}</h3><time>{date(incident.at)}</time></div></article>) : <div className={styles.noIncidents}><ShieldCheck size={22}/><div><strong>{data ? "رخدادی ثبت نشده است" : "در حال دریافت رخدادها"}</strong><p>رخدادهای ثبت‌شده و وضعیت رفع آن‌ها در این بخش نمایش داده می‌شود.</p></div></div>}</section>
      <aside className={styles.explanation}><Activity size={20}/><p>سبز یعنی اتصال مناسب، زرد یعنی احتمال کندی یا قطع و وصل، و قرمز یعنی اختلال اتصال. خاکستری یعنی اطلاعات کافی نداریم. اگر نود شما مشکل دارد، نود دیگری در برنامه انتخاب کنید. کیفیت اتصال ممکن است با توجه به اینترنت شما متفاوت باشد.</p></aside>
      <footer className={styles.footer}><span dir="ltr">NodeGuard <span className={styles.brandSub}>Status</span></span><span aria-live="polite">{data ? `آخرین به‌روزرسانی: ${date(data.updatedAt)}` : "به‌روزرسانی هر ۳۰ ثانیه"}</span><button disabled={busy} onClick={()=>void refresh()}><RefreshCw size={14} className={busy ? styles.spinning : ""}/>{busy ? "در حال دریافت" : "به‌روزرسانی"}</button></footer>
    </div>
  </main>;
}
