# Changelog

##### **2026年8月10日（v0.1.1）**

English:
- Bump version to 0.1.1
- Fix chat toolbar selectors clipped by overflow (config / provider / mode unclickable)
- Fix revoking local settings.json authorization
- Surface Codex/Claude send failures in chat; swallow success JSON envelopes
- Fix Grok/CLI history isolation

中文:
- 版本升级到 0.1.1
- 修复底部工具栏配置/供应商/模式按钮菜单被裁切导致点不动
- 修复取消本地 settings.json 授权无效
- 发送失败在聊天区展示；成功结果 JSON 不再误入正文
- 修复 Grok/CLI 历史隔离

##### **2026年8月10日（v0.1.0）**

English:
- Bump version to 0.1.0 for Marketplace-compatible SemVer
- Clean packaging ignores (drop tests, sql.js debug builds, non-dist webview files)
- Remove personal local paths from README packaging instructions

中文:
- 版本升级到 0.1.0，符合 Marketplace 的 SemVer 要求
- 收紧打包忽略规则（排除测试、sql.js debug 构建、非 dist 的 webview 文件）
- 移除 README 打包说明中的个人本机路径

##### **2026年8月5日（v0.0.2-fix2）**

English:
- Add `enableDebugLog` setting (default off) and show Webview DevTools only when enabled
- Fix chat input drag-and-drop for files from Explorer (path references and images)
- Improve dependency detection and permission approvals

中文:
- 新增「调试日志」开关（默认关闭），仅开启时显示 Webview 开发者工具按钮
- 修复输入框拖放：支持从资源管理器拖入文件路径引用与图片
- 改进依赖检测与权限审批

##### **2026年8月4日（v0.0.1）**

English:
- Migrate JetBrains CC GUI to VS Code

中文:
- 迁移 JetBrains CC GUI 到 VSCode
