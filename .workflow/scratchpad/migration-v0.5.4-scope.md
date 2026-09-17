# v0.5.4 (PR #1707) → vscode-cc-gui 0.1.8 迁移范围

> 日期: 2026-08-27。SOURCE: jetbrains-cc-gui @ 42f9786 (base 09db2c89)。
> 上一轮计划(migration-v0.5.3-pr1707-plan.md)未在本仓库执行;当前仓库无 DSH/OMP/pet/plan-usage。

## 迁移(7+1 个任务)

- A: thinking 块边界 (166fa14f/6bb90fb0/ae470f57) + daemon ready 前置 (fa2010cc) + #1509 模型路由 env 清空 (2f7c71d7)
- B: MCP stdin EOF (e00fb80e) + .mcp.json ${VAR} 展开 (4700ba6d)
- C: #1693 退役模型 sonnet-4-6→sonnet-5 自愈迁移 (17f68489)
- D: #1726 @file 含空格文件名 + 文件引用间文本保留 (a731db51/349bf3a7/7d816f65/667846e2) + #1700 残留选区插入丢内容 (85ef43b7)
- F: Claude settings 启动同步改 repair-only (f627d07d/e6129e2b/9358a65b/1b6aafe0)
- G: 模型标签/图标按 provider 隔离 (e7bb13a4)
- H: Codex 子代理生命周期 + plan 渲染 (6afc2303/e2e86558/65655ea0/daea8a8c/a227c652 + 664f2148 rollout 历史部分)
- E(第二波): Claude plan usage 用量条全栈 (f6f42068/a39c1f35/06b19e74/b0488e2e/655398dc/3b5feff1)

## 不迁移(原因)

- OMP provider (9d55cd6f): 全新 provider 全栈(含 690 行 Java OmpHistoryReader),独立大特性,后续单独迁移
- DSH preset (4fb3d3c9 等): 本仓库无 DSH provider(v0.5.3 未迁移)
- Codex pet (4f860371/9a613366/9104351d): 项目约定不迁移桌面宠物
- Node 检测移出 EDT (1d5bc14e/ba91d994): JetBrains EDT 特有;VSCode 侧 nodeDetector 本就异步
- Codex 凭证/设置原子化重构 (9fe8c832/79b11fc8): 依赖 Java PasswordSafe,宿主架构不同
- Grok ACP 常驻 runtime (6ae079af/184930a7): 本仓库 Grok 仍为旧 CLI 栈,ACP 栈未迁移
- 模型配置紧凑下拉重构 (c47bc3cb/ff903af1): UI 重设计,与本地 selector 定制冲突面大,后续单独评估
- docs 链接 open_browser (db9874a4): JCEF 特有,VSCode 另有外链机制
- JCEF/OSR 相关: 不适用
