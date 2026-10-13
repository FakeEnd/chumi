# Chumi iPhone 原型

SwiftUI 原生客户端，最低 iOS 17。工程是 [Chumi.xcodeproj](Chumi.xcodeproj)，方案名称为 `Chumi`。

目前已有：本地录音和会议保存、Apple 端侧语音识别、文字和录音导出、与 Mac 加密配对、录音过程中手动同步已定稿文字、提问、回顾、总结，以及可选的 mybot 项目上下文。Codex / Claude 继续在 Mac 上运行，手机不保存它们的登录凭据。

**已使用 Xcode 26.6 和 iOS 26.5 SDK 完成模拟器编译，并在运行 iOS 26.5 的 iPhone 15 模拟器上验证了演示首页、会议详情和助手总结界面。服务端测试和原生核心逻辑检查也已通过。** 麦克风录音、端侧识别、Mac 网络配对与真机表现仍待验证。中英混合识别效果尚未实测，Zipformer 尚未接入；识别不可用时仍保存录音。

## 让我能继续调试

1. 在 Mac App Store 安装 **Xcode**；如果商店版本要求更新的 macOS，可从 [Apple 官方开发者下载页面](https://developer.apple.com/download/all/) 获取兼容版本。首次打开完成初始化，并安装 iOS 平台和一个 iPhone 模拟器运行环境。
2. 在仓库运行 `npm run ios:doctor` 检查环境。脚本优先使用你指定的 `DEVELOPER_DIR`，再依次查找 `/Applications/Xcode.app`、`~/Applications/Xcode.app`，最后用 Spotlight 查找放在其他位置（例如个人应用文件夹）的 Xcode；系统应用目录不可写时，可以安装到个人 Applications 文件夹。脚本不会修改全局 `xcode-select` 设置。模拟器构建可以用 `npm run ios:build`，不需要付费开发者会员或真机签名。
3. 真机调试时，用 USB 连接 iPhone 15，解锁并选择“信任这台电脑”，在 Xcode 的设备管理窗口完成配对。
4. 在 iPhone 的“设置 → 隐私与安全性 → 开发者模式”中开启开关，重启后确认。如果没有该选项，先与 Xcode 配对。
5. 自己在 Xcode 设置中登录 Apple Account；打开工程，在 `Signing & Capabilities` 选择自己的 Team，必要时修改为唯一的 Bundle Identifier。个人测试可使用 Personal Team，但受 Apple 免费签名限制。
6. 选择 iPhone 作为运行设备，首次启动时允许麦克风、语音识别和本地网络访问。

完成后，我可以通过这台 Mac 的终端继续编译、运行模拟器和使用 Apple 设备工具安装、检查日志。手机解锁、信任和系统授权弹窗仍需要你亲自操作。若 macOS 弹出开发者工具或自动化权限请求，按提示允许；通常不需要“完全磁盘访问权限”，也不需要把 Apple 账号密码发给我。

Apple 官方说明：[开启开发者模式](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)、[运行到模拟器或设备](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)。

## 连接 Mac

先在 Mac 版 Chumi 配置好 Codex / Claude 等 AI 提供方，再退出当前 Mac App / 服务，避免端口冲突。在仓库运行：

```bash
npm run mobile:setup
npm run start:mobile
```

第一条命令生成配对凭据，并显示一行私密的 JSON 配对码；第二条启动支持手机连接的服务。把整行配对码粘贴到 iPhone 的“连接 Mac”页面并验证连接。两台设备需要在可互相访问的网络中；macOS 若询问是否允许 Node 接收入站连接，需要允许。

默认使用 Mac 的 `.local` 地址。如果解析失败，可以改成 Mac 的局域网 IP：

```bash
npm run mobile:setup -- --rotate --address 192.168.1.20
```

随后重启服务并重新配对。配对码包含令牌和证书指纹，请勿公开。手机入口使用 HTTPS，默认端口 4778；原桌面接口仍限本机。这个版本适合个人局域网使用，不应直接暴露到公网。

## 当前限制

- 录音需要保持 App 在前台；切到后台、来电或切换音频设备会停止并保存。音频以未压缩 CAF 保存在“文件 → Chumi → Recordings”，单声道 48 kHz 约 11.5 MB/分钟。
- 同步需要手动操作，只发送已定稿的文字，原始音频留在手机。新增文字和录音结束后需要再次同步。
- AI 需要 Mac 在线。手机暂不提供远程执行代码、任务交接审批或云端中转。
- 可在 Xcode 的启动参数中添加 `--demo` 查看示例界面；演示模式不会录音或连接服务。Debug 构建还可以加 `--demo-screen detail`、`assistant`、`connection` 或 `new`，直接打开对应界面，方便模拟器截图。

## 界面与代码

- 界面与 Mac 端保持一致：相同的配色、卡片和会议类型圆点，“帮我跟上”可选最近 2 分钟、5 分钟或至今，AI 回答按 Markdown 显示，并支持浅色和深色模式。
- 配色定义在 `ios/Chumi/Design/Theme.swift`，与 `web/src/styles.css` 的 `:root` 变量一一对应；修改时请两边一起改。App 图标和应用内 Logo 由 `native/tools/make_icon.swift` 生成（iOS 图标加 `--full-bleed`）。
- 代码按 `Design`、`Models`、`Networking`、`Recording`、`Views` 分组。用 `npm run ios:format` 格式化 Swift 代码，`npm run ios:format -- --check` 只检查。

完整架构和验证说明见 [README.md](README.md)。
