# dsh-magpie-usage

DeepSeek Harness (DSH) 插件：将 Magpie 本地网关（`127.0.0.1:3425`）的配额与用量进度圆环嵌入 DSH 输入框底部状态栏（与上下文比例并列）。

![底部状态栏圆环效果截图](demo_dock.png)

## 功能特性

1. **底部状态栏极简圆环 (`conversation.composer.dock`)**：
   - 与原生 `ContextMeter` 上下文比例圆环（`○ 43%`）完全并列。
   - 采用一致的 14×14 SVG 矢量圆环架构，带有平滑动态进度弧线。
   - **会话感知**：自动跟踪当前会话选中的模型 Provider（如在 Kiro 会话显示 Kiro，在 Codex 会话显示 Codex）。
   - **悬停 1 秒快速预览**：显示对应 Provider 的精确重置时间；若存在 5 小时限制，自动展开五小时用量与重置倒计时。

2. **配额详情悬浮卡片 (向上平滑弹出)**：
   - 展现各账号的核心配额（7 天周期、5 小时限制、积分总额等）。
   - **置顶项自动置顶**：点击任一 Provider 的 `📌 置顶`，该卡片立刻移至列表最顶端。
   - **真实会话专属标识**：`● 当前会话` 标签严格锚定当前会话实际使用的 Provider，绝不混淆。
   - **智能识别限频**：模型处于熔断冷却态时显示为 `[冷却中]` 状态及倒计时。
   - **自动过滤杂质**：自动剔除网关的代理/管理页等非配额配置链接。
   - **双视角全会话同步**：支持「已用」与「剩余」双视角一键切换，跨所有会话全局实时同步。
   - **隐私保护**：支持一键切换账号邮箱脱敏（`h***4@proton.me`）。

3. **极致性能**：
   - **0ms 首屏秒开**：通过本地快照直出，刷新与重启瞬间无白屏闪烁。
   - **Token 流期间 0 消耗**：单例模型追踪器配合 150ms 防抖，文本流式生成期间完全静默无重绘。
   - **页面可见性感知**：窗口最小化或后台挂起时自动暂停轮询，切回前台静默对齐。
   - **同源安全代理**：内置 Node 端服务，提供 10s 请求去重与失败退避，彻底消除跨域限制。

## 安装方式

### 方式 1：通过 GitHub 一键安装（推荐）

```bash
# 桌面端 Desktop Profile
dsh plugin --profile desktop add github:hsthanb4/dsh-magpie-usage

# 普通 Web Profile
dsh plugin --profile web add github:hsthanb4/dsh-magpie-usage
```

### 方式 2：通过 DSH 桌面端插件市场安装

在 DSH 桌面端打开 **设置 → 插件**，搜索 `dsh-magpie-usage` 点击安装，刷新页面即可使用。

### 方式 3：本地开发 / 软链安装

```bash
cd ~/.dsh/profiles/desktop/node_modules
ln -s /path/to/dsh-magpie-usage dsh-magpie-usage
```

在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 中添加 `"dsh-magpie-usage"`。

## 使用前提

确保本机已启动 Magpie 本地网关（默认监听 `http://127.0.0.1:3425`）。

## 作者信息

- **Author**: hsthanb4 <1485209316@qq.com>
- **Repository**: [https://github.com/hsthanb4/dsh-magpie-usage](https://github.com/hsthanb4/dsh-magpie-usage)
- **License**: MIT
