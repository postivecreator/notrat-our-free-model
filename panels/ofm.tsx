/**
 * Our Free Model 免费模型池 · 主面板
 * ============================================================================
 * 挂载：manifest.contributions.ui[]
 *   { id:"ofm-panel", location:"right-panel" } + { id:"ofm-page", location:"page" }
 *
 * 数据通路：window.electronAPI.mcp.callTool(props.serverId, tool, args)
 *   返回 MCP 信封 { content:[{ type:"text", text:"<JSON>" }] } → unpack() 解成 payload
 *
 * ── 设计取向（v0.2 重写）────────────────────────────────────────────────
 * 上游那套「六页毛玻璃」界面**不当主视图**。原因不是它丑，而是它不该被塞进
 * 一个 380px 的侧栏：它有自己的一套字体、圆角、侧边导航与留白体系，嵌进来会
 * 在窄栏里挤成一团，而且怎么看都不像 Notrat 自己的一部分。
 *
 * 现在的分工：
 *   · 平时 → 这个面板自己画，全部用 Notrat 的主题变量（--card / --border /
 *     --muted-foreground / --primary / --radius），字号、间距、圆角照抄宿主；
 *   · 要看上游原界面 → 「高级 → 管理界面」，铺一层覆盖层给 iframe，带返回键。
 *     需要它的时候就该占满屏幕，而不是当一幅缩略画天天挂着。
 *
 * ── 三件必须守住的实现约束 ───────────────────────────────────────────────
 * 1. **不 import 任何模块**：宿主用 `new Function(..., "React", code)` 跑本文件，
 *    只注入 React。写 import 会在 `new Function` 里变成语法错误 → 白屏。
 * 2. **样式用内联 + <style>**：Tailwind 不扫描插件源码，写工具类等于没写。
 * 3. **颜色只走 CSS 变量**：写死 hex 在浅色主题下会瞎（语义色除外，但要挑
 *    两套主题都够对比的）。
 *
 * 字段名全部对过真实 payload（server/index.js 的 TOOLS），不是凭印象写的 ——
 * 猜错字段名的后果是一片空白，而空白不报错，只会让人以为"没数据"。
 */
const { useState, useEffect, useCallback, useRef } = React;

/* ──────────────────────────── 主题 token ──────────────────────────── */

/** 全部对应 Notrat 的 shadcn 变量；语义色挑的是两套主题下对比都够的值。 */
const C = {
  fg: "hsl(var(--foreground))",
  card: "hsl(var(--card))",
  border: "hsl(var(--border))",
  muted: "hsl(var(--muted-foreground))",
  soft: "hsl(var(--muted))",
  primary: "hsl(var(--primary))",
  primaryFg: "hsl(var(--primary-foreground))",
  ok: "#30a46c",
  warn: "#f5a524",
  danger: "#e5484d",
  info: "#0090ff",
};

/** 圆角跟宿主同一套：卡片用 --radius，小块往里收 4px。 */
const R_SM = "calc(var(--radius) - 4px)";
const R_MD = "var(--radius)";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/* ──────────────────────────── 图标（内联，零依赖）──────────────────────────── */

const ICONS = {
  play: ["M8 5.5v13l11-6.5z"],
  stop: ["M7 7h10v10H7z"],
  refresh: ["M20.5 12a8.5 8.5 0 1 1-2.5-6", "M20.5 3.5v5h-5"],
  copy: ["M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z", "M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4"],
  check: ["M20 6 9 17l-5-5"],
  external: ["M13 4h7v7", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  terminal: ["M5 8l4 4-4 4", "M12 16h7"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"],
  back: ["M19 12H5", "M12 19l-7-7 7-7"],
  layers: ["M12 3l9 5-9 5-9-5 9-5z", "M3 13l9 5 9-5", "M3 17.5l9 5 9-5"],
  alert: ["M12 8v5", "M12 16.5h.01", "M10.3 4.3 2.6 17.5A1.8 1.8 0 0 0 4.2 20h15.6a1.8 1.8 0 0 0 1.6-2.5L13.7 4.3a1.8 1.8 0 0 0-3.4 0z"],
  dot: ["M12 12h.01"],
};

function Icon(props) {
  const paths = ICONS[props.name] || ICONS.dot;
  const size = props.size || 14;
  const filled = props.name === "play" || props.name === "stop";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={props.weight || 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "0 0 auto", display: "block", ...(props.style || {}) }}
      aria-hidden="true"
    >
      {paths.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}

/* ──────────────────────────── MCP 通路 ──────────────────────────── */

function unpack(res) {
  try {
    if (res == null) return { error: "无返回" };
    if (res && res.error && res.result == null) return { error: String(res.error) };
    const r = res && res.result != null ? res.result : res;
    let text = "";
    if (typeof r === "string") text = r;
    else if (r && typeof r === "object") {
      if (typeof r.content === "string") text = r.content;
      else if (Array.isArray(r.content)) {
        text = r.content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join("");
      } else if (typeof r.text === "string") text = r.text;
    }
    if (!text) return { error: "空返回" };
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/** 调 MCP 工具。永不抛：失败也返回 { error }，由 UI 决定怎么显示。 */
function call(serverId, tool, args) {
  const mcp = window.electronAPI && window.electronAPI.mcp;
  if (!mcp || !mcp.callTool) return Promise.resolve({ error: "electronAPI.mcp 不可用" });
  return Promise.resolve(mcp.callTool(serverId, tool, args || {})).then(unpack, (e) => ({
    error: String((e && e.message) || e),
  }));
}

/* ──────────────────────────── 剪贴板 ──────────────────────────── */

/**
 * 复制。渲染进程从 file:// 加载时 navigator.clipboard 可能被权限拦，
 * 所以保留 execCommand 兜底 —— 两条都失败才算失败。
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 交给系统去解 notrat:// 链接。
 *
 * 不能直接 `location.href = "notrat://…"`：渲染进程导航到自定义 scheme 会被
 * Electron 当成一次页面跳转处理，轻则白屏重则抛 ERR_UNKNOWN_URL_SCHEME。
 * 应用给了一条正经出口 `electronAPI.app.openExternal`，走它就等于在系统里
 * 「双击这个链接」—— Notrat 作为协议持有者收到 URL，自己弹确认框。
 *
 * 三级兜底：openExternal → window.open → 失败（让 UI 提示改用 JSON）。
 */
function openExternal(url) {
  const api = window.electronAPI;
  const direct = api && api.app && api.app.openExternal;
  if (typeof direct === "function") {
    try {
      return Promise.resolve(direct(url)).then(
        () => true,
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }
  try {
    window.open(url, "_blank");
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

/* ──────────────────────────── 通用小件 ──────────────────────────── */

function Btn(props) {
  const variant = props.variant || "ghost";
  const style = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    height: 26,
    padding: props.wide ? "0 12px" : "0 9px",
    fontSize: 12,
    fontWeight: 500,
    lineHeight: 1,
    fontFamily: "inherit",
    borderRadius: R_SM,
    border: `1px solid ${variant === "primary" ? "transparent" : C.border}`,
    background: variant === "primary" ? C.primary : variant === "danger" ? "transparent" : "transparent",
    color:
      variant === "primary" ? C.primaryFg : variant === "danger" ? C.danger : props.muted ? C.muted : C.fg,
    cursor: props.disabled ? "not-allowed" : "pointer",
    opacity: props.disabled ? 0.45 : 1,
    whiteSpace: "nowrap",
    flex: props.grow ? "1 1 auto" : "0 0 auto",
    ...(props.style || {}),
  };
  const cls = props.disabled ? "" : variant === "primary" ? "ofm-btn ofm-btn-primary" : "ofm-btn";
  return (
    <button type="button" className={cls} onClick={props.disabled ? undefined : props.onClick} style={style} title={props.title}>
      {props.icon ? <Icon name={props.icon} size={props.iconSize || 13} /> : null}
      {props.children}
    </button>
  );
}

/** 圆点状态指示。running 时带一圈柔光，静止时也看得出是在"活"。 */
function Dot(props) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: 999,
        background: props.color || C.muted,
        boxShadow: props.pulse ? `0 0 0 3px ${props.color}2e` : "none",
        flex: "0 0 auto",
        display: "inline-block",
      }}
    />
  );
}

/** 细边框小标签。颜色只作用于文字与边框，不铺底色（铺底色在深色主题下会脏）。 */
function Chip(props) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 6px",
        borderRadius: 999,
        border: `1px solid ${props.color ? `${props.color}55` : C.border}`,
        color: props.color || C.muted,
        fontSize: 10,
        lineHeight: 1,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {props.children}
    </span>
  );
}

function Kpi(props) {
  return (
    <div style={{ flex: "1 1 0", minWidth: 0 }}>
      <div
        style={{
          fontSize: 20,
          fontWeight: 600,
          lineHeight: "24px",
          letterSpacing: "-0.02em",
          fontVariantNumeric: "tabular-nums",
          color: props.dim ? C.muted : C.fg,
        }}
      >
        {props.value}
      </div>
      <div style={{ fontSize: 10.5, color: C.muted, lineHeight: "14px" }}>{props.label}</div>
    </div>
  );
}

/** 分段控件。选中项用卡片底色浮起来，跟 Notrat 的 tab 观感一致。 */
function Segmented(props) {
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        padding: 2,
        borderRadius: R_SM,
        background: C.soft,
        flex: "0 0 auto",
      }}
    >
      {props.items.map((item) => {
        const active = item.key === props.value;
        return (
          <button
            key={item.key}
            type="button"
            className="ofm-seg"
            onClick={() => props.onChange(item.key)}
            style={{
              flex: "1 1 0",
              height: 22,
              padding: "0 8px",
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              fontFamily: "inherit",
              lineHeight: 1,
              borderRadius: "calc(var(--radius) - 6px)",
              border: `1px solid ${active ? C.border : "transparent"}`,
              background: active ? C.card : "transparent",
              color: active ? C.fg : C.muted,
              cursor: "pointer",
              whiteSpace: "nowrap",
              boxShadow: active ? "0 1px 2px hsl(var(--foreground) / 0.05)" : "none",
              transition: "color 120ms",
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** 一行「标签 / 值 / 动作」，值是等宽可复制文本。 */
function Field(props) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);

  const doCopy = async () => {
    if (props.value === "" || props.value == null) return;
    const ok = await copyText(String(props.value));
    if (!ok) return;
    setDone(true);
    timer.current = setTimeout(() => setDone(false), 1600);
  };

  return (
    <div
      className={props.value ? "ofm-field" : ""}
      onClick={props.value ? doCopy : undefined}
      title={props.value ? "点击复制" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: R_SM,
        border: `1px solid ${C.border}`,
        background: C.card,
        cursor: props.value ? "pointer" : "default",
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 10.5, color: C.muted, flex: "0 0 auto", minWidth: 52 }}>{props.label}</span>
      <span
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          fontSize: 11.5,
          fontFamily: props.mono ? MONO : "inherit",
          color: props.value ? C.fg : C.muted,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textAlign: props.right ? "right" : "left",
        }}
      >
        {props.value || props.placeholder || "—"}
      </span>
      {props.value ? (
        <span style={{ color: done ? C.ok : C.muted, flex: "0 0 auto", display: "flex" }}>
          <Icon name={done ? "check" : "copy"} size={12} />
        </span>
      ) : null}
    </div>
  );
}

function SectionTitle(props) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: C.muted,
        margin: props.first ? "0 0 6px" : "14px 0 6px",
      }}
    >
      {props.children}
      {props.right ? <span style={{ marginLeft: "auto", letterSpacing: 0, textTransform: "none" }}>{props.right}</span> : null}
    </div>
  );
}

/** 空态 / 引导块。图标 + 一句说明 + 一个动作，不要三行以上的文案。 */
function Empty(props) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: props.tight ? "18px 12px" : "32px 16px",
        textAlign: "center",
      }}
    >
      {props.icon ? (
        <span style={{ color: C.muted, opacity: 0.7 }}>
          <Icon name={props.icon} size={20} />
        </span>
      ) : null}
      <div style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>{props.title}</div>
      {props.desc ? (
        <div style={{ fontSize: 11, color: C.muted, lineHeight: "16px", maxWidth: 260 }}>{props.desc}</div>
      ) : null}
      {props.action ? <div style={{ marginTop: 2 }}>{props.action}</div> : null}
    </div>
  );
}

/* ──────────────────────────── 工具函数 ──────────────────────────── */

/** 上下文窗口压成 256K / 1M，列表里放得下。 */
function formatCtx(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function timeOf(at) {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ──────────────────────────── 主面板 ──────────────────────────── */

const TABS = [
  { key: "wiring", label: "接入" },
  { key: "models", label: "模型" },
  { key: "advanced", label: "高级" },
];

/* 动态视口高度（移动端地址栏收放时）需要 Chromium 108+；
   老版本整条声明会被忽略、height 退回 auto → 空白。先探测再选。 */
const VIEW_H =
  typeof CSS !== "undefined" && CSS.supports && CSS.supports("height", "100dvh")
    ? "100dvh"
    : "100vh";

function OfmPanel(props) {
  const serverId = props && props.serverId;

  /* 引擎状态（轻，5s 一轮） */
  const [engine, setEngine] = useState(null);
  /* 一次性的重活产物：接入三件套 / 模型详情 / 总览 */
  const [wiring, setWiring] = useState(null);
  const [models, setModels] = useState(null);
  const [status, setStatus] = useState(null);

  const [tab, setTab] = useState("wiring");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null); // { kind:"err"|"ok", text }
  const [query, setQuery] = useState("");
  const [logs, setLogs] = useState(null);
  const [showConsole, setShowConsole] = useState(false);
  /* 首屏就是上游那套界面。引擎没起来时它没有地址可嵌，自然落到下面的引导面板。 */
  const [view, setView] = useState("ui"); // "ui" | "panel"
  const [frameGen, setFrameGen] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [width, setWidth] = useState(380);

  const aliveRef = useRef(true);
  const loadedFor = useRef(""); // 记住上一次为哪个端口拉过重活，避免重复

  /* ── 宽度自适应（只读，绝不回写尺寸）───────────────────────────
   *
   * 侧栏 380 ↔ 全页 1000+，同一套代码两副密度。
   *
   * 这里**只读**宽度，不写任何尺寸 —— 所以不存在反馈环。
   * 高度完全交给 CSS（根节点用 100dvh），不走 JS 测量：任何
   * "量容器再写回自身高度"的写法，都会在内容驱动高度的父容器里
   * 形成闭环，把页面越撑越长。
   */
  const [rootEl, setRootEl] = useState(null);

  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const b = entries[0] && entries[0].contentRect;
      if (b && b.width > 0) setWidth(b.width);
    });
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [rootEl]);

  const compact = width < 460;

  /* 首屏过渡态最多停 2.6 秒。engine 一直读不到时不能把用户困在空白页里。 */
  const [bootGaveUp, setBootGaveUp] = useState(false);
  useEffect(() => {
    if (engine !== null) return;
    const timer = setTimeout(() => setBootGaveUp(true), 2600);
    return () => clearTimeout(timer);
  }, [engine]);

  /* ── 轻轮询：只问引擎死活，不碰模型目录 ─────────────────────── */
  const pollEngine = useCallback(async () => {
    if (!serverId) return;
    const next = await call(serverId, "ofm_engine", { action: "info" });
    if (!aliveRef.current) return;
    if (next && next.error) {
      setNote({ kind: "err", text: `状态读取失败：${next.error}` });
      return;
    }
    setEngine(next);
  }, [serverId]);

  /* ── 重活：接入三件套 + 模型详情 + 总览。只在真正需要时拉 ───────── */
  const loadAll = useCallback(
    async (opts) => {
      if (!serverId) return;
      const wantModels = !opts || opts.models !== false;
      const results = await Promise.all([
        call(serverId, "ofm_wiring", {}),
        wantModels ? call(serverId, "ofm_models", { limit: 500 }) : Promise.resolve(null),
        call(serverId, "ofm_status", {}),
      ]);
      if (!aliveRef.current) return;
      const [w, m, s] = results;
      if (w && !w.error) setWiring(w);
      else if (w && w.error) setNote({ kind: "err", text: `接入信息读取失败：${w.error}` });
      if (m && !m.error) setModels(m);
      if (s && !s.error) setStatus(s);
      setUpdatedAt(Date.now());
    },
    [serverId],
  );

  useEffect(() => {
    aliveRef.current = true;
    pollEngine();
    const timer = setInterval(pollEngine, 5000);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [pollEngine]);

  /* 引擎一起来，或者换了端口 → 拉一次重活。 */
  useEffect(() => {
    if (!engine || engine.running !== true) {
      loadedFor.current = "";
      return;
    }
    const token = `${engine.port}`;
    if (loadedFor.current === token) return;
    loadedFor.current = token;
    loadAll();
  }, [engine, loadAll]);

  /* ── 动作 ─────────────────────────────────────────────────── */
  const act = useCallback(
    async (action) => {
      if (!serverId) return;
      setBusy(action);
      setNote(null);
      const result = await call(serverId, "ofm_engine", { action });
      if (!aliveRef.current) {
        setBusy("");
        return;
      }
      setBusy("");
      if (result && result.error) {
        setNote({ kind: "err", text: result.error });
        pollEngine();
        return;
      }
      setEngine(result);
      if (action === "start" || action === "restart") {
        setFrameGen((value) => value + 1);
        loadedFor.current = ""; // 让 effect 重新拉一遍
      }
    },
    [serverId, pollEngine],
  );

  const refreshModels = useCallback(async () => {
    if (!serverId) return;
    setBusy("models");
    setNote(null);
    const result = await call(serverId, "ofm_models", { refresh: true, limit: 500 });
    if (!aliveRef.current) {
      setBusy("");
      return;
    }
    setBusy("");
    if (result && result.error) setNote({ kind: "err", text: `刷新失败：${result.error}` });
    else {
      setModels(result);
      setUpdatedAt(Date.now());
      call(serverId, "ofm_status", {}).then((s) => {
        if (aliveRef.current && s && !s.error) setStatus(s);
      });
    }
  }, [serverId]);

  const loadLogs = useCallback(async () => {
    if (!serverId) return;
    const result = await call(serverId, "ofm_engine", { action: "logs", lines: 200 });
    if (!aliveRef.current) return;
    if (result && result.error) setLogs([`读取日志失败：${result.error}`]);
    else setLogs(Array.isArray(result && result.lines) ? result.lines : []);
  }, [serverId]);

  useEffect(() => {
    if (showConsole && logs === null) loadLogs();
  }, [showConsole, logs, loadLogs]);

  /* ── 派生状态 ─────────────────────────────────────────────── */
  const running = engine ? engine.running === true : null;
  const baseUrl = (wiring && wiring.baseUrl) || (engine && engine.bridgeApiUrl) || "";
  const apiKey = (wiring && wiring.apiKey) || "ofm-bridge";
  const bridgePort = (engine && engine.bridgePort) || (wiring && wiring.bridgePort) || "";
  const uiBase = bridgePort ? `http://127.0.0.1:${bridgePort}/` : "";
  const modelCount = (status && status.modelCount) || (wiring && wiring.modelCount) || 0;
  const routableCount = (status && status.routableCount) || 0;
  const channelState = status && status.channels ? status.channels.state : "";
  const upstreamVersion = (engine && engine.version) || "";

  const filteredModels = (() => {
    const rows = (models && Array.isArray(models.models) ? models.models : null) ||
      (wiring && Array.isArray(wiring.models) ? wiring.models : []) ||
      [];
    const q = query.trim().toLowerCase();
    const list = q === "" ? rows : rows.filter((row) => String(row.id || "").toLowerCase().includes(q));
    return list.slice(0, 300);
  })();

  /* ── 接住上游界面里那颗「接入 Notrat」浮标 ─────────────────────
   *
   * 浮标跑在 iframe 里（上游页面的同源脚本）。它不自己跳 notrat:// ——
   * 那会把 iframe 导航走、整页白掉；它只 postMessage 过来，由这里调
   * 应用自己的 openExternal，等价于在系统里双击这条链接。
   *
   * 只认 127.0.0.1 的来源，别的页面发同样的消息一律不理。
   */
  const adopt = useCallback(async () => {
    let link = wiring && wiring.link;

    if (!link && serverId) {
      const fresh = await call(serverId, "ofm_provider_link", {});
      if (fresh && !fresh.error && fresh.link) {
        link = fresh.link;
        setWiring((prev) => ({
          ...(prev || {}),
          link: fresh.link,
          json: fresh.json,
          baseUrl: fresh.baseUrl,
          apiKey: fresh.apiKey,
          includedModels: fresh.includedModels,
        }));
      }
    }

    if (!link) {
      setNote({ kind: "err", text: "还没拿到导入链接 —— 先把引擎启动起来，再点一次。" });
      return;
    }

    const ok = await openExternal(link);
    setNote(
      ok
        ? { kind: "ok", text: "已把导入请求交给 Notrat —— 确认框里点确认即完成。" }
        : { kind: "err", text: "打不开 notrat:// 链接（协议可能未注册）。改用「复制 JSON」贴进 设置 → AI → 导入。" },
    );
  }, [wiring, serverId]);

  useEffect(() => {
    function onMessage(event) {
      const data = event && event.data;
      if (!data || data.type !== "ofm:connect") return;
      const origin = String((event && event.origin) || "");
      if (origin !== "" && !/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return;
      void adopt();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [adopt]);

  /* ── 上游界面（首屏）──────────────────────────────────────────
   *
   * 这套 UI 是上游专门画的：品牌色、毛玻璃、留白节奏，都比我们自己拼一套
   * 「长得像 Notrat」的东西好看。所以让它当主视图，我们只留一条 30px 的
   * 控制条压在顶上——状态、启动停止、重载、以及通往设置面板的出口。
   *
   * 引擎没跑时 uiBase 为空，这里自动让位给下面的引导面板（至少告诉人该点哪）。
   */
  /* 引擎还在握手的那一两秒：给一块安静的空场，别先闪一整套面板再跳走。 */
  if (view === "ui" && !uiBase && engine === null && !bootGaveUp) {
    return (
      <div
        ref={setRootEl}
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 9, height: VIEW_H, maxHeight: "100%", minHeight: 0, overflow: "hidden", color: C.muted,
        }}
      >
        <Dot color={C.muted} pulse />
        <span style={{ fontSize: 11.5 }}>正在连接引擎…</span>
      </div>
    );
  }

  if (view === "ui" && uiBase) {
    return (
      <div ref={setRootEl} style={{ display: "flex", flexDirection: "column", height: VIEW_H, maxHeight: "100%", minHeight: 0, overflow: "hidden", color: C.fg }}>
        <Sheet />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: 30,
            padding: "0 7px 0 9px",
            borderBottom: `1px solid ${C.border}`,
            flex: "0 0 auto",
          }}
        >
          <Dot color={running === null ? C.muted : running ? C.ok : C.muted} pulse={running === true} />
          <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>
            {running === null ? "读取中" : running ? "运行中" : "未启动"}
          </span>
          {running && modelCount ? <Chip>{`${modelCount} 模型`}</Chip> : null}
          <span style={{ flex: "1 1 auto", minWidth: 0 }} />
          {running ? (
            <Btn icon="stop" variant="danger" muted onClick={() => act("stop")} disabled={busy !== ""} title="只停本插件拉起的那个" />
          ) : (
            <Btn icon="play" variant="primary" onClick={() => act("start")} disabled={busy !== "" || running === null} title="启动引擎" />
          )}
          <Btn icon="refresh" onClick={() => setFrameGen((v) => v + 1)} title="重载界面" />
          <Btn
            icon="external"
            muted
            onClick={() => {
              try {
                window.open(uiBase, "_blank");
              } catch (e) {
                setNote({ kind: "err", text: String((e && e.message) || e) });
              }
            }}
            title="在系统浏览器打开"
          />
          <Btn icon="layers" onClick={() => setView("panel")} title="接入 / 模型 / 引擎设置">
            设置
          </Btn>
        </div>
        <iframe
          key={frameGen}
          src={uiBase}
          title="Our Free Model 管理界面"
          style={{ flex: "1 1 auto", width: "100%", height: "100%", minHeight: 0, border: 0, background: "transparent" }}
        />
      </div>
    );
  }

  /* ── 主界面 ───────────────────────────────────────────────── */
  return (
    <div
      ref={setRootEl}
      style={{ display: "flex", flexDirection: "column", height: VIEW_H, maxHeight: "100%", minHeight: 0, overflow: "hidden", color: C.fg }}
    >
      <Sheet />

      {/* ── 状态头 ───────────────────────────────────────── */}
      <div style={{ padding: compact ? "10px 10px 8px" : "12px 14px 10px", flex: "0 0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Dot color={running === null ? C.muted : running ? C.ok : C.muted} pulse={running === true} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>
            {running === null ? "读取中" : running ? "运行中" : "未启动"}
          </span>
          {upstreamVersion ? <Chip>{upstreamVersion}</Chip> : null}
          {channelState === "ready" ? <Chip color={C.info}>渠道就绪</Chip> : null}
          {channelState && channelState !== "ready" ? <Chip color={C.warn}>{channelState}</Chip> : null}
          <span style={{ flex: "1 1 auto" }} />
          {uiBase ? (
            <Btn icon="check" onClick={() => setView("ui")} title="回到上游管理界面">
              上游界面
            </Btn>
          ) : null}
          {running ? (
            <Btn icon="stop" variant="danger" muted onClick={() => act("stop")} disabled={busy !== ""} title="只停本插件拉起的那个">
              {busy === "stop" ? "停止中" : "停止"}
            </Btn>
          ) : (
            <Btn
              icon="play"
              variant="primary"
              onClick={() => act("start")}
              disabled={busy !== "" || running === null}
            >
              {busy === "start" ? "启动中" : "启动"}
            </Btn>
          )}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <Kpi value={running ? modelCount || "—" : "—"} label="模型" dim={!running} />
          <Kpi value={running ? routableCount || "—" : "—"} label="可用" dim={!running} />
          {!compact ? (
            <Kpi
              value={running && engine && engine.port ? `:${engine.port}` : "—"}
              label="引擎端口"
              dim={!running}
            />
          ) : null}
        </div>
      </div>

      {/* ── 分段 ─────────────────────────────────────────── */}
      <div style={{ padding: "0 10px 8px", flex: "0 0 auto" }}>
        <Segmented items={TABS} value={tab} onChange={setTab} />
      </div>

      {note ? (
        <div
          style={{
            flex: "0 0 auto",
            margin: "0 10px 8px",
            padding: "6px 8px",
            fontSize: 11,
            lineHeight: "15px",
            borderRadius: R_SM,
            color: note.kind === "err" ? C.danger : C.muted,
            border: `1px solid ${note.kind === "err" ? `${C.danger}44` : C.border}`,
            background: note.kind === "err" ? `${C.danger}12` : "transparent",
            wordBreak: "break-word",
            maxHeight: 78,
            overflow: "auto",
          }}
          className="ofm-scroll"
        >
          {note.text}
        </div>
      ) : null}

      {/* ── 内容 ─────────────────────────────────────────── */}
      <div className="ofm-scroll" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "0 10px 10px" }}>
        {tab === "wiring" ? (
          !running ? (
            <Empty
              icon="layers"
              title="引擎没在跑"
              desc="启动之后这里会给出「一键接入」按钮：点它，Notrat 自己弹确认框，确认一次就配好。"
              action={
                <Btn icon="play" variant="primary" wide onClick={() => act("start")} disabled={busy !== ""}>
                  {busy === "start" ? "启动中…" : "启动引擎"}
                </Btn>
              }
            />
          ) : (
            <div style={{ maxWidth: compact ? "100%" : 620 }}>
              <SectionTitle first>一键接入</SectionTitle>
              <div
                style={{
                  padding: "10px 11px",
                  borderRadius: R_MD,
                  border: `1px solid ${C.border}`,
                  background: C.card,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>Our Free Model</span>
                  <Chip color={C.ok}>OpenAI 兼容</Chip>
                  {wiring && wiring.includedModels ? <Chip>{`${wiring.includedModels} 个模型`}</Chip> : null}
                  {!wiring ? <Chip>读取中…</Chip> : null}
                </div>

                <div style={{ fontSize: 11, lineHeight: "17px", color: C.muted, marginBottom: 9 }}>
                  点一下把导入请求交给 Notrat：它自己弹出确认框（服务商名、协议、地址、打码后的 Key 都列着），
                  你确认一次就配好，不用手抄下面那三行。
                  <br />
                  万一没弹框（协议没注册、或同时开着另一个 Notrat 实例），改用「复制 JSON」贴到
                  <span style={{ color: C.fg }}> 设置 → AI → 导入</span>，效果一样。
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Btn
                    icon="check"
                    variant="primary"
                    disabled={!wiring || !wiring.link || busy !== ""}
                    onClick={async () => {
                      const ok = await openExternal(wiring.link);
                      setNote(
                        ok
                          ? { kind: "ok", text: "已把导入请求交给 Notrat —— 看它弹出的确认框，点确认即完成。" }
                          : { kind: "err", text: "打不开 notrat:// 链接（协议可能未注册）。改用「复制 JSON」贴进 设置 → AI → 导入。" },
                      );
                    }}
                  >
                    一键接入 Notrat
                  </Btn>
                  <Btn
                    icon="copy"
                    disabled={!wiring || !wiring.json}
                    onClick={async () => {
                      const ok = await copyText(JSON.stringify(wiring.json ?? {}, null, 2));
                      setNote(
                        ok
                          ? { kind: "ok", text: "JSON 已复制。设置 → AI → 导入，粘进去即可。" }
                          : { kind: "err", text: "复制失败（剪贴板被拦）。改点「一键接入」，或从下面的链接里抄。" },
                      );
                    }}
                  >
                    复制 JSON
                  </Btn>
                  <Btn icon="external" muted disabled={!uiBase} onClick={() => setView("ui")} title="回到上游管理界面">
                    上游界面
                  </Btn>
                </div>

                {wiring && wiring.link ? (
                  <div style={{ marginTop: 8, fontSize: 10, lineHeight: "15px", color: C.muted, wordBreak: "break-all", fontFamily: MONO, opacity: 0.75 }}>
                    {wiring.link.length > 120 ? `${wiring.link.slice(0, 118)}…` : wiring.link}
                  </div>
                ) : null}
              </div>

              <SectionTitle>手动填写</SectionTitle>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <Field label="Base URL" value={baseUrl} mono />
                <Field label="API Key" value={apiKey} mono />
                <Field label="模型名" value={modelCount ? `${modelCount} 个可选` : "—"} />
              </div>

              <SectionTitle>填在哪里</SectionTitle>
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: R_SM,
                  border: `1px solid ${C.border}`,
                  background: C.card,
                  fontSize: 11,
                  lineHeight: "17px",
                  color: C.muted,
                }}
              >
                <div style={{ color: C.fg, fontWeight: 600, marginBottom: 3 }}>设置 → AI → 自定义服务商（OpenAI 兼容）</div>
                按上面三项填。API Key 是<strong style={{ color: C.fg }}>占位口令</strong>，随便填什么都可以——
                桥在出站时会换成上游的真实 Key，所以真 Key 从来不需要离开本机引擎。
              </div>

              <SectionTitle>下一步</SectionTitle>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Btn icon="layers" onClick={() => setTab("models")}>
                  看模型列表
                </Btn>
                <Btn icon="terminal" onClick={() => setTab("advanced")}>
                  高级
                </Btn>
              </div>
            </div>
          )
        ) : null}

        {tab === "models" ? (
          <div>
            <div style={{ display: "flex", gap: 5, marginBottom: 7 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  flex: "1 1 auto",
                  minWidth: 0,
                  height: 26,
                  padding: "0 8px",
                  borderRadius: R_SM,
                  border: `1px solid ${C.border}`,
                  background: C.card,
                  color: C.muted,
                }}
              >
                <Icon name="search" size={12} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索模型"
                  style={{
                    flex: "1 1 auto",
                    minWidth: 0,
                    border: 0,
                    outline: "none",
                    background: "transparent",
                    color: C.fg,
                    fontSize: 11.5,
                    fontFamily: "inherit",
                  }}
                />
                {query !== "" ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="ofm-x"
                    style={{ border: 0, background: "transparent", color: C.muted, cursor: "pointer", padding: 0, display: "flex" }}
                    title="清除"
                  >
                    <Icon name="dot" size={12} />
                  </button>
                ) : null}
              </div>
              <Btn icon="refresh" onClick={refreshModels} disabled={!running || busy !== ""} title="从上游重新拉取目录">
                {busy === "models" ? "…" : ""}
              </Btn>
            </div>

            {!running ? (
              <Empty icon="layers" tight title="引擎没在跑" desc="模型目录由引擎提供。" />
            ) : filteredModels.length === 0 ? (
              <Empty
                icon="search"
                tight
                title={query ? "没有匹配的模型" : "目录是空的"}
                desc={query ? "换个词试试，或清空搜索。" : "点右上的刷新按钮拉一次目录。"}
              />
            ) : (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 10,
                    color: C.muted,
                    padding: "0 2px 4px",
                  }}
                >
                  <span>
                    {filteredModels.length} / {modelCount || filteredModels.length}
                  </span>
                  {query ? <span>· 含 “{query}”</span> : null}
                  <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                    {updatedAt ? `刷新于 ${timeOf(updatedAt)}` : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {filteredModels.map((row) => {
                    const off = row.routable === false;
                    return (
                      <div
                        key={row.id}
                        className="ofm-row"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 6px",
                          borderRadius: R_SM,
                          minWidth: 0,
                          opacity: off ? 0.5 : 1,
                        }}
                      >
                        <Dot color={off ? C.muted : C.ok} />
                        <span
                          style={{
                            flex: "1 1 auto",
                            minWidth: 0,
                            fontSize: 11.5,
                            fontFamily: MONO,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={row.id}
                        >
                          {row.id}
                        </span>
                        {row.vision ? <Chip>图</Chip> : null}
                        {row.channel && row.channel !== "anonymous" ? <Chip color={C.info}>{row.channel}</Chip> : null}
                        {formatCtx(row.contextWindow) ? (
                          <span
                            style={{
                              fontSize: 10,
                              color: C.muted,
                              fontVariantNumeric: "tabular-nums",
                              flex: "0 0 auto",
                              minWidth: 30,
                              textAlign: "right",
                            }}
                          >
                            {formatCtx(row.contextWindow)}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : null}

        {tab === "advanced" ? (
          <div style={{ maxWidth: compact ? "100%" : 620 }}>
            <SectionTitle first>端点</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <Field label="桥端口" value={bridgePort ? String(bridgePort) : ""} mono />
              <Field label="引擎端口" value={engine && engine.port ? String(engine.port) : ""} mono />
              <Field label="API Key" value={(engine && engine.keyMasked) || ""} mono placeholder="引擎未启动" />
            </div>

            <SectionTitle>界面</SectionTitle>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn icon="external" onClick={() => setView("ui")} disabled={!uiBase}>
                内嵌管理界面
              </Btn>
              <Btn
                icon="external"
                disabled={!uiBase}
                onClick={() => {
                  try {
                    window.open(uiBase, "_blank");
                  } catch (e) {
                    setNote({ kind: "err", text: String((e && e.message) || e) });
                  }
                }}
              >
                浏览器打开
              </Btn>
              <Btn icon="refresh" onClick={loadAll} disabled={!running}>
                重新获取
              </Btn>
            </div>

            <SectionTitle right={<span style={{ fontWeight: 400 }}>{logs ? `${logs.length} 行` : ""}</span>}>
              运行时
            </SectionTitle>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              <Btn
                icon="terminal"
                onClick={() => setShowConsole((v) => !v)}
                title="引擎日志（stderr）"
              >
                {showConsole ? "收起日志" : "看日志"}
              </Btn>
              <Btn icon="refresh" onClick={() => act("restart")} disabled={!running || busy !== ""}>
                {busy === "restart" ? "重启中" : "重启引擎"}
              </Btn>
              <Btn icon="refresh" onClick={loadLogs} disabled={!showConsole}>
                刷新
              </Btn>
            </div>

            {showConsole ? (
              <div
                className="ofm-scroll"
                style={{
                  maxHeight: 200,
                  overflow: "auto",
                  padding: "7px 8px",
                  borderRadius: R_SM,
                  border: `1px solid ${C.border}`,
                  background: C.soft,
                  fontFamily: MONO,
                  fontSize: 10,
                  lineHeight: "15px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: C.muted,
                }}
              >
                {logs === null ? "读取中…" : logs.length === 0 ? "（还没有日志）" : logs.join("\n")}
              </div>
            ) : null}

            <SectionTitle>关于</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <Field label="上游版本" value={(engine && engine.upstreamVersion) || ""} mono />
              <Field label="数据目录" value={(engine && engine.dataDir) || ""} mono />
            </div>
            <div style={{ marginTop: 10, fontSize: 10.5, lineHeight: "16px", color: C.muted }}>
              引擎与界面来自 EBONY-VINYL/dsh-our-free-model（MIT）。本插件只做托管与接线，不改上游逻辑。
              免费通道随时可能限流，账号渠道需自行在管理界面登录。
            </div>
          </div>
        ) : null}
      </div>

      {/* ── 底栏 ─────────────────────────────────────────── */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 10px",
          borderTop: `1px solid ${C.border}`,
          fontSize: 10,
          color: C.muted,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>{bridgePort ? `桥 :${bridgePort}` : "桥未就绪"}</span>
        <span style={{ flex: "1 1 auto" }} />
        <span>{updatedAt ? timeOf(updatedAt) : running ? "已连接" : "待启动"}</span>
      </div>
    </div>
  );
}

/** 样式表。只放内联写不出来的东西：hover / 滚动条 / 焦点环。 */
function Sheet() {
  return (
    <style>{`
      .ofm-btn { transition: background 120ms, border-color 120ms, color 120ms; }
      .ofm-btn:hover { background: hsl(var(--accent)); }
      .ofm-btn-primary:hover { filter: brightness(1.08); }
      .ofm-btn:focus-visible, .ofm-seg:focus-visible {
        outline: 2px solid hsl(var(--ring)); outline-offset: 1px;
      }
      .ofm-seg:hover { color: hsl(var(--foreground)); }
      .ofm-row:hover { background: hsl(var(--accent)); }
      .ofm-field { transition: border-color 120ms, background 120ms; }
      .ofm-field:hover { border-color: hsl(var(--muted-foreground) / 0.45); }
      .ofm-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
      .ofm-scroll::-webkit-scrollbar-thumb {
        background: hsl(var(--border)); border-radius: 8px; border: 2px solid transparent;
        background-clip: content-box;
      }
      .ofm-scroll::-webkit-scrollbar-thumb:hover { background: hsl(var(--muted-foreground) / 0.5); background-clip: content-box; }
      .ofm-scroll::-webkit-scrollbar-track { background: transparent; }
    `}</style>
  );
}

/* ──────────────────────────── 导出 ──────────────────────────── */

export default OfmPanel;
