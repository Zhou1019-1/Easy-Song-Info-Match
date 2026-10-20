# SongMatch 设计说明

> 本文回答两个问题：**从同类工具借鉴了什么、放弃了什么、为什么**；以及**本项目自己做了哪些关键取舍**。
>
> 规范来源：`SongMatch 提示词.md`。凡是本文与提示词冲突的地方，以提示词为准。

---

## 一、四个参照项目

### 1. lx-music-desktop（洛雪音乐）

**借鉴**

| 借鉴点 | 落地位置 |
|---|---|
| **音源由用户自行导入，本体零内置音源**的合规边界 | `src/main/plugins/`。SongMatch 不写任何平台接口代码，只做**音源插件宿主**；插件页顶部固定声明「本应用不内置任何音乐音源、不获取 / 不分发音频数据，音源由用户自行导入且合法性自负」（`src/renderer/components/PluginsView.vue`）。 |
| **`node:vm` 沙箱 + 超时熔断** | `src/main/plugins/lxRuntime.ts`。`vm.createContext` + `codeGeneration:{strings:false,wasm:false}`；脚本加载 5s 超时、单次调用 10s 超时；超时后插件被标记 `poisoned`，后续调用立即失败。插件崩溃/死循环**不影响主程序**（验收③）。 |
| **`%APPDATA%` 与 exe 旁 `portable` 目录双模式** | `src/main/core/paths.ts`。检测到 exe 同级存在 `portable` 目录即切便携模式，数据库 / 插件 / 备份 / 日志都落在 `<exeDir>/portable/data` 下。 |
| **自定义源脚本的头部元信息约定**（`@name` / `@version` / `@description`） | `parseHeader()` 解析脚本头部注释，插件列表直接展示声明的名称与版本。 |

**放弃**

- **放弃其内置的各平台音源实现**：提示词第四节明令"零内置音源、零平台接口代码"。SongMatch 只是一个宿主，不做任何平台请求。
- **放弃其自带的播放器与歌词缓存策略**：SongMatch 是标签管理工具，不承担播放职责；歌词只做"补齐与写回"，不做播放端的歌词同步。
- **放弃其音源脚本的完整运行时环境**：洛雪脚本会用到 `lx.utils.buffer` / `crypto` / `zlib` 等宿主能力，SongMatch 只实现其中被明确需要的子集，**缺失的能力在插件页以中文"不兼容提示"列出，不静默吞掉**。

---

### 2. AnniePlayer-LXversion

**借鉴**

| 借鉴点 | 落地位置 |
|---|---|
| **musicSdk 的"多平台统一查询"抽象** | `src/main/sources/`。统一 `SourceAdapter` 契约：`query()` 返回候选数组 + `fromCache` + `message`，每个来源取 3~5 个候选（`perSourceLimit`）。内置 MusicBrainz、iTunes 与"本地线索"三个来源，插件作为第四类来源接入同一套接口。 |
| **标签编辑器的勾选式写回** | `Matcher.toFieldSelection()` 只把**用户勾选的字段**放进写入集合（`sources[field]` 同时记录来源）；`previewTagWrite` 逐字段给出 diff，`overwrite=false` 时已有值的字段记为 skipped 并提示"可勾选强制覆盖"。 |
| **歌词偏移（±0.5s）** | `src/main/core/lyricPipeline.ts`，偏移量按文件记忆在 `lyric_offsets` 表，写入前预览。 |

**放弃**

- **放弃内置 SDK 与任何平台请求实现**：同上，零平台接口代码。
- **放弃"单曲自动全量写回"**：提示词要求逐字段确认、默认只补空字段。SongMatch 任何一次写入都先干跑（dry-run），把 diff 摆在用户面前。
- **放弃自动下载/替换音频文件**：SongMatch 只改元数据，**永远不碰音频数据区**。
- **暂不做「重复检测」**：AnniePlayer 用重复检测帮用户清理同一个文件的多个副本。SongMatch 目前不做，原因是**同名同长的文件未必是重复**（不同录音的同名专辑曲目、伴奏版 vs 录音室版时长接近但内容不同），误判的代价是让用户以为可以安全删除。宁可让用户在表格里按歌手 / 专辑 / 时长自行排序筛选，也不替用户做删除决策。

---

### 3. MP3tag

**借鉴**

| 借鉴点 | 落地位置 |
|---|---|
| **列表即表格** | `src/renderer/components/LibraryView.vue`。左侧表格即全部文件，右侧是筛选与批量操作面板。 |
| **格式串重命名** | `src/main/core/rename.ts` 的 `renderTemplate()`，占位符风格对齐 MP3tag：`{title}` `{artist}` `{album}` `{albumartist}` `{track}` `{totaltracks}` `{disc}` `{year}` `{genre}` `{ext}`。未知占位符**原样保留并产出 warning**，不静默吞掉。 |
| **字段清空** | `previewClearFields()` / `executeTagWrite({clearFields})`。清空也是一次"修改"，会进 undo 批次（提示词硬性约束④：删除字段也算修改）。 |
| **同名自动加序号** | `uniqueFileName()`：`Song.mp3` → `Song (2).mp3` → `Song (3).mp3`，同批次内 `reserved` 集合跨文件累积，**两个文件映射到同一目标名时两个都保留**（验收④）。 |

**放弃**

- **放弃其专有格式串语法**（`%a` / `%f` 之类）：改用更易读的 `{artist}` 风格，代价是无法直接导入 MP3tag 的改名预设。
- **放弃 COM 自动化与 Windows Shell 扩展**：这些是 Windows 专属且需要注册表写入，Electron 应用不适合。
- **放弃原生 TagLib 依赖**：改用**纯 JS 的 `node-taglib-sharp`**，免 C++ 编译、跨平台打包简单，代价是极端冷门格式的标签支持不如原生 TagLib 全。

---

### 4. MusicBrainz Picard

**借鉴**

| 借鉴点 | 落地位置 |
|---|---|
| **多候选横向对比 + 置信度** | `src/main/core/scoring.ts` 的 `scoreCandidate()` 给出 0~100 的总分与 5 个维度的明细（标题 / 歌手 / 专辑 / 时长 / 年份），`MatchView.vue` 以横向表格呈现各来源的候选。 |
| **逐字段采用** | 采纳候选时按字段勾选，用户可以只取标题、歌手而不取专辑（`Matcher.toFieldSelection`），对应 Picard 的"逐字段采用"。 |
| **宁缺毋滥的白/灰名单思路** | 低分候选**一律不自动写入**，只标"待确认"；`AUTO_ACCEPT_SCORE=60` / `HIGH_CONFIDENCE_SCORE=85` 只是状态标记，**任何时候都不代替用户选择**。 |
| **来源可追溯** | `tags` 表每个字段都带 `source` 列（`tag` / `filename` / `folder` / `musicbrainz` / `itunes` / `plugin` / `manual` / …），任何时候都能回答"这个值是哪来的"。 |

**放弃**

- **放弃自动写入与自动提交**：Picard 可以自动写标签，本项目不行——提示词要求"用户自选匹配"且"永不静默覆盖"。
- **放弃默认开启的声纹识别（AcoustID）**：会引入额外的上传与隐私问题；本项目的本地线索只做"文件已存在同名同长度的文件"这类零风险的判别。
- **放弃其"灰名单"自动拒绝机制**：本项目只做"不自动采纳"，不主动替用户否决——否决权保留在用户手里（`matchState: 'rejected'` 只能由用户点出来）。

---

## 二、本项目自己的关键取舍

### 1. 打分模型：绝对权重，而不是按可用字段归一化

标题 0.38 / 歌手 0.34 / 专辑 0.12 / 时长 0.12 / 年份 0.04，**查询侧缺失的字段直接计 0 分**。

- **为什么不用归一化**：归一化能让"完美匹配"恒等于 100 分，看起来更直观，但一个只填了标题和歌手的文件会和一个填全了五个字段的文件得到同样的分数，**分数不再代表绝对置信度**，也就无法判断"这个候选到底有多可信"。绝对权重下，72 分就老老实实表示"只验证了标题和歌手"。
- **代价**：信息不全的文件封顶分更低（只有标题 + 歌手时上限 72 分）。这是有意的——它让"我到底知道多少"这件事变得可见。
- **补强**：为了区分"现场版 vs 录音室版"，`scoreCandidate` 在标题分上叠加**版本限定词惩罚**（`versionQualifiers` / `applyVersionPenalty`）。只有一侧带限定词（一方是 `Lemon`、另一方是 `Lemon (Live)`）→ 标题分 × 0.65；两侧都带但不同（Live vs Remix）→ × 0.55。`remastered` / `explicit` 这类只描述同一录音的修饰词**不在限定词表里**，不会误伤。

### 2. 插件兼容层：兼容洛雪事件协议，但把差异摊开讲

洛雪自定义源的真实契约是**事件驱动**的：脚本不导出 `module.exports`，而是用 `on(EVENT_NAMES.request, handler)` 注册处理器、用 `send(EVENT_NAMES.inited, {sources})` 声明音源；request handler **直接 return 结果**。SongMatch 的 `lxRuntime.ts` 同时支持这套协议与传统的 `module.exports` 函数式协议。

差异处理原则是**只做适配、不做吞掉**：

- 洛雪里 `lyric` / `pic` 只有 `local` 源可用 → 本宿主对非 local 源直接报错「源「X」不支持 lyric/pic（仅 local 源支持）」，而不是返回空值。
- 脚本没声明 `local` 源 → 记录「脚本未声明 local 源，歌词/封面请求可能无法被正确处理」。
- 脚本同时没导出 `module.exports`、也没注册 lx 事件 → 加载失败并说明「无法识别插件协议」。
- 脚本访问 `require` / `process` → 记录「脚本尝试访问 require/process，已被沙箱拒绝」。
- 宿主不提供的 lx 成员（`currentMusicInfo` / `log` / `apiCaller`）→ 在插件页列为"宿主不支持"。

这些信息全部汇总进 `PluginInfo.incompatibilities`，在插件管理页逐条展示。

### 3. 重活全部离开渲染进程

- 扫描（目录遍历 + 标签读取 + 音频哈希）跑在 `src/main/workers/scan.worker.ts`；
- 批量写入跑在 `src/main/workers/write.worker.ts`；
- 两者都通过 `worker_threads` 与主进程通信，进度实时回传到任务中心。

**理由**：提示词要求"主进程重活全离开渲染进程"，同时要求"1000 个文件扫描 < 30s"。实测 1000 文件约 3.2s。

### 4. 只改元数据，不动音频数据区

每次写入前后都会算**音频数据区哈希**（不含标签），不一致就判定失败并阻止本次操作。这条约束由 `write.worker.ts` 强制执行，不是靠调用方自觉。验收⑦因此是可验证的，而不是一句承诺。

### 5. 一切写入都可回滚

每个批量操作是一个独立**批次**：

- 批次 JSON 备份（含时间戳与批次号）写到 `backupDir`；
- 标签级、路径级（重命名 / 移动）改动都写 `undo_entries`；
- `undoBatch()` 先逆序回滚路径，再按文件分组回滚标签（写回后重新读盘同步库内标签）。

### 6. 扫描阶段的"待确认队列"

扫描本身就是一次信息提取，**不完全可信**的文件必须在扫描阶段就进入待确认队列，而不是等跑完匹配才被发现：

- 文件**没有任何内嵌标签** → 全部信息都靠文件名 / 文件夹推断 → `no-tags` + `matchState='pending'`；
- 文件读取失败或疑似损坏 → `pending`；
- 文件名解析置信度为 `low` → `pending`。

**用户裁决过的状态不会被扫描覆盖**：重新扫描时，`matched` / `rejected` / `manual` 三种状态原样保留，只有 `none` / `pending` 会被新的扫描结果刷新。

### 7. 来源归属必须分清"文件名"和"文件夹"

文件名解析器在记录 `title` / `artist` / `album` 的同时，会额外记录 `artistSource` / `albumSource`（`filename` 还是 `folder`）。这样界面上才能诚实地告诉用户"这个专辑名是从文件夹名猜的"，而不是把两者混为一谈——这正是提示词第六节"来源可追溯"的要求。

---

## 三、已知限制（如实记录）

1. **归档目录结构按原相对路径保留**，重命名模板只作用于文件名，不支持在模板里写自定义子目录占位符（如 `{album}/`）。
2. **部分格式的标签能力有限**：`node-taglib-sharp` 是 TagLib 的纯 JS 移植，对 DSF / DFF 等格式支持有限；WAV 走 RIFF INFO + 兼容 ID3v2 双写。
3. **绝对打分模型的代价**：见第二节第 1 条，信息不全的文件封顶分更低。
4. **插件宿主只实现了洛雪运行时的一小部分**：`lx.utils` 只提供 `buffer`（编解码）、`crypto`（摘要）与 `zlib`（压缩）三个子集，依赖 `lx.log` / `lx.apiCaller` / `lx.currentMusicInfo` 的脚本会拿到"宿主不支持"的提示而不是静默失败。
5. **来源适配器目前只有 MusicBrainz / iTunes / 本地线索三个内置来源**，均为公开 API；国内平台一律通过用户导入的音源插件接入。

---

## 四、测试与验收对照

| 验收标准 | 对应测试 |
|---|---|
| ① 1000 文件扫描产出候选清单 / 待确认队列 / 异常隔离清单 | `tests/scenarios.test.ts` 场景 1、场景 2、场景 10 |
| ② ≥3 来源候选对比且可只采用部分字段 | 场景 3、场景 4 |
| ③ 导入洛雪格式源补齐歌词与封面；插件 kill / 死循环不影响主程序 | 场景 5、场景 6 |
| ④ 批量清空后 undo 完整恢复；两次同名归档均保留 | 场景 7 |
| ⑤ 断网可从缓存重跑；MB 503 自动退避重试 | 场景 8 |
| ⑥ 歌词纯文本正确写入内嵌 + 生成 .lrc；已有歌词未被改动 | 场景 9 |
| ⑦ 全过程音频数据区哈希不变 | 场景 10 |

纯函数另有单元测试：`charset`（30）、`tagIo`（25）、`lyrics`（19）、`scoring`（34）、`alias`（26）、`fieldMap`（22）、`rename`（16）、`filenameParser`（15）。

---

## 五、从零构建与运行

```bash
npm install          # postinstall 会用 electron-builder 重建 better-sqlite3（Electron ABI）
npm test             # pretest 先确定性生成测试样本，再跑 vitest（9 个文件 / 210 个用例）
npm run typecheck    # vue-tsc（渲染层）+ tsc（主进程）
npm run dev          # 开发模式
npm run dist         # 产出 release/SongMatch-1.0.0-setup.exe（NSIS 安装包）
```

**国内网络环境的两个坑**

1. Electron 二进制默认从 GitHub Release 下载，很容易超时。`electron-builder.yml` 里已经配了
   `electronDownload.mirror: https://npmmirror.com/mirrors/electron/`；如果 `node_modules/electron/dist/electron.exe`
   仍然缺失，手动执行：
   ```bash
   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   node node_modules/electron/install.js
   ```
2. `better-sqlite3` 是原生模块，必须针对 Electron 的 ABI 重新编译，否则运行时抛
   `NODE_MODULE_VERSION` 不匹配。`postinstall` 已经处理了这一点；本项目的 Node 24 与 Electron 44 的
   ABI 都是 137，因此同一份二进制在测试与运行时都能直接加载。

**便携模式**：把一个名为 `portable` 的空目录放在 `SongMatch.exe` 同级，程序即把数据库、插件、备份与日志
全部写到 `<exeDir>/portable/data` 下，不再使用 `%APPDATA%/SongMatch`（`src/main/core/paths.ts`）。
