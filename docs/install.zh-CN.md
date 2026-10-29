# 安装 Chumi

[English](install.md) · **简体中文**

## 你需要

- 一台搭载 Apple Silicon（M1 或更新芯片）、运行 macOS 14.4 或更高版本的 Mac。Intel Mac 也可使用，但语音识别较慢。
- 约 3 GB 可用磁盘空间：语音模型约 0.9 GB，加上工具和应用本身。
- 用于回答问题的 AI 服务，任选其一：
  - **ChatGPT** 订阅（通过 Codex 使用）；
  - **Claude** Pro 或 Max 订阅（通过 Claude Code 使用）；
  - 免费的**本地模型**（通过 Ollama 或 LM Studio 使用），需要至少 16 GB 内存。

无需提前安装其他软件。安装程序会检查缺少的组件，并询问是否安装。

## 一条命令安装

打开**终端**，粘贴并运行：

```bash
curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | bash
```

这条命令会将 Chumi 下载到 `~/Chumi`，然后启动安装向导。安装新组件前都会征求你的同意。整个过程约需 5–15 分钟，大部分时间用于下载：

1. **检查这台 Mac。** 如果缺少 Xcode Command Line Tools、Homebrew 或 Node.js 24，会询问是否安装（安装 Homebrew 时需要输入 Mac 密码）。
2. **安装本地语音识别组件：** whisper.cpp 和适合这台 Mac 的语音模型。例如，内存为 16 GB 或以上的 Apple Silicon Mac 会使用 Large v3 Turbo（约 875 MB）。下载中断后，重新运行安装程序即可续传。
3. **在你的 Mac 上构建 Chumi.app** 及其音频组件。
4. **连接 AI 服务。** 选择 ChatGPT、Claude、本地模型，也可以稍后再设置。安装程序会按需安装官方命令行工具，并打开登录页面。账号和密码由官方工具保管，Chumi 不会读取。
5. **完成最后检查**，并询问是否立即打开 Chumi。

以后再运行同一条命令即可更新 Chumi，已完成的步骤会自动跳过。

### 想手动安装

```bash
git clone https://github.com/FakeEnd/chumi.git && cd chumi
```

```bash
bash scripts/setup.sh
```

| 选项 | 作用 |
|---|---|
| `--yes` | 自动采用默认选项（不会安装 Homebrew，也不会代你登录） |
| `--mirror` | 从 hf-mirror.com 下载语音模型（在中国大陆通常更快）；也可以用 `CHUMI_MODEL_BASE_URL` 指定其他镜像。每次下载都会核对官方文件的 SHA-256 |
| `--sample` | 同时生成一段用于测试的 20 分钟示例组会 |
| `--no-ai` | 跳过 AI 连接设置；之后可在“设置 → AI 服务”中选择 |

使用一条命令安装时，可按以下方式传入选项：`curl -fsSL …/install.sh | bash -s -- --mirror`。

## 第一次打开

运行 `open ~/Chumi/build/Chumi.app` 打开 Chumi，也可以将它从该文件夹拖到程序坞。首页会显示 **完成初始设置** 清单，直到所有设置完成：

- **在本机进行语音识别：** 安装完成后即可使用。
- **连接你已有的 AI：** 如果尚未连接，清单会显示需要运行的命令（例如 `codex login`）和 **重新检查** 按钮。
- **让 Chumi 了解你的知识背景：** 初次安装时，个人背景为空。花一分钟填写各领域的熟悉程度，Chumi 就能据此调整讲解深度。
- **允许使用麦克风：** 首次使用时，按 macOS 的提示授权。

然后点击 **⚡ 快速开始**，或在任意应用中按 **⌃⌥⌘L** 开始收听。

**macOS 可能请求的权限：**

| 权限 | 何时请求 | 用途 |
|---|---|---|
| 麦克风 | 第一次收听线下讨论时 | 采集现场声音 |
| 系统录音（System Audio Recording） | 第一次录制 Zoom、腾讯会议、Teams 或视频时 | 采集电脑声音 |
| 屏幕录制 | 只有在截取窗口（例如幻灯片）时 | 为每一页幻灯片保存一张截图 |
| 文件和文件夹 | 只有当 Chumi 放在“文稿”“桌面”或“下载”中时 | 允许 Chumi 启动自身组件 |

如果误拒了权限，请在 **系统设置 → 隐私与安全性** 中开启，再重启 Chumi。

## 手动连接 AI

- **ChatGPT 订阅：** 先运行一次 `brew install codex`，然后运行 `codex login`，选择 *Sign in with ChatGPT*。
- **Claude 订阅：** 先运行一次 `npm install -g @anthropic-ai/claude-code`，然后运行 `claude auth login`。
- **本地模型：** 安装 [Ollama](https://ollama.com)（`brew install ollama && brew services start ollama`）或 [LM Studio](https://lmstudio.ai)，然后在 Chumi 中打开 **设置 → AI 服务 → 其他模型：本地或 API**，选择对应服务，再点击 **下载推荐模型**。Chumi 会根据 Mac 的内存大小推荐合适的模型。

Chumi 不会自行切换到付费 API。付费 API 为可选功能，默认关闭。

## 检查安装

```bash
npm run doctor
```

在 Chumi 文件夹中运行上述命令。它会逐项检查 macOS、Node.js、whisper.cpp、语音模型、应用构建和 AI 登录，并针对缺少的部分给出具体的修复命令。麦克风权限会在你首次开始听记时由 Chumi 自行检查；终端无法判断应用的权限。

## 常见问题

| 问题 | 解决方法 |
|---|---|
| 刚装好 Homebrew 就提示 `brew: command not found` | 运行 Homebrew 安装结束后在“Next steps”中列出的两条命令，或新开一个终端窗口 |
| 语音模型下载缓慢或无法下载 | 运行 `bash scripts/setup.sh --mirror`，镜像设置会保留，应用内下载也会使用。下载失败后，首页会显示「重试」和「改用 hf-mirror.com 镜像下载」；重试会接着下载。可在 **设置 → 转写 → 下载来源** 中查看来源，并改回 Hugging Face |
| 在中国大陆安装 JavaScript 依赖（`npm ci`）很慢 | 运行 `bash scripts/setup.sh --mirror`，本次安装会使用 npmmirror，不会修改你的 npm 配置 |
| Homebrew 下载很慢 | 使用国内镜像，例如[中科大的 Homebrew 镜像说明](https://mirrors.ustc.edu.cn/help/brew.git.html) |
| 安装程序提示需要 Node.js 24，但已安装该版本 | nvm 等版本管理工具可能仍在使用旧版本。运行 `nvm install 24`，或将 Homebrew 的 Node 所在目录移到 PATH 的前面 |
| 首页的 AI 状态显示*未登录* | 运行 `codex login` 或 `claude auth login`，然后点击 **重新检查** |
| 始终没有转写内容 | 检查 **系统设置 → 隐私与安全性 → 麦克风**；录制电脑声音时，还需检查**系统录音**权限。可运行 `node scripts/check-audio.ts mic 6` 测试音频采集 |
| 更新后 macOS 再次请求权限 | Chumi 只在你的 Mac 上签名，重新构建的应用会被视为新应用。再次允许即可 |
| 其他问题 | 运行 `npm run doctor`，并在[提交问题](https://github.com/FakeEnd/chumi/issues)时附上输出 |

## 卸载

删除前，先导出需要保留的会议。在 **设置 → 编程智能体** 中，对每个已连接的智能体点击 **断开连接**（Claude Code、Codex、opencode、Qwen Code、Antigravity 和 DeepSeek Harness）。如果出现错误，先按提示处理，再删除应用；之后重启智能体，让它们停止使用旧的 MCP 配置。

如果在 Chumi 中保存过 API 密钥，请在 **设置 → AI 服务** 和 **设置 → 转写** 中点击 **删除密钥**。然后退出 Chumi，运行：

```bash
rm -rf ~/Chumi "$HOME/Library/Application Support/Chumi" "$HOME/Library/Logs/Chumi"
```

第二个路径下保存着会议记录和语音模型。如果没有其他程序使用 whisper.cpp，可运行 `brew uninstall whisper-cpp` 将其卸载。

如果已删除 Chumi，或断开连接未能完成，请先备份对应的智能体配置，再仅删除 Chumi 的条目：

| 智能体 | 清理方法 |
|---|---|
| Claude Code | `claude mcp remove chumi -s user` |
| Codex | `codex mcp remove chumi` |
| opencode | 从 `~/.config/opencode/opencode.json` 和／或 `opencode.jsonc` 中删除 `mcp.chumi`；设置了 `$XDG_CONFIG_HOME` 时，文件位于其下的 `opencode` 目录。Chumi 不会自动修改带注释的 JSONC 文件。 |
| Qwen Code | 运行 `qwen mcp remove --scope user chumi`，或从 `~/.qwen/settings.json` 中删除 `mcpServers.chumi`。 |
| Antigravity | 运行 `agy mcp remove chumi`，或从 `~/.gemini/config/mcp_config.json` 中删除 `mcpServers.chumi`。还需从 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow` 中仅删除 `mcp(chumi/chumi_connection_check)`。 |
| DeepSeek Harness | 删除 `$DSH_HOME/cordis.patch.yml`（默认为 `~/.dsh/cordis.patch.yml`）中从 `# >>> chumi` 到 `# <<< chumi` 的整段内容。 |

删除数据文件夹不会清除 macOS 钥匙串里的密钥。如果没有在应用内移除，请打开 **钥匙串访问**，删除服务名为 **Chumi Anthropic API key**、**Chumi compatible API key** 和 **Chumi speech API key** 的已保存条目。保留其他应用的凭据和智能体登录信息。
