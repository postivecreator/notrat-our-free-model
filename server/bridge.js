/**
 * bridge —— 同源改写反向代理（本插件唯一"不显然"的部分）
 * ====================================================
 *
 * 上游 standalone 把两种面孔挂在同一个端口上：
 *
 *   /v1/**               推理（OpenAI / Responses / Anthropic 三协议），
 *                        带 CORS `*`，所以 Notrat 渲染进程可以直接打。
 *   /api/management/**   管理 API + 那套六页毛玻璃界面，**没有** CORS，
 *                        并且有一道同源栅栏：
 *
 *                          referer/origin 必须缺省或以 http:// 开头，
 *                          否则 403「管理接口仅允许本机同源访问」
 *                          （trust.js 的 structuralRejection 还要求
 *                           Origin 的 authority 等于 Host）
 *
 * Notrat 的面板跑在渲染进程里（打包版从 file:// 加载，Origin 为 null），
 * 它既过不了那道栅栏，也拿不到上游的 Cookie。所以这里放一座桥：
 *
 *   1. 把请求的 Origin / Referer 改写成上游自己的地址 → 过栅栏；
 *   2. **所有**转发都补 `Authorization: Bearer <forwardKey>` → 过鉴权
 *      （management.mjs 的 authenticated() 认 Bearer，不必玩 Cookie）；
 *   3. 回包补 CORS，面板 fetch 才读得到；
 *   4. 把上游 CSP 里的 `frame-ancestors 'none'` 放开 → 面板 iframe 才挂得上；
 *   5. 端口固定，上游换端口只影响 target，不影响已接入的地址。
 *
 * 第 2 条还顺带解决了一个安全问题：**key 不必离开引擎**。
 * Notrat 的自定义服务商可以填任意占位口令（例如 `ofm-bridge`），
 * 桥在出站时换成真 key；面板也从不接触明文 key。
 *
 * 桥只绑回环，只供本机的面板与 Notrat 自己用。
 */
import http from "node:http";

/** 逐跳头，不该被转发。 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** 会被我们改写的请求头。 */
const REWRITTEN_REQUEST = new Set(["host", "origin", "referer", "authorization"]);

/** fetch-metadata 一律不带：带上就会被判成跨站。 */
const DROP_REQUEST = new Set([
  // 桥只跑在本机回环上，压缩省不下什么，却会让 HTML 变成二进制流插不进去。
  "accept-encoding",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
]);

/** 回包里影响嵌入/跨域的头。 */
const DROP_RESPONSE = new Set(["x-frame-options", "content-security-policy-report-only"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-api-key, accept, cache-control",
  "access-control-expose-headers": "content-type, x-request-id",
  "access-control-max-age": "600",
};

/** 注入到上游界面里的胶水脚本路径。 */
const EMBED_PATH = "/__ofm/embed.js";

/**
 * 面板里那颗「接入 Notrat」浮标 + 宽度自适应。
 *
 * 为什么要注入：上游界面是按桌面宽度设计的（最窄档做到 430px），
 * 塞进 380px 的侧栏刚好差一口气，于是横向溢出、看起来"没适配"。
 * 我们有两条路修它 ——
 *
 *   1. 只在**真溢出**时按比例缩（没溢出就一点不动，不无谓压字号）；
 *   2. 补一条 <430px 的兜底样式，把双栏压成单栏。
 *
 * 浮标点下去：在 iframe 里就 postMessage 让面板去 openExternal（干净的
 * 应用内出口）；在系统浏览器里就直接走 notrat:// 协议。
 */
const EMBED_SCRIPT = `
(function () {
  if (window.__ofmEmbed) { return; }
  window.__ofmEmbed = true;

  var inFrame = true;
  try { inFrame = window.parent !== window; } catch (e) { inFrame = true; }

  /* ── ① 兜底样式：上游最窄档到 430px，这里再往下补一档 ────── */
  var style = document.createElement("style");
  style.textContent = [
    /* 只做两件保守的事：别让根节点撑破画布、别让浮标被裁掉。
       布局本身交给上游自己的断点——面板那边已经给了它 430px 的画布，
       它的窄屏规则会正常生效，这里不再硬改它的栅格。 */
    "html, body { max-width: 100%; }",
    /* ── 窄于上游最窄断点（430px）时的补丁 ──────────────────
       只碰这三类东西：多列栅格压成单列、侧栏收起、长词别撑破。
       不写通配选择器、不动它的 flex 方向 —— 那会把导航压成竖排。 */
    "@media (max-width: 430px) {",
    "  .dashboard-metrics, .usage-metrics, .provider-grid, .model-filters {",
    "    grid-template-columns: minmax(0, 1fr) !important;",
    "  }",
    "  .console-nav { width: 100% !important; max-width: 100% !important; }",
    "  #root, #root * { min-width: 0; }",
    "  #root { overflow-wrap: anywhere; }",
    "}",
    /* 撑满一屏：上游的 body 没有 min-height，内容短时下半截是透明的，
       露出 iframe 底下的空白。让它自己的背景铺到底。 */
    "html, body { min-height: 100%; }",
    "body { min-height: 100vh; }",
    "#root { min-height: 100vh; }",
    "#root { min-width: 0; }",
    "#__ofm_connect {",
    "  position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;",
    "  display: inline-flex; align-items: center; gap: 6px;",
    "  height: 31px; padding: 0 13px; border-radius: 999px;",
    "  border: 1px solid rgba(0,0,0,.13); background: rgba(255,255,255,.96); color: #111;",
    "  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;",
    "  box-shadow: 0 2px 12px rgba(0,0,0,.13); cursor: pointer; user-select: none;",
    "  transition: transform 120ms ease, box-shadow 120ms ease, opacity 120ms ease;",
    "}",
    "#__ofm_connect:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(0,0,0,.18); }",
    "#__ofm_connect:active { transform: translateY(0); }",
    "#__ofm_connect[data-busy='1'] { opacity: .6; pointer-events: none; }",
    "@media (prefers-color-scheme: dark) {",
    "  #__ofm_connect { background: rgba(30,30,32,.96); border-color: rgba(255,255,255,.15); color: #f2f2f4;",
    "    box-shadow: 0 2px 12px rgba(0,0,0,.5); }",
    "}",
    "@media (max-width: 430px) { #__ofm_connect { right: 10px; bottom: 10px; height: 29px; padding: 0 11px; } }"
  ].join(String.fromCharCode(10));
  (document.head || document.documentElement).appendChild(style);

  /* ── ② 只在真溢出时才缩 ─────────────────────────────────── */
  var MIN_SCALE = 0.55;
  var timer = 0;

  function measure() {
    var doc = document.documentElement;
    var body = document.body;
    if (!doc || !body) { return; }
    body.style.zoom = "";
    var box = doc.clientWidth || body.clientWidth || 0;
    if (!box) { return; }
    var need = Math.max(doc.scrollWidth || 0, body.scrollWidth || 0);
    if (need <= box + 2) { return; }
    var scale = box / need;
    if (scale < MIN_SCALE) { scale = MIN_SCALE; }
    body.style.zoom = String(Math.round(scale * 1000) / 1000);
  }

  function fit() {
    if (timer) { clearTimeout(timer); }
    timer = setTimeout(function () { timer = 0; try { measure(); } catch (e) {} }, 120);
  }

  window.addEventListener("resize", fit);
  if (window.ResizeObserver) {
    try { new ResizeObserver(fit).observe(document.documentElement); } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", fit);
  window.addEventListener("load", fit);
  [0, 300, 900, 2000, 4000].forEach(function (ms) { setTimeout(fit, ms); });

  /* 单页应用会晚渲染，盯着 body 变化再校一次 */
  if (window.MutationObserver && document.body) {
    try {
      var mo = new MutationObserver(fit);
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  /* ── ③ 浮标 ─────────────────────────────────────────────── */
  function label(text) {
    var el = document.getElementById("__ofm_connect");
    if (el) { el.textContent = text; }
  }

  function flash(text) {
    label(text);
    setTimeout(function () { label("接入 Notrat"); }, 2200);
  }

  function makeLink() {
    return fetch("/v1/models", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = (data && data.data) || [];
        var ids = rows.map(function (m) { return m && m.id; }).filter(Boolean).slice(0, 28);
        var q = new URLSearchParams({
          type: "openai",
          name: "Our Free Model",
          baseUrl: location.origin + "/v1",
          apiKey: "ofm-bridge",
          model: ids[0] || "",
          models: ids.join(",")
        });
        return "notrat://import-ai?" + q.toString();
      });
  }

  function handOff() {
    var pill = document.getElementById("__ofm_connect");
    if (pill) { pill.setAttribute("data-busy", "1"); }

    if (inFrame) {
      /* 面板接住这条消息，走应用自己的 openExternal —— 不会把 iframe 导航走。 */
      try { window.parent.postMessage({ type: "ofm:connect" }, "*"); } catch (e) {}
      flash("已交给 Notrat ↑");
      if (pill) { setTimeout(function () { pill.removeAttribute("data-busy"); }, 1200); }
      return;
    }

    /* 脱离面板打开时（系统浏览器）：走协议，交给 Notrat 自己接。 */
    makeLink()
      .then(function (link) {
        var a = document.createElement("a");
        a.href = link;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); }, 1500);
        flash("正在拉起 Notrat…");
        if (pill) { setTimeout(function () { pill.removeAttribute("data-busy"); }, 1200); }
      })
      .catch(function () {
        flash("取模型失败，稍后再试");
        if (pill) { setTimeout(function () { pill.removeAttribute("data-busy"); }, 1200); }
      });
  }

  function mount() {
    if (document.getElementById("__ofm_connect")) { return; }
    var pill = document.createElement("div");
    pill.id = "__ofm_connect";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.title = "把这份配置一键接进 Notrat（会弹出确认框，确认才写入）";
    pill.textContent = "接入 Notrat";
    pill.addEventListener("click", handOff);
    pill.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handOff(); }
    });
    (document.body || document.documentElement).appendChild(pill);
    fit();
  }

  if (document.body) { mount(); } else { document.addEventListener("DOMContentLoaded", mount); }
})();
`;

/** 把胶水脚本塞进 HTML。插在 </body> 前，拿不到就退到 </html> 前。 */
function injectEmbed(html) {
  const tag = `<script src="${EMBED_PATH}" defer></script>`;
  if (html.includes(EMBED_PATH)) return html;
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf("</body>");
  if (at >= 0) return html.slice(0, at) + tag + html.slice(at);
  const tail = lower.lastIndexOf("</html>");
  if (tail >= 0) return html.slice(0, tail) + tag + html.slice(tail);
  return html + tag;
}

/** 把上游 CSP 的 frame-ancestors 放开（其余策略保留）。 */
function relaxCsp(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  if (/frame-ancestors[^;]*/i.test(text)) {
    return text.replace(/frame-ancestors[^;]*/i, "frame-ancestors *");
  }
  return `${text}; frame-ancestors *`;
}

/**
 * 起桥。
 *
 * @param {object} options
 * @param {number} options.port            桥自己的端口
 * @param {() => number|null} options.getTargetPort  上游当前端口
 * @param {() => string} options.getKey    上游 forwardKey
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export async function startBridge({ port, getTargetPort, getKey, log = () => {} }) {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log(`bridge error: ${error?.message ?? error}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", ...CORS });
        res.end(JSON.stringify({ error: { message: `桥转发失败：${error?.message ?? error}`, type: "bridge_error" } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    // 桥自己的探针：面板拿它判断"桥活着但引擎没起来"。
    if (pathname === "/__ofm/bridge") {
      const target = getTargetPort();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", ...CORS });
      res.end(
        JSON.stringify({
          ok: true,
          bridge: port,
          target: target ?? null,
          upstream: target ? `http://127.0.0.1:${target}` : null,
        }),
      );
      return;
    }

    // 注入到上游界面里的胶水脚本。放在引擎检查之前：引擎挂了它也该照常给。
    if (pathname === EMBED_PATH) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        ...CORS,
      });
      res.end(EMBED_SCRIPT);
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    const target = getTargetPort();
    if (!target) {
      res.writeHead(503, { "content-type": "application/json; charset=utf-8", ...CORS });
      res.end(
        JSON.stringify({ error: { message: "引擎还没启动（调 ofm_engine action=start）", type: "engine_down" } }),
      );
      return;
    }

    const key = getKey();

    /* ── 组装转发头 ─────────────────────────────────────────── */
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || REWRITTEN_REQUEST.has(lower) || DROP_REQUEST.has(lower)) continue;
      headers[lower] = value;
    }
    const origin = `http://127.0.0.1:${target}`;
    headers.origin = origin;
    headers.referer = `${origin}/`;
    headers.host = `127.0.0.1:${target}`;
    // 调用方自带的 key 一律作废：既避免占位口令被上游拒，也让 key 不必离开引擎。
    if (key) headers.authorization = `Bearer ${key}`;

    /* ── 转发 ───────────────────────────────────────────────── */
    await new Promise((resolve, reject) => {
      const upstream = http.request(
        { host: "127.0.0.1", port: target, method: req.method, path: `${url.pathname}${url.search}`, headers },
        (upRes) => {
          const out = { ...upRes.headers };
          for (const name of DROP_RESPONSE) delete out[name];
          for (const name of HOP_BY_HOP) delete out[name];
          if (typeof out["content-security-policy"] === "string") {
            out["content-security-policy"] = relaxCsp(out["content-security-policy"]);
          }
          Object.assign(out, CORS);

          // 只碰「干净」的 HTML：GET + text/html + 没被压缩。
          const type = String(out["content-type"] ?? "");
          const injectable =
            req.method === "GET" && type.includes("text/html") && !out["content-encoding"];

          if (!injectable) {
            res.writeHead(upRes.statusCode ?? 502, out);
            upRes.pipe(res);
            upRes.on("end", resolve);
            upRes.on("error", reject);
            return;
          }

          const chunks = [];
          upRes.on("data", (chunk) => chunks.push(chunk));
          upRes.on("error", reject);
          upRes.on("end", () => {
            const body = Buffer.from(injectEmbed(Buffer.concat(chunks).toString("utf8")), "utf8");
            delete out["content-length"];
            out["content-length"] = String(body.length);
            out["cache-control"] = "no-store";
            res.writeHead(upRes.statusCode ?? 502, out);
            res.end(body);
            resolve();
          });
        },
      );
      upstream.on("error", reject);
      // 调用方提前断开（面板关掉 iframe / 渲染进程取消请求）时收掉上游连接。
      res.on("close", () => {
        if (!res.writableEnded) upstream.destroy();
      });
      req.pipe(upstream);
    });
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const actual = server.address()?.port ?? port;
  log(`bridge listening on http://127.0.0.1:${actual}`);

  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // 挂着的 SSE / keep-alive 连接不会自己散，给它们一个截止时间。
        setTimeout(() => resolve(), 1500).unref?.();
      }),
  };
}
