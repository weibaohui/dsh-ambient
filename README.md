# dsh-ambient（白噪音）

> dsh 插件 · 白噪音播放器：**场景完全由音频根目录下的文件夹决定——有什么文件夹就有什么场景，有什么音频就播什么。** 点「🤖 执行下载」让 AI 在后台从 Wikimedia Commons 按 CC0/PD/CC BY 许可分门别类下载到对应文件夹（读 INDEX.md 防重复）。顺序/随机/单曲循环/间歇四种播放模式 + N 小时或指定时刻定时关。宿主侧流式读取（Range 支持），不上传、不分发音频。

## 特性

- 📁 **场景纯目录驱动** —— libraryRoot 下每个子文件夹 = 一个场景（文件夹名即场景名），有什么算什么。无预制清单、无别名匹配、无程序化兜底。建文件夹即建场景，删文件夹即删场景。
- 🤖 **后台 AI 下载** —— 设置页点「执行下载」，宿主起后台 agent 会话（apiproxy 主对话，带 bash）自主执行：读 INDEX.md 跳过已有 → 搜 Wikimedia Commons API → 下载到对应场景文件夹 → 更新 INDEX.md/ATTRIBUTION.txt → 完成自动重扫库。按钮下方实时显示进度。
- 🎚️ **播放控制** —— 顺序循环 / 随机 / 单曲循环 / 间歇（20 放 5 停）四种模式；定时关支持 N 小时后或到指定时刻（HH:MM）。
- 🔊 **流式播放** —— 宿主侧 HTTP Range 流式（可拖进度），路径安全校验（防穿越），客户端只按 scene+track 下标请求、不接触绝对路径。
- 🛡️ **信任栅栏** —— 所有路由挂 `connection.requestRejection`（Host/Origin + 浏览器认证）。
- 📦 **零音频分发** —— 插件包内零音频文件；INDEX.md/ATTRIBUTION.txt 记录来源与许可。

## 音频怎么来

插件**不分发任何音频**。三条路：

1. **🤖 后台 AI 下载**（推荐）—— 设置页点「执行下载」，AI 后台跑：从 [Wikimedia Commons](https://commons.wikimedia.org/)（免 key、CC0/CC 许可）按场景搜索并下载到对应文件夹，维护 INDEX.md（下载关系追溯，防重复）与 ATTRIBUTION.txt（许可署名）。
2. **自己放音频** —— 把 `.mp3/.wav/.ogg/.m4a/.flac` 等放进 libraryRoot 下的任意子文件夹（中英文名均可），点「扫描」或重启即识别。
3. 场景名随意 —— 「雨」「rain」「我家后院」「午休室」……文件夹名就是场景名。

## AI 下载是怎么跑的

点击「执行下载」后，宿主通过 apiproxy（BrowserAuth cookie + 斜杠 RPC，dsh-sync 同款机器）创建一个**主对话级 agent 会话**（带 bash），把无人值守下载指令发给它，事件泵 300ms 抓取执行输出。你会在按钮下方看到实时进度（`[tool] bash curl …`），完成（或 30 分钟超时）后自动重扫库。单并发：有任务在跑时再点会显示当前进度。

指令要点（源码 `src/index.js` 的 `DOWNLOAD_AGENT_PROMPT`）：读 INDEX.md 跳过已有 → 按场景搜 Commons API → 许可优先 PD/CC0 > CC BY > CC BY-SA → 下载到对应文件夹 → 逐文件更新索引与署名 → 无人值守不提问。实测已知结论也写进去了：山林/沙漠/轮船/田野在 Commons 无合适录音，每个场景搜索预算 ≤2 分钟。

## 使用

1. 安装后重启 dsh：设置页出现「场景氛围音」，右下角出现迷你播放器（播放/暂停/场景/音量）。
2. 库为空时：点「🤖 执行下载」（后台自动下载），或自己在音频根目录建文件夹放音频，点「扫描」。
3. 场景下拉选一个，勾选启用（或直接点迷你播放器 ▶），即播。
4. 播放模式/定时关在设置页调整。

## 文件夹结构

```
~/.dsh/dsh-ambient/library/     ← 默认音频根目录（存在即自动采用）
  ├── 雨/
  │   ├── 01-小雨.mp3
  │   └── 02-大雨.mp3
  ├── my-office/
  │   └── hum.ogg
  └── 我家后院/
      └── garden.mp3
INDEX.md                        ← 下载索引（AI 维护，防重复下载）
ATTRIBUTION.txt                 ← 许可署名（AI 维护）
```

- 文件夹名 = 场景名（中英文、任意名字均可）
- 每个文件夹里的音频按文件名排序播放（`01-` 前缀可控顺序）
- 空文件夹不成场景；子文件夹会递归收音频

## 架构

| 文件 | 职责 |
|---|---|
| `src/index.js` | 宿主半体：配置持久化（storageDomain `dsh_ambient`）、纯目录扫描、音频流式路由（Range + 路径安全 + 信任栅栏）、后台 AI 下载任务（apiproxy 主会话 + 事件泵 + 30 分钟超时 + 完成自动重扫） |
| `client/scenes.js` | 音频扩展名 + MIME 表（host/client 共享） |
| `client/player.js` | 播放控制器：file/url 声源、四种播放模式、定时关（N 小时 / 指定时刻）、音量统一 |
| `client/index.js` | 客户端半体：store + 设置页（React）+ 迷你播放器（纯 DOM 浮窗）+ 下载任务轮询 |
| `client/bundle.js` | 构建产物（`npm run build:client`） |
| `scripts/build-client.mjs` | 内联 player + index + dsh-plugin-kit client source 成 bundle |
| `test/config.test.mjs` | 离线测试：配置归一化、纯目录扫描、路径安全、Range、库响应、后台下载 wire 形态 |
| `test/smoke-host.mjs` | 宿主路由集成测试：audio 200/206/404、信任栅栏、library 纯目录 |

## 开发

```bash
npm run check          # 语法检查（src + 3 client）
npm test               # 离线测试
npm run build:client   # 重新生成 bundle（改了 client/*.js 必须重跑）
node --test test/smoke-host.mjs   # 宿主路由集成测试
```

## 设计要点（来自系列插件真实事故）

- **storageDomain 表 spec 必须带 `valueSchema`** —— 缺了它存量记录一旦存在整个域打不开（dsh-matrix/fireworks 翻车）。本插件 `valueSchema: { parse: (v) => v }` + `invalidRecords: 'backup-and-skip'`。
- **后台 agent 用 apiproxy 主会话而非 agents.create 子 agent** —— 下载要 bash（curl 二进制音频），子 agent 精简无 bash（dsh-sync 实证）。
- **BrowserAuth cookie 铸造** —— 0.1.2-rc.1 起 `/api` 无凭证一律 401：先 GET `connection.authenticatedUrl()`（303 铸 dsh-auth-* cookie）再带 Cookie 头；RPC 斜杠端点 + `{args:{request}}` 包裹；404 回退 0.1.1 点号端点。
- **音频路由路径安全** —— `path.resolve` 后校验必须落在 libraryRoot 子树内；客户端只传 scene+track 下标。
- **迷你播放器回调先捕获值再调 player** —— setVolume→emit→render 会同步重置滑块 value，之后再读 slider.value 拿到旧值（真机抓过：音量永远存不上）。
- **配置场景回退** —— 场景纯目录驱动，config.scene 可能指向已删文件夹：库加载时找不到就回退第一个场景并写回。

## License

MIT

## 致谢

- [Wikimedia Commons](https://commons.wikimedia.org/) —— CC0/CC 氛围音来源（免 key、直链稳定）
- dsh-sync —— apiproxy 后台 agent 会话模式来源
- dsh-kb —— 无人值守执行器（agents.create + whenIdle）与「问 AI」交互参考
