# 安装 Chumi

[English](install.md) · **简体中文**

## 你需要

- 一台 Apple Silicon（M1 及以后）的 Mac，macOS 14.4 或更高版本。Intel Mac 也能用，但语音识别会慢一些。
- 约 3 GB 可用磁盘空间：语音模型约 0.9 GB，加上工具和应用本身。
- 一个用来回答问题的 AI，任选其一：
  - **ChatGPT** 订阅（通过 Codex 使用）；
  - **Claude** Pro 或 Max 订阅（通过 Claude Code 使用）；
  - 免费的**本地模型**（Ollama 或 LM Studio），需要 16 GB 或以上内存。

不需要事先安装别的东西，缺什么，安装程序会问你要不要装。

## 一条命令安装

打开**终端**，粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/FakeEnd/chumi/main/scripts/install.sh | bash
```

它会把 Chumi 下载到 `~/Chumi`，然后运行引导式安装。安装任何新东西之前都会先问你。整个过程约 5–15 分钟，主要是下载：

1. **检查这台 Mac。** 如果缺少 Xcode Command Line Tools、Homebrew 或 Node.js 24，会提出帮你安装（安装 Homebrew 时需要输入 Mac 密码）。
2. **安装本地语音识别：** whisper.cpp，以及适合这台 Mac 的语音模型（例如 16 GB 及以上内存的 Apple Silicon 用 Large v3 Turbo，约 875 MB）。下载中断后，再运行一次安装即可续传。
3. **在你的 Mac 上构建 Chumi.app** 及其音频组件。
4. **帮你连接 AI。** 选择 ChatGPT、Claude、本地模型或稍后再说。需要时它会安装官方命令行工具并打开登录页面。账号和密码只留在官方工具里，Chumi 看不到。
5. **最后检查一遍**，并询问是否立即打开 Chumi。

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
| `--yes` | 不提问，全部使用默认选择（不会替你安装 Homebrew，也不会替你登录） |
| `--mirror` | 从 hf-mirror.com 下载语音模型（在中国大陆通常更快）；也可以用 `CHUMI_MODEL_BASE_URL` 指定其他镜像。每次下载都会核对官方文件的 SHA-256 |
| `--sample` | 同时生成测试用的 20 分钟示例组会 |
| `--no-ai` | 跳过连接 AI 这一步；之后可以在 设置 → AI 服务 中选择 |

使用一条命令安装时，这样传入选项：`curl -fsSL …/install.sh | bash -s -- --mirror`。

## 第一次打开

用 `open ~/Chumi/build/Chumi.app` 打开 Chumi，也可以把它从这个文件夹拖到程序坞。首页会显示 **准备好 Chumi** 清单，直到全部设置完成：

- **在本机进行语音识别：** 安装完成后就已就绪。
- **连接你已有的 AI：** 如果还没连接，清单会显示要运行的命令（例如 `codex login`），以及 **重新检查** 按钮。
- **告诉 Chumi 你的背景：** 解释会按你在各个领域已经掌握的程度来调整。新安装的档案是空的，花一分钟填写很值得。
- **允许使用麦克风：** macOS 只会询问一次。

然后点 **⚡ 快速开始**，或者在任何应用里按 **⌃⌥⌘L** 开始收听。

**macOS 可能请求的权限：**

| 权限 | 什么时候 | 用途 |
|---|---|---|
| 麦克风 | 第一次收听线下讨论时 | 听到现场的声音 |
| 系统录音（System Audio Recording） | 第一次录制 Zoom、腾讯会议、Teams 或视频时 | 听到电脑播放的声音 |
| 屏幕录制 | 只有在截取窗口（例如幻灯片）时 | 为每一页幻灯片保存一张截图 |
| 文件和文件夹 | 只有当 Chumi 放在“文稿”“桌面”或“下载”中时 | 让 Chumi 自己的组件能够启动 |

如果不小心拒绝了，到 **系统设置 → 隐私与安全性** 中打开，然后重启 Chumi。

## 手动连接 AI

- **ChatGPT 订阅：** 先运行一次 `brew install codex`，然后运行 `codex login`，选择 *Sign in with ChatGPT*。
- **Claude 订阅：** 先运行一次 `npm install -g @anthropic-ai/claude-code`，然后运行 `claude auth login`。
- **本地模型：** 安装 [Ollama](https://ollama.com)（`brew install ollama && brew services start ollama`）或 [LM Studio](https://lmstudio.ai)，然后在 Chumi 中打开 **设置 → AI 服务 → 其他模型：本地或 API**，选择它，点 **下载推荐模型**。Chumi 会按你的 Mac 内存推荐合适的模型。

Chumi 绝不会自己切换到付费 API。付费 API 密钥是可选项，默认关闭。

## 检查安装

```bash
npm run doctor
```

在 Chumi 文件夹中运行。它会逐项检查（macOS、Node.js、whisper.cpp、语音模型、应用构建、AI 登录、麦克风），对缺少的部分给出具体的修复命令，不会做任何修改。

## 常见问题

| 你看到的情况 | 怎么办 |
|---|---|
| 刚装好 Homebrew 就提示 `brew: command not found` | 运行 Homebrew 最后打印的两条 “Next steps” 命令，或者新开一个终端窗口 |
| 语音模型下载很慢或下载不了 | 运行 `bash scripts/setup.sh --mirror`。在 Chumi 里下载其他模型时，可以用 `CHUMI_MODEL_BASE_URL=https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main npm start` 启动 |
| 在中国大陆安装 JavaScript 依赖（`npm ci`）很慢 | 运行 `npm config set registry https://registry.npmmirror.com`，然后重新运行安装 |
| Homebrew 下载很慢 | 使用国内镜像，例如[中科大的 Homebrew 镜像说明](https://mirrors.ustc.edu.cn/help/brew.git.html) |
| 安装提示需要 Node.js 24，但你已经装了 | 可能是 nvm 等版本管理工具选了旧版本。运行 `nvm install 24`，或把 Homebrew 的 Node 放在 PATH 前面 |
| 首页的 AI 状态显示*未登录* | 运行 `codex login` 或 `claude auth login`，然后点 **重新检查** |
| 转写一直是空的 | 检查 **系统设置 → 隐私与安全性 → 麦克风**（录电脑声音时还有**系统录音**）。可以运行 `node scripts/check-audio.ts mic 6` 测试采集 |
| 更新后 macOS 又请求权限 | Chumi 只在你的 Mac 上签名，重新构建的应用会被当成新应用。再允许一次即可 |
| 其他问题 | 运行 `npm run doctor`，把输出附在 [issue](https://github.com/FakeEnd/chumi/issues) 里 |

## 卸载

先退出 Chumi，然后运行：

```bash
rm -rf ~/Chumi "$HOME/Library/Application Support/Chumi" "$HOME/Library/Logs/Chumi"
```

第二个路径里保存着你的会议记录和语音模型，删除前请先导出需要保留的内容。如果连接过编程智能体，再运行 `claude mcp remove chumi` 和 `codex mcp remove chumi`。如果其他程序不用 whisper.cpp，可以用 `brew uninstall whisper-cpp` 删除它。
