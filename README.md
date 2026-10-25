# Our Free Model 免费模型池（notrat-our-free-model）

把 [OFM（Our Free Model）](https://github.com/Ebony-Vinyl/dsh-our-free-model) 接进 Notrat：
一套免登录的免费模型通道 + 十个账号渠道（LobsterAI / Qoder / TRAE / Cline / Loomy /
Raccoon / MiniMax / ZCode / Gemini / Kilo）+ 本地 OpenAI 兼容网关 + 用量看板与运行日志。

接进去之后你在 Notrat 里得到两样东西：

- **一个模型服务商** —— 填一次 `http://127.0.0.1:8132/v1` + 占位口令，之后模型列表自动跟着上游走；
- **一个内嵌管理面板** —— 上游那套六页毛玻璃界面（渠道扫描登录、模型可见性、用量、设置）直接挂在 Notrat 侧栏。

> **来源与署名。** 引擎与界面全部来自 [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)（MIT，v2.5.4）。
> 本插件不加功能、不改上游逻辑，只做一件事：**把上游从 DSH 宿主的壳里取出来，换成 Notrat 的接线。**
>
> **免责。** 仅供个人学习研究。免费通道与账号渠道由上游提供，随时可能限流、改协议或失效；
> 账号渠道需要你**自己**在管理界面里扫码/登录，本插件不发起任何登录，也不代你同意任何条款。
> 完整免责声明与上游仓库措辞一致，见[第九节](#九免责声明)。

---

## 一、移植时做的唯一判断：**进程级托管，不是代码级改写**

上游仓库里有三张皮：

| 入口 | 依赖 | 适不适合当 Notrat 插件 |
| --- | --- | --- |
| `index.js`（DSH 插件） | cordis 运行时 + `@deepseek-ai/dsh-llm` 等五个包 | ❌ 得先仿一套宿主内核 |
| `packages/standalone/`（独立本地服务） | **零 npm 依赖**，纯 `node:` 内建 | ✅ 就是它 |
| `packages/desktop/`（Tauri 桌面壳） | WebView2 + Rust | ❌ 我们要的是 Notrat 的窗口，不是它的 |

看上游自己的注释，中间那张皮的定位写得很清楚：

```js
/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({ dataDir, host, port, ... })
```

它本来就同时提供「`/v1` 推理」和「`/api/management` 管理界面」两张面孔，跑的又是同一套核心
（`src/`）。所以移植不需要碰一行上游代码——**拉起这个进程、把它接出来**就够了。

于是本插件只有四层，加起来不到一千行：

```
server/env.js      路径 / 端口 / 配置（唯一真相来源）
server/engine.js   生命周期（探活 → spawn → 读握手 → 挂桥）+ 管理 API 客户端
server/bridge.js   同源改写反向代理（下面单独说）
server/index.js    MCP server（12 个工具，零依赖 stdio JSON-RPC）
panels/ofm.tsx     面板：内嵌管理界面 + 启停 / 重载 / 日志
server/upstream/   上游运行闭包（scripts/vendor-sync.mjs 刷进来，见 VENDOR.json）
```

不复制的东西：`client.js`（500KB 的 DSH 前端半身）、`adapter/`（cordis 适配层）、
`packages/desktop/`、`feed/`（公告与自更新，standalone 根本不加载）。
**上游的自更新器在 standalone 里不会被实例化**，所以它不会把 vendored 代码改掉。

---

## 二、为什么必须有那座桥（8132）

这是整个插件里唯一不显然、也最容易被误解的地方。

上游 standalone 把两张面孔挂在同一个端口上，但它们的边界不一样：

```
/v1/**               推理。带 CORS `*`，Origin 为 null 也能打 → 渲染进程直连没问题
/api/management/**   管理 API + 界面。没有 CORS，而且有一道同源栅栏：
                       referer/origin 必须缺省或以 http:// 开头
                       否则 403「管理接口仅允许本机同源访问」
                       （trust.js 的 structuralRejection 还要求 Origin 的
                        authority 等于 Host）
```

实测（这就是为什么要桥的直接证据）：

```
$ curl -H 'Origin: null' -H 'Authorization: Bearer <key>' http://127.0.0.1:18900/v1/models
{"object":"list","data":[…]}                       ← 推理面放行

$ curl -H 'Origin: null' -H 'Authorization: Bearer <key>' \
       http://127.0.0.1:18900/api/management/summary
{"error":"管理接口仅允许本机同源访问"}                ← 管理面拦掉
```

Notrat 的面板跑在渲染进程里，打包版从 `file://` 加载、`Origin` 为 `null`，正好撞在这道栅栏上。
所以插件起了桥（**固定 8132**），它做四件事：

1. 把 `Origin` / `Referer` 改写成上游自己的地址 → 过栅栏；
2. **所有**转发都补 `Authorization: Bearer <真 key>` → 过鉴权（上游的 `authenticated()` 认 Bearer，不必玩 Cookie）；
3. 回包补 CORS，面板 `fetch` 才读得到；
4. 把上游 CSP 里的 `frame-ancestors 'none'` 改成 `frame-ancestors *`，面板 iframe 才挂得上。

顺带两个好处：

- **端口固定**。上游端口被占会自己换（并把实际端口写回 `settings.json` 的 `standalonePort`），
  但你的自定义服务商钉在 8132，永远不用重填。
- **key 不必离开引擎**。自定义服务商填占位口令 `ofm-bridge` 即可，桥在出站时换成真 key；
  面板也从不接触明文 key，插件永不回传它。

---

## 三、安装

```bash
# 在插件目录里
node install.mjs              # 装到 ~/.notrat/plugins/notrat-our-free-model/
node install.mjs --dry-run    # 只看计划
node install.mjs --uninstall  # 卸载（保留数据目录）
```

不想 clone 也可以直接下 Release 里的 zip，解压后同样跑 `node install.mjs`：

```bash
gh release download v1.0.0 --repo postivecreator/notrat-our-free-model
unzip notrat-our-free-model-1.0.0.zip && cd notrat-our-free-model && node install.mjs
```

装完重启 Notrat（或等它热加载），状态栏「插件箱」里会出现 **🆓 模型池**。

首次打开面板点「启动」。首次启动上游会自己拉一次模型目录，几秒到几十秒。

> 数据目录：`~/.notrat/plugins/data/notrat-our-free-model/`
> `engine/` 是上游的家（`OFM_HOME`）——账号凭据、设置、用量、`service.lock` 都在里面。
> **不会**写 `~/.our-free-model`，那是上游独立服务自己的地盘。

---

### 界面里那颗「接入 Notrat」浮标

首屏就是上游那套管理界面。桥在转发它的 HTML 时会塞进一小段同源脚本
（`/__ofm/embed.js`，CSP 是 `script-src 'self'`，所以只能这么做），带来两件事：

1. **右下角一颗浮标**：点一下 → `postMessage` 回面板 → 面板调应用自己的
   `openExternal` → Notrat 弹导入确认框。不自己跳 `notrat://`，那会把 iframe 导航走。
   在系统浏览器里打开时浮标自动换成协议跳转。
2. **宽度自适应**：面板只**读**根节点宽度（`ResizeObserver`），据此切换
   `compact` 档（< 460px）。上游自己最窄断点做到 430px，所以侧栏 380px 时它会自己
   收窄布局；只在仍然横向溢出时，注入脚本才按溢出比例压一次 `zoom`（下限 0.55）。
   高度不走 JS —— 根节点是 `100dvh`（不支持 dvh 的旧内核回落 `100vh`），
   绝不「量父容器再写回自身高度」，那会在内容驱动高度的父容器里形成闭环、把页面越撑越长。

## 四、接成 Notrat 的服务商（一键）

面板「接入」页最上面就是那颗按钮：

**一键接入 Notrat** → 调用 `ofm_provider_link` 生成一条
`notrat://import-ai?type=openai&name=…&baseUrl=…&apiKey=…&model=…&models=…` 链接，
交给系统打开，Notrat 自己弹出导入确认框（服务商名、协议、地址、模型列表、打码后的 Key 都列着），
点确认才落盘 —— 走的是**应用自己的写入路径**，插件不去改任何配置文件。

为什么是链接而不是直接写配置：自定义服务商存在渲染进程的 localStorage（不是
`~/.notrat` 下的 JSON），插件改写它是越界且脆弱的。链接这条通道由 Notrat 持有，
它自己校验、自己确认，我们只负责把字段拼对。

**没弹框怎么办**：旁边那颗「复制 JSON」把同一份配置拷进剪贴板，粘到
设置 → AI → 导入 里，效果一样。协议没注册、或同时开着另一个 Notrat 实例时，链接会被系统丢掉。

### 手动填写（老办法，仍然有效）

### 手动方式（不点一键链接）

面板里点「启动」之后，或直接问助手「怎么用」，都会得到同样三行：

| 字段 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8132/v1` |
| API Key | `ofm-bridge`（占位口令，任意非空字符串都行） |
| 模型名 | 从 `ofm_models` 拿，或点「获取模型列表」 |

填在 **设置 → AI → 自定义服务商（OpenAI 兼容）**。

也可以用命令 `/ofm-wiring` 一步取全部信息。**模型 id 不要手抄或猜**——上游的免费模型名会变
（`deepseek-v4.1-flash-free`、`kimi-k3-free` 这类），拿列表最稳。

---

## 五、工具清单（13 个）

| 工具 | 干什么 |
| --- | --- |
| `ofm_engine` | `info` / `start` / `stop` / `restart` / `logs` / `close` |
| `ofm_status` | 总览：运行态、模型数、可用数、渠道、EAC 登录态、LAN 中继 |
| `ofm_wiring` | 接入三件套（baseUrl / 占位口令 / 模型 id） |
| `ofm_provider_link` | 一键接入链接（`notrat://import-ai?…`），点确认即落盘 |
| `ofm_models` | 模型目录；`refresh=true` 重新拉，`probe=true` 做可用性探测 |
| `ofm_model_test` | 单模型真实推理测试（耗额度） |
| `ofm_settings` | 读 / 改上游设置 |
| `ofm_key` | 打码查看 / 轮换 API Key（明文永不回传） |
| `ofm_channels` | 渠道状态，或直接向渠道运行时发 RPC |
| `ofm_stats` | 用量统计（按天、按模型） |
| `ofm_eac` | 桌面端 EAC 协付渠道（status / pool / login / logout） |
| `ofm_ui` | 管理界面地址（panelUrl / 一次性 loginUrl） |
| `ofm_config` | 本插件配置（enginePort / bridgePort / autoStart） |

斜杠命令：`/ofm-status` `/ofm-models` `/ofm-wiring` `/ofm-start` `/ofm-stop` `/ofm-doctor`。

---

## 六、排错

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| 面板一直「未启动」 | 引擎没起来 | 点「启动」，再看「日志」抽屉 |
| 启动报 `service.lock` | 同一数据目录已有实例在跑 | 别删锁。先 `ofm_status` 看端口（上游换端口会写回 `standalonePort`，插件会自动 attach） |
| 模型数为 0 | 目录没拉过 | `ofm_models` 传 `refresh=true` |
| 推理 401 | key 被轮换过 | `ofm_engine` action=`restart`（桥会用新的 key） |
| 推理 503 | 用户在上游设置里关了推理服务 | `ofm_settings` 传 `{"enabled": true}` |
| 面板 iframe 空白 | 桥没起来或端口被占 | 看 `ofm_engine` action=`logs`；`bridgePort` 可改（改完要重载插件） |
| 面板里点什么都 403 | 上游版本改了栅栏规则 | 这是上游行为变化，先 `vendor-sync --check` 看版本，再读 `src/trust.js` |

自检：

```bash
node tests/_smoke.mjs     # 20 项：握手 / 工具清单 / 启引擎 / 总览 / 接三件套 / 直打桥 / iframe / 管理 API / 停引擎
```

---

## 七、刷新上游

```bash
node scripts/vendor-sync.mjs --check            # 只看落后没有
node scripts/vendor-sync.mjs                    # 从 GitHub 拉最新并刷进 server/upstream/
node scripts/vendor-sync.mjs --from D:\dsh      # 用本地 checkout
node scripts/vendor-sync.mjs --rev 2.5.9        # 钉某个 tag
```

刷完跑一次 `node tests/_smoke.mjs`。上游改过栅栏或 `/v1` 形状时，桥与工具可能需要跟着调，
`VENDOR.json` 里记着当前钉的版本。

---

## 八、目录结构

```
manifest.json          Notrat 插件清单（MCP server / 命令 / 提示词段 / 面板）
install.mjs            安装器（manifest.json 最后落盘 = 安装信号）
panels/ofm.tsx         面板（内嵌管理界面 + 启停 / 重载 / 日志）
server/
  env.js               路径 / 端口 / 配置
  engine.js            生命周期 + 管理 API 客户端
  bridge.js            同源改写反向代理
  index.js             MCP server
  upstream/            上游运行闭包（src + packages/standalone + LICENSE + VENDOR.json）
scripts/vendor-sync.mjs  刷新上游
tests/_smoke.mjs       端到端自检
```

## 九、免责声明

以下措辞与上游仓库 `dsh-our-free-model` 的「免责声明」一节一致（仅将"本插件"的指代
明确到本项目），未作实质改动。上游原文见
<https://github.com/Ebony-Vinyl/dsh-our-free-model#免责声明>。

- **本插件是一个客户端，不是模型服务方。** 所有模型响应均由上述第三方上游（OpenCode Zen 网关、
  Kilo AI 公共网关、以及你自己部署的 EAC 网关）生成并传输；插件不托管、不修改、不过滤任何模型输出。
  模型可能产出错误、过时或有偏颇的内容，请自行核实后再使用。
- **免费不等于无限，也不等于私有。** 免费额度由上游单方面提供，随时可能限流、收费或下线；
  Kilo 免费池明确声明 prompt 可能被上游记录并用于改进服务。**请勿通过本插件的免费车道发送密码、
  密钥、个人身份信息、商业机密或任何你不愿第三方处理的内容**；生产与敏感场景请使用你自己的付费 API。
- **上游条款由你遵守。** 使用各渠道即表示你同意对应上游的服务条款与用量政策；因违反上游政策
  导致的限流、封禁或其它后果由使用者自行承担。插件不对任何上游的可用性、准确性或连续性作任何承诺。
- **EAC 渠道为协付性质。** 该渠道的凭据与网关由上游仓库维护者部署（GitHub 登录 + star 仓库解锁），
  仅限授权用户使用；请勿尝试绕过授权闸门，勿转售或共享渠道访问权——滥用会导致全体用户的通道被收紧。
- **本插件与上述任何上游厂商无隶属或背书关系。** 各厂商名称与商标归其各自所有者所有，
  仅在说明来源时引用。

本插件不发起任何登录、不代你同意任何条款、不转售任何访问权。账号渠道需要你**自己**在管理界面里
扫码或登录；引擎与界面均由上游在本机运行，Notrat 侧只负责进程托管与同源反代。

## 十、主题标签（GitHub topics）

上游仓库共 10 个 topic。本仓库**去掉与 DSH 宿主强绑定的三个**
（`dsh`、`dsh-plugin`、`deepseek-harness` —— `dsh` 即 DeepSeek Harness，
本插件已不再依赖该宿主），**保留其余 7 个**，并加上 Notrat 侧的 2 个：

```
ai-agents  deepseek  developer-tools  free-model  llm
model-provider  openai-compatible  notrat  notrat-plugin
```

`deepseek` 属于模型/厂商标识而非宿主框架，故保留；若希望仓库与上游完全脱钩，
再删掉它即可。

设置方式（topics 不写在文件里，需调用 API）：

```bash
# 把 PAT 放进环境变量，不要写进命令或提交到仓库
export GH_TOKEN=...            # 需要 "Administration" 写权限或 public_repo 范围

curl -X PUT \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/REPO/topics \
  -d '{"names":["ai-agents","deepseek","developer-tools","free-model","llm","model-provider","openai-compatible","notrat","notrat-plugin"]}'
```

或直接用 CLI 覆盖（`--add-topic` 只增不删，旧 topic 会留下来，所以用 `gh api` 一次写全）：

```bash
gh api -X PUT repos/OWNER/REPO/topics \
  -f names[]=ai-agents -f names[]=deepseek -f names[]=developer-tools \
  -f names[]=free-model -f names[]=llm -f names[]=model-provider \
  -f names[]=openai-compatible -f names[]=notrat -f names[]=notrat-plugin
```

## 十一、打包与发布

```bash
npm run pack                  # → dist/notrat-our-free-model-1.0.0.zip
node scripts/pack.mjs --version
```

用 `git archive` 而不是自行遍历目录，因为产物要**恰好等于一次提交的内容**：
`.gitignore` 自动生效（`node_modules`、`dist`、本地 `settings.json` 不会混进去），
同一个 commit 反复打包得到逐字节相同的 zip，脚本会打印 `sha256` 便于比对。
代价是工作区必须已提交 —— 有未提交改动时脚本直接拒绝，避免打出一个和源码不一致的包。

包内即为插件本体（`manifest.json` + `server/` + `panels/` + `install.mjs` …），
解压后目录名就是 `notrat-our-free-model/`，进去跑 `node install.mjs`。

发版：

```bash
git tag v1.0.0 && git push origin v1.0.0
gh release create v1.0.0 dist/notrat-our-free-model-1.0.0.zip \
  --title "1.0.0" --notes "首个开源版本：衍生自 dsh-our-free-model 2.5.9，接进 Notrat。"
```

## 许可证

本插件 MIT，**许可证文本与上游逐字相同**（`LICENSE`，`Copyright (c) 2026 Ebony-Vinyl`）。

上游 `server/upstream/` 全部来自 `Ebony-Vinyl/dsh-our-free-model`（MIT，upstream 2.5.9 /
standalone 2.5.4），原始许可证随代码放在 `server/upstream/LICENSE`。

本项目是上游的衍生作品。MIT 要求版权与许可声明随所有副本或主要部分保留，因此：

| 文件 | 作用 |
|---|---|
| `LICENSE` | MIT 原文，逐字保留上游版权行 |
| `NOTICE` | 说明衍生关系、改动范围、未包含的部分 |
| `server/upstream/LICENSE` | 随上游代码分发的原始许可证副本 |
| `server/upstream/VENDOR.json` | 上游版本、纳入与排除清单 |

"Our Free Model"、"DSH"、"DeepSeek"、"Notrat" 等名称与商标归各自所有者所有，
本项目仅在说明来源与兼容性时引用，与任何一方无隶属、认可或赞助关系。
