# 迁移计划: jetbrains-cc-gui v0.5.3 + PR #1707 → vscode-cc-gui

> 生成日期: 2026-08-22
> SOURCE: `/Users/zhukunpeng/Desktop/CC GUI 项目/jetbrains-cc-gui`(tag `v0.5.3` + 本地分支 `pr-1707`,基线 = v0.5.3)
> TARGET: `/Users/zhukunpeng/Desktop/vscode-cc-gui`(fork 基点 ≈ v0.4.5–v0.5.2,大量自有适配)
> 已确认范围: 对齐 v0.5.3 完整功能(含回补 v0.5.1/v0.5.2 缺口)+ PR #1707;**排除 Codex 桌面宠物**

## 架构映射

| SOURCE (IntelliJ) | TARGET (VS Code) | 迁移方式 |
|---|---|---|
| `ai-bridge/` (Node.js,纯 JS) | `ai-bridge/` | 近乎直搬,逐功能合并(不可整文件覆盖 daemon.js 等) |
| `webview/src` (React+Vite) | `webview/src` | 移植 + 三路合并(TARGET 有 VS Code 定制) |
| `src/main/java/...` (Java 宿主) | `src/` (TS 扩展宿主) | **重新实现**:MessageDispatcher/BridgeHandler 注册式分发 |

## TARGET 必须保留的自有适配(迁移时不可破坏)

- ai-bridge: ALS 请求上下文(多窗口并发)、`utils/request-context.js`、`daemon-line.js`、`cli-process-registry.js`、codex 双 runner、`cli-opened-files.js`、`context-append.js`、`message-permission.js`、permission bridgeRequestId 路由、`CLAUDE_CODE_ENTRYPOINT='claude-vscode'`
- webview: `detectIdeTheme`、`codexLiveInsert`、`streamStallTimeout`、`sendErrorPayload`、`dropPathUtils`、`autoOpenFileGate`、`selectionInfo`、`marketplaceUtils`、i18n VS Code locale 检测、ChatHeader returnToLiveSession
- 宿主: `src/bridge` 全套 VS Code 桥接

## 明确不迁移

- Codex pet 全部(CodexPetFloatingService/CodexPetHandler/pet/、webview `components/codexPet/`、`PetSettingsSection/`、~205 个 pet i18n 键)
- JCEF/OSR 特有:surfaceDamagePulse、forceWebviewRepaint、viewport zoom 补偿、OSR IME 修复、多 Tab JCEF 渲染修复
- Star History(README-only)

## 高危风险点(迁移中必须处理)

1. **daemon.js dispatch**: TARGET daemon 对未知 provider 直接 throw → ai-bridge 同步是宿主层注册 dsh/omp 的硬前置
2. **DSH 常驻进程误杀**: `dsh web` host 命令行不含 daemon/channel-manager → NodeProcessHandler 会判为 ORPHAN,"kill all orphans" 会误杀。必须加 owned-hint/排除规则
3. **config.json 原子写**: `writeCodemossConfigFile` 目前非原子;Java 已改原子写,两版共享 `~/.codemoss/config.json`,不同步会互读半截 JSON
4. **凭证存储**: Java 把 codex authJson 迁到 PasswordSafe;TARGET 对应 `context.secrets`,且 ProviderStore 读逻辑必须同步,否则两版并行互丢凭证
5. **historyLoadComplete 时序**: 带计数 + flush 后发送;TARGET 有 `__pendingSessionMessages` 缓冲,complete 先到会永久卡住前端 guard
6. **不内联文件内容**(行为变更): `_fillSelectedText` 的 readFileSync 内联要删,改为路径+`#L` 引用
7. **退役模型归一化** `normalizeRetiredModelId`: 必须覆盖所有写入 model 的入口(set_model/历史恢复/模板恢复)
8. **三路合并文件**(TARGET 有定制,绝不可整文件覆盖): daemon.js、permission-handler/ipc、api-config.js、codex-event-handler.js、prompt-enhancer.js、streamingCallbacks.ts、useMessageSender.ts、MarkdownBlock.tsx、ChatHeader.tsx、useSettingsThemeSync.ts

---

## 阶段划分

### Phase 1 — ai-bridge: 工具层 + Claude 核心修复组
**内容**:
- 工具: `path-utils.js`(#1343 防写桥目录)、`cli-path.js`(Windows spawn 工具箱,直接以 SOURCE 版替换)、`cli-image-input.js`、`permission-mapper.js`(#1702 approval_policy)、`stdin-utils.js`、`cli-spawn.js`(保留 registerCliProcess)
- Claude 核心(强耦合,一次做完): `conversation-chain.js`(compact 恢复核心)→ `task-notification-parser.js` → `message-utils.js`(extractResultError)→ `stream-delta-normalizer.js`(#1371 重复 token)→ `stream-event-processor.js`(sawTurnMessage)→ `runtime-lifecycle.js`(quiescence 门控)→ `persistent-query-service.js`(#1410,手工避开 TARGET bridgeRequestId 段)→ `session-service.js`/`message-rewind.js`/`message-sender.js`/`session-title-service.js` 路径统一
- 配置: `api-config.js` 功能级合并(AWS 注入 + #1509 MODEL_ROUTING 清空,保留 claude-vscode entrypoint)、`read-cc-switch-db.js`、`codex-utils.js`(#1702)
- 配套测试全部移植(含 testing/ 基建、3 个 child .mjs)

**验证**: `cd ai-bridge && npm test` 全绿

### Phase 2 — ai-bridge: CLI 提供商增强 + 一次性问答 + Codex plan
- kimi/pi/opencode message-service 图片附件 + models-service 改造 + 三 channel 的 attachments 参数(保留 openedFiles)
- `cli-ask.js` + `commit-message.js` 新增 → `prompt-enhancer.js` 手工合并(CLI 提供商扩展 + sonnet-5 退休迁移,保留 TARGET 编辑器上下文)
- `codex-plan-parser.js` 新增 → `codex-event-handler.js` 手工嫁接(plan 状态隔离 + 错误检测拆分)→ codex `models-service.js` + channel `listModels`

**验证**: ai-bridge 测试全绿 + 手动 smoke(各 CLI provider 发一条带图消息)

### Phase 3 — ai-bridge: 新提供商 OMP + DSH
- OMP: `services/omp/*` → `omp-channel.js` → channel-manager 注册
- DSH: `ws-client.js` → `host.js` → `supervisor.js` → `session.js` → `events.js`(需验证与 TARGET permission-ipc 的 `requestPermissionFromJava`/`requestAskUserQuestionAnswers` 导出兼容)→ `message-service.js`/`history-service.js`/`models-service.js` → `preset-overlay.js` → `dsh-channel.js` → 注册
- 收尾: `channel-manager.js` 合并(provider map、writeJsonAndExit;`injectStartupEnvVars` 默认维持 TARGET per-request 模型,实现时评估)、`daemon.js` 残余(WSL HOME、startup_failed 事件、dsh/omp dispatch 接入 ALS 框架)
- 全部配套测试(10+3 个)

**验证**: ai-bridge 测试全绿 + `node channel-manager.js dsh status` / `omp listModels` 手动验证

### Phase 4 — Grok ACP 重写【待用户决策】
- 若迁移: grok-utils → grok-acp-client → grok-event-normalizer(含 pr-1707 dedup)→ acp-terminal-host → persistent-acp-service → models-service → message-service/channel 替换 → daemon ALS 接线 → 评估退役 grok-image-prompt.js
- 若不迁移: PR #1707 的 grok dedup 跳过(仅适用 ACP 栈)

### Phase 5 — 宿主层 TS 重实现(依赖 Phase 3 完成)
按依赖顺序:
1. **Provider 注册 5 处**(S): types.ts RuntimeProviderId、cliTools.ts(CLI_ONLY/TOOL_DEFINITIONS/HISTORY_SUPPORTED)、SettingsHandler 白名单、statusbar 标签;DSH settings store + env 注入
2. **DshHostHandler**(M): get/start/stop/save_dsh_settings,复用 CliModelsHandler spawn 模式,防重入 + stderr tail
3. **DSH preset**(S): set_dsh_preset + send 透传
4. **历史**(L): DshHistoryReader(S)先行,OmpHistoryReader(690 行 Java 移植)殿后;HistoryService 分支
5. **Claude plan usage**(S-M): handler + 缓存 service + daemon line 识别 rate_limit_event
6. **Codex 系列**(M-L): subagent statuses → plan replay/is_error → MCP 门禁(isCodexConfigManagementAllowed)→ settings/credentials 重构(真 TOML 库 + 原子 RMW + snapshot 回滚 + context.secrets)→ skill toggle echo
7. **Session 杂项**(S-M): historyLoadComplete 计数+时序、文件引用不内联、退役模型归一化、NodeProcessHandler 词边界+DSH 防误杀、CliStatusDetector PATH、config.json 原子写

**验证**: `npm run compile`(tsc)+ src/__tests__ 全绿

### Phase 6 — webview(依赖 Phase 5 的桥消息)
1. **类型与纯函数**: types/*(OMP/DSH 表、动态 PermissionMode、sonnet-5 默认)+ utils/*(quoteUtils、pathSegment、planUsagePace、sessionFileLedger、fileTouchRegistry、taskNotificationMessage、subagentHistoryMerge、codexStatusRequestTracker、turnScope、bridgeStartup、claudeModelMapping、modelIconMapping)+ messageUtils/contentBlockNormalize 双载体对齐
2. **hooks**: providers/*(useCliModels 缓存、useDshProvider、useOmpProvider、useModelStatePersistence 退休迁移)→ useClaudePlanUsage、useCodexSubagentStatusPolling、useQuoteTags、useCompositionSafeTagRendering、useToolbarSelectorCompact、usePromptEnhancer、useFileTags 等
3. **输入框组件**: quote chips 全套 → ModelSelect pin/分组 → DshPresetSelect → PlanUsageIndicator+ContextBar → PromptEnhancerDialog meta → 其余 selectors + CSS
4. **消息渲染**: MessageList(quote 热键/右键/分页)→ MessageItem → MarkdownBlock 三路合并 → StatusPanel(原始 prompt 区块、multiAgent 徽标、净统计)→ toolBlocks 图片
5. **设置页**: CliSection+DshConnectionCard → CodexProviderSection/ProviderList/CustomModelDialog → AiFeatureProviderModelPanel → BasicConfig tabs → SkillsSettingsSection(#1438)→ MCP 读写确认 → settings 懒加载(无 pet tab)
6. **回调总装**: windowCallbacks 三路合并 → useMessageSender(quote 展开 + dshPreset)→ App/ChatScreen 接线 → global.d.ts → **i18n ~114 键 × 10 语言** → version/changelog.ts 按 TARGET 版本线生成

**验证**: `cd webview && npm test`(vitest)+ `npm run build`

### Phase 7 — 集成验证
- 全量: ai-bridge 测试 + webview 测试 + tsc + vsix 打包
- 手动 smoke 矩阵: 每 provider(claude/codex/grok/kimi/opencode/pi/omp/dsh)发送/历史/模型选择;DSH host 卡片 start/stop;preset 切换;plan usage 显示;quote chips;子代理状态
- 与 JetBrains 版并行运行验证 config.json 共享无冲突

## 执行约定

- 每个 Phase 完成后展示变更摘要,**经用户明确授权后才 commit**(遵循 Git Commit Policy)
- 迁移文件时优先保留 TARGET 自有适配,逐功能合并而非整文件覆盖
- SOURCE 参考提取: `git -C <jetbrains> archive pr-1707 <path> | tar -x -C /tmp/jb-ref`
