# dsh-preview

[English](README.md) | 中文

**给你的 DeepSeek Harness agent 装上眼睛——它写的页面，它自己打开、自己看、自己修。**

dsh agent 能写出一整个 Web 应用，却从没"见过"它：改完 CSS 无法确认效果，"验证"页面靠重读源码，最后还得让*你*打开浏览器替它描述哪里坏了。`dsh-preview` 补上这个闭环：六个无头浏览器工具加一个内置验证技能，agent 在宣称"做完了"之前，自己打开刚写的页面、查控制台、读渲染后的 DOM、点按钮走交互，最后给你留一张截图。

## 实际效果

![agent 验证中的体素世界](docs/demo-voxel.png)

*这张截图是 agent 在验证过程中自己拍的。*

一次真实、未剪辑的运行：让 dsh agent（DeepSeek-V4-Pro）验证它之前写的 Three.js 体素游戏。装上 `dsh-preview` 后，它全自主完成了：

1. `browser_open http://localhost:8091` —— 页面加载成功，加载期零控制台错误。
2. `browser_console` —— 发现一条 404（`/favicon.ico`），正确判断为无害；其余 7 个本地资源全部 200。
3. `browser_read` —— 逐字确认了开始界面文案、操作说明和 HUD 文本。
4. `browser_interact`（点击开始按钮）—— 遮罩关闭、HUD 出现，**它亲眼看着坐标从 41.0 落到 39.0、FPS 稳定在 120**，据此判断物理和渲染循环正常。无新增错误。
5. `browser_screenshot` —— 开始前/后两张 PNG 存进工作区留档。
6. 报告里明确列出验证了什么——以及验证*不了*什么（真实 GPU 渲染、指针锁定手感）。

全程没有人类转述过一张截图。

## 安装

```sh
dsh plugin --profile web add dsh-preview
```

自动使用你机器上的 Chromium 内核浏览器——Google Chrome、Microsoft Edge 开箱即用；都没有的话执行一次 `npx playwright install chromium` 并把 `browserChannels` 设为 `[chromium]`。

需要 Node `^22.19 || >=24`（与 dsh 本体一致）。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `browser_open` | 打开 http(s) URL 或**本地文件/目录**（自动经 127.0.0.1 静态服务）。返回 `pageId` 和加载期控制台错误。 |
| `browser_console` | 自加载以来捕获的控制台消息 + 失败网络请求。 |
| `browser_read` | 无需视觉的确定性读取：渲染后 `text`、外层 `html`、或指定选择器的 `styles`（盒模型 + 关键计算样式）。 |
| `browser_interact` | 对选择器执行点击/输入/按键/滚动，并报告交互引发的新控制台错误。 |
| `browser_screenshot` | 视口、全页或单元素 PNG，存入工作区。 |
| `browser_close` | 验证完毕后关闭页面。 |

`browser_read` 是设计核心：纯文本模型用**确定性事实**（盒尺寸、颜色、display 值、渲染文案）验证布局，而不是对着像素猜。截图是给人看的。

## 内置技能

插件自带 `frontend-verify` 技能，教会 agent 完整纪律：**打开 → 查控制台 → 读取 → 交互 → 截图 → 修复 → 复验**；逐字报告通过了什么检查，说不清的部分明确点名而不是含糊带过。想用自己的流程可设 `registerSkill: false` 关闭。

## 配置

所有可调项都是插件配置——写进 profile 的 `cordis.patch.yml`：

```yaml
- id: preview
  name: dsh-preview
  config:
    headless: true
    browserChannels: [chrome, msedge, chromium]
    viewportWidth: 1280
    viewportHeight: 800
    navigationTimeoutMs: 15000
    actionTimeoutMs: 5000
    screenshotDir: .dsh-preview
    maxReadChars: 20000
    maxConsoleMessages: 100
    allowedHosts: []          # 允许 browser_open 访问的额外主机名
    registerSkill: true
```

## 安全模型

- `localhost` / `127.0.0.1` / `::1` 始终放行——前端验证只需要这些。
- 其他主机**默认拒绝**。需要时通过 `allowedHosts` 精确授权；错误信息会引导模型来问你，而不是绕过限制。
- 本地路径以只读方式、限定在其所在目录内、经临时 127.0.0.1 端口服务，带路径穿越防护。
- 插件不输入任何凭证；技能明确禁止截取含密钥或个人数据的页面。

## 已知限制

- 无头渲染与真实桌面浏览器有差异：指针锁定、部分 GPU 路径、系统对话框行为不同。内置技能会让 agent 在相关时主动说明。
- 暂无视觉描述：截图给人看，机器验证走 `browser_read`/`browser_console`。通过你现有 dsh 模型路由做"截图→文字描述"在路线图上。
- 每个 dsh 进程共享一个浏览器进程；页面开销很低，但并行 agent 共用它。

## 本地开发

```sh
git clone https://github.com/Viger1/dsh-preview.git && cd dsh-preview
corepack pnpm install
corepack pnpm run build
dsh plugin --profile web add /absolute/path/to/dsh-preview   # 链接本地目录
```

`corepack pnpm run watch` 加一次配置 touch 即可快速编辑-重载。

## 同系插件

| 插件 | 给 agent 的能力 |
| --- | --- |
| **dsh-preview**（本仓库） | 👁 眼睛——验证自己写的页面：打开、读取、截图、自检 |
| [dsh-pilot](https://github.com/Viger1/dsh-pilot) | ✋ 手——按无障碍 ref 操作任意页面，带网络层域名围栏 |

两者独立安装、可共存（工具前缀不同，工程规范一致）。

## 协议

[MIT](LICENSE)
