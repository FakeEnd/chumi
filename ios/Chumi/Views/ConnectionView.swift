import SwiftUI

/// Pairs the phone with the Mac companion, using the pairing code or the details typed by hand.
struct ConnectionView: View {
    @EnvironmentObject private var connection: ConnectionStore
    @Environment(\.dismiss) private var dismiss
    @State private var pairingCode = ""
    @State private var manual = false
    @State private var url = ""
    @State private var token = ""
    @State private var pin = ""
    @State private var busy = false
    @State private var error: String?
    @State private var task: Task<Void, Never>?

    private var canConnect: Bool {
        !busy && !connection.isDemo && (!pairingCode.isEmpty || (!url.isEmpty && !token.isEmpty))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    intro
                    if let saved = connection.credentials { pairedCard(saved) }
                    pairingCard
                    manualCard
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            HintRow(systemImage: "wifi", text: "首次连接时，请允许 iPhone 访问本地网络。手机与 Mac 先连接同一个 Wi-Fi。")
                            HintRow(
                                systemImage: "lock.shield",
                                text: "连接信息加密保存在 iPhone 钥匙串中。同步只发送会议文字；AI 请求可能由 Mac 转交给你配置的模型服务。")
                        }
                    }
                    if let error { Notice(message: error) }
                    actions
                }
                .padding(16)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(ChumiBackground())
            .navigationTitle("连接 Mac")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .onAppear {
                if let saved = connection.credentials {
                    url = saved.url
                    token = saved.token
                    pin = saved.certificateSHA256 ?? ""
                }
            }
            .onDisappear { task?.cancel() }
        }
    }

    // MARK: Sections

    private var intro: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .background(ChumiTheme.gradient, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
                .shadow(color: ChumiTheme.indigo.opacity(0.25), radius: 8, y: 4)
            Text("你的 Mac，随身可达。").font(.title2.weight(.bold)).foregroundStyle(ChumiTheme.text)
            Text("手机记录会议，Mac 使用已配置的 Codex 或 Claude 处理提问和总结。电脑需要保持开机并运行 Chumi。")
                .font(.subheadline)
                .foregroundStyle(ChumiTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
    }

    private func pairedCard(_ saved: PairingCredentials) -> some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                IconTile(systemName: "desktopcomputer", tint: ChumiTheme.ok)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Text("已配对").font(.subheadline.weight(.semibold)).foregroundStyle(ChumiTheme.text)
                        Badge(text: "可用", tone: .ok)
                    }
                    Text(saved.url)
                        .font(.footnote.monospaced())
                        .foregroundStyle(ChumiTheme.text)
                        .textSelection(.enabled)
                    Text(saved.certificateSHA256 == nil ? "使用系统信任的 HTTPS 证书" : "使用已配对的 Mac 证书指纹")
                        .font(.caption)
                        .foregroundStyle(ChumiTheme.muted)
                }
            }
        }
    }

    private var pairingCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                SectionTitle(title: "配对你的 Mac")
                VStack(alignment: .leading, spacing: 12) {
                    SetupStep(number: 1, title: "在 Mac 的 Chumi 项目目录运行", command: "npm run mobile:setup")
                    SetupStep(number: 2, title: "启动手机连接服务", command: "npm run start:mobile")
                    SetupStep(number: 3, title: "复制终端里的配对 JSON，粘贴到下方")
                }
                SecureField("粘贴 Mac 生成的配对码", text: $pairingCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .chumiField()
                    .accessibilityIdentifier("pairingCodeField")
                Text("配对码包含访问令牌，请只粘贴你自己的 Mac 生成的内容。")
                    .font(.caption)
                    .foregroundStyle(ChumiTheme.muted)
            }
        }
    }

    private var manualCard: some View {
        Card {
            DisclosureGroup(isExpanded: $manual) {
                VStack(spacing: 10) {
                    TextField("https://My-Mac.local:4778", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .chumiField()
                        .accessibilityIdentifier("serverURLField")
                    SecureField("访问令牌", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .chumiField()
                    TextField("证书 SHA-256 指纹（自签名证书必填）", text: $pin)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.caption.monospaced())
                        .chumiField()
                }
                .padding(.top, 12)
            } label: {
                Label("手动输入连接信息", systemImage: "keyboard")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ChumiTheme.text)
            }
        }
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button(action: connect) {
                HStack(spacing: 8) {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "正在验证…" : "验证连接并保存")
                }
            }
            .buttonStyle(.chumi(.primary, fullWidth: true))
            .disabled(!canConnect)
            .accessibilityIdentifier("verifyConnectionButton")
            if connection.credentials != nil {
                Button("断开配对", role: .destructive) {
                    do {
                        try connection.disconnect()
                        dismiss()
                    } catch {
                        self.error = error.localizedDescription
                    }
                }
                .buttonStyle(.chumi(.ghost, fullWidth: true))
                .disabled(busy || connection.isDemo)
            }
        }
    }

    // MARK: Pairing

    private func connect() {
        error = nil
        busy = true
        task = Task {
            defer { busy = false }
            do {
                let candidate: PairingCredentials
                if !pairingCode.isEmpty {
                    guard pairingCode.utf8.count <= 8192, let data = pairingCode.data(using: .utf8) else {
                        throw ConnectionError.invalidResponse
                    }
                    do {
                        candidate = try JSONDecoder().decode(PairingCredentials.self, from: data)
                    } catch {
                        throw ConnectionError.invalidToken
                    }
                } else {
                    candidate = .init(url: url, token: token, certificateSHA256: pin)
                }
                let credentials = try candidate.validated(allowSimulatorHTTP: ConnectionStore.allowsSimulatorHTTP)
                let client = try MobileAPI(credentials: credentials)
                let health = try await client.health()
                guard health.ok else { throw ConnectionError.invalidResponse }
                try Task.checkCancellation()
                try connection.save(credentials)
                dismiss()
            } catch is CancellationError {
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// A numbered setup step with an optional command (desktop `.setup-steps`).
private struct SetupStep: View {
    let number: Int
    let title: String
    var command: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(ChumiTheme.accent)
                .frame(width: 22, height: 22)
                .background(ChumiTheme.accentSoft, in: Circle())
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.subheadline).foregroundStyle(ChumiTheme.text)
                if let command {
                    Text(command)
                        .font(.footnote.monospaced())
                        .foregroundStyle(ChumiTheme.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(ChumiTheme.panelMuted, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(ChumiTheme.border))
                }
            }
        }
    }
}
