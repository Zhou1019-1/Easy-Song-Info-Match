# SongMatch

多来源歌曲信息**自选匹配** + 标签管理 + 歌词补齐 的 Electron 桌面工具（Windows 优先）。

面向拥有数千个本地音频、来源混杂（QQ音乐、Apple Music 转档、各类下载器、试音碟）、元数据残缺的音乐收藏者：

> 扫描本地音频 → 多来源（MusicBrainz / iTunes / 音源插件 / 本地线索）拉候选 →
> **用户自选匹配** → 补齐标签与歌词 → MP3tag 式批量标签管理与文件整理，全程可预览、可回滚。

---

## 功能

**扫描与本地信息提取**（优先级：标签 > 文件名 > 文件夹 > 联网）

- 递归扫描 FLAC / MP3 / M4A / WAV / OGG / OPUS 等，扫描与批量写入跑在 `worker_threads`，不卡 UI
- 多模式文件名解析（`歌名 - 歌手`、`01. 歌手 - 歌名`、`N-NN 歌名`、`歌名 - 歌手-专辑-来源后缀` 等）+ 文件夹上下文推断
- 每个字段记录**来源归属**：`filename` 还是 `folder` 分得清清楚楚
- 异常隔离不丢弃：损坏 / 读取失败 / 疑似乱码的文件单独进异常清单
- 脏数据修复：GBK↔UTF-8 乱码识别还原（`Ã×½òÐþÊ¦` → `米津玄師`）、非法文件名字符清理
- 扫描即产出三张清单：**候选清单 / 待确认队列 / 异常隔离清单**；用户已裁决的状态（已匹配 / 已否决 / 手动）不会被重新扫描覆盖

**多来源查询与自选匹配**（核心卖点）

- 三路内置来源 + 插件来源统一接口：MusicBrainz（曲名 / 歌手 / 专辑 / 年份 / 厂牌 / 目录编号 / UPC / 作曲家 / 版权）、iTunes（Explicit/Clean 分级、碟号 / 总碟数、版权行）、本地线索、用户导入的音源插件
- 各来源候选合并为**横向对比表**，按综合相似度排序并标注来源与匹配分
- **逐字段采用**：可以只取候选的标题与歌手，不取专辑；候选与现值差异高亮
- 打分含**版本限定词惩罚**：`Lemon` vs `Lemon (Live)`、Live vs Remix 会被拉开分差；`remastered` / `explicit` 这类同录音修饰词不误伤
- 查询节流：MusicBrainz 1 次/秒 + 指数退避；结果入 SQLite 缓存，**断网可重跑已查条目**

**歌词补齐**

- 歌词来源：本地 .lrc / 内嵌歌词、音源插件 `lyric` 接口、公开库尽力而为，多来源同样走候选自选
- 三种落地方式可选：写内嵌歌词（FLAC: `LYRICS` / MP3: `USLT` / MP4: `©lyr`）、生成同名 `.lrc`、两者都要
- 写入前预览：前 8 行 + 行数 / 时长覆盖度 + 标题相似度校验，防止下错歌的词
- 歌词偏移支持全局设定 + 按曲微调（按曲钳制在 ±5s 内，按文件记忆）
- 已有歌词默认不动，覆盖需确认

**标签管理**（MP3tag 风格）

- 虚拟滚动表格：列排序、搜索、按字段筛选；单选 / 多选批量编辑
- **勾选式写回**：每字段一个勾选框，只写勾中的；支持字段清空（删除字段也算一次修改，进 undo 批次）
- 多歌手分隔符统一：`;` `、` > `,` > `&` > `feat.`，**`AC/DC`、`K/DA`、`Fujiya & Miyagi` 类艺名禁止拆分**（另有保护名单）
- 别名归一：「写法 → 规范名」映射（老鹰/Eagles→Eagles、Fool's Garden/Fools Garden→统一），映射表可编辑导入导出
- 按标签重命名（MP3tag 式格式串：`{artist}/{album}/{title}/{track}/{year}…`）、按「歌手/专辑[/年份]」归档移动，同名自动加序号（`Song (2).mp3`），两个文件映射到同一目标名时**两个都保留**

**字段映射**：作曲家 / 碟号 / 版权 / 厂牌 / UPC / 内容分级 / 歌词等语义字段在 FLAC(Vorbis) / MP3(ID3) / MP4 原子间的映射写入前可见；写入失败明确提示，禁止静默跳过。

**音源插件宿主**

- **本体不内置任何音乐音源、不获取 / 不分发音频数据**，音源由用户自行导入且合法性自负
- 兼容洛雪音乐自定义音源格式（`.js`），支持其事件驱动协议（`on` / `send` / `EVENT_NAMES`）与传统 `module.exports` 函数式协议
- `node:vm` 沙箱执行：禁用动态代码生成（`codeGeneration:{strings:false,wasm:false}`），脚本加载 5s 超时、单次调用 10s 超时熔断，插件崩溃 / 死循环**不影响主程序**
- 插件管理页：导入 / 停用 / 删除、版本与声明查看、调用日志、单插件限速；不兼容能力逐条列出「不兼容提示」，不静默吞掉

---

## 核心原则（七条硬性约束）

| # | 约束 | 落地方式 |
|---|---|---|
| 1 | **永不静默覆盖** | 重名加序号；默认仅补空字段，覆盖需二次确认 + 逐字段 diff |
| 2 | **先干跑后执行** | 任何批量操作先出预览报告（N 个文件、哪些字段、旧值→新值、来源），确认后才落地 |
| 3 | **宁缺毋滥** | 低分候选留空标「待确认」，禁止编造 |
| 4 | **完全可回滚** | 备份 JSON 含时间戳与批次号，按批次 `undo`；删除字段也算修改 |
| 5 | **只改元数据，不动音频流** | 每次写入前后比对音频数据区哈希，不一致即判失败并阻止操作 |
| 6 | **来源可追溯** | 每个字段记录来源（标签 / 文件名 / 文件夹 / MusicBrainz / iTunes / 插件 / 歌词解析 / 手动） |
| 7 | **零内置国内平台音源** | 只做音源插件宿主，平台数据一律由用户导入的插件提供 |

---

## 技术栈

- Electron 44 + electron-vite 6 + Vue 3 + TypeScript 5
- `node-taglib-sharp`（纯 JS TagLib 移植）读写标签，`iconv-lite` 做乱码修复
- `better-sqlite3` 存查询缓存 / 匹配记录 / 回滚日志 / 歌词偏移
- `worker_threads`：扫描、批量写入、插件调用三类重活全部离开渲染进程
- `vitest` 210 个用例（含 10 个样本场景）

---

## 构建与运行

```bash
npm install          # postinstall 会用 electron-builder 重建 better-sqlite3（Electron ABI）
npm run dev          # 开发模式
npm test             # pretest 先确定性生成测试样本，再跑 vitest（210 个用例）
npm run typecheck    # vue-tsc（渲染层）+ tsc（主进程）
npm run dist         # 产出 release/SongMatch-1.0.0-setup.exe（NSIS 安装包）
```

其他命令：`npm run preview`（预览构建产物）、`npm run test:watch`（测试监听）、`npm run smoke`（只跑样本场景套件）。

**国内网络环境的两个坑**

1. Electron 二进制默认从 GitHub Release 下载，容易超时。`electron-builder.yml` 已配
   `electronDownload.mirror: https://npmmirror.com/mirrors/electron/`；若 `node_modules/electron/dist/electron.exe`
   仍缺失，手动执行：

   ```bash
   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   node node_modules/electron/install.js
   ```

2. `better-sqlite3` 是原生模块，必须针对 Electron 的 ABI 重新编译，否则运行时抛 `NODE_MODULE_VERSION` 不匹配。
   `postinstall` 已处理。

**便携模式**：在 `SongMatch.exe` 同级放一个名为 `portable` 的空目录，数据库 / 插件 / 备份 / 日志即全部写到
`<exeDir>/portable/data`，不再使用 `%APPDATA%/SongMatch`。

---

## 项目结构

```text
src/
├── main/
│   ├── core/        # 纯逻辑：文件名解析、乱码修复、别名、打分、字段映射、扫描、
│   │                #        标签读写、歌词流水线、批量引擎、重命名、哈希校验
│   ├── db/          # SQLite（better-sqlite3）
│   ├── sources/     # MusicBrainz / iTunes / 本地线索适配器
│   ├── plugins/     # 洛雪格式音源插件宿主（node:vm 沙箱）
│   ├── workers/     # scan / write / plugin 三个 worker_threads
│   ├── tasks/       # 任务中心
│   └── ipc/         # 主进程 IPC
├── preload/
├── renderer/        # Vue3 界面：曲库、匹配、歌词、插件、任务、设置
└── shared/          # 主进程与渲染进程共享的类型与常量
tests/               # 单元测试 + 10 个样本场景（scenarios.test.ts）
docs/design-notes.md # 设计取舍：从哪些项目借鉴了什么、放弃了什么、为什么
```

---

## 免责声明

本应用**不内置任何音乐音源、不获取 / 不分发音频数据**。在线元数据能力全部来自用户自行导入的音源插件
（或 MusicBrainz / iTunes 等公开 API），导入的插件仅在受限沙箱中运行，其数据合法性责任随插件归属用户。
插件返回的所有数据仍需用户确认后才会写入文件。

## 已知限制

- 归档目录结构按原相对路径保留，重命名模板只作用于文件名，不支持自定义子目录占位符
- `node-taglib-sharp` 对 DSF / DFF 等冷门格式支持有限；WAV 走 RIFF INFO + 兼容 ID3v2 双写
- 绝对打分模型下，信息不全的文件封顶分更低（只填标题 + 歌手时上限 72 分），这是有意为之——它让「我到底知道多少」可见
- 插件宿主只实现洛雪运行时子集（`lx.utils` 提供 `buffer` / `crypto` / `zlib`），依赖 `lx.log` / `lx.apiCaller` 等的脚本会拿到明确的「宿主不支持」提示

完整的取舍说明见 [docs/design-notes.md](docs/design-notes.md)。

## License

MIT
