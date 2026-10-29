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
                            HintRow(
                                systemImage: "wifi",
                                text: String(
                                    localized:
                                        "Allow Local Network access when connecting for the first time. Connect your iPhone and Mac to the same Wi-Fi."
                                ))
                            HintRow(
                                systemImage: "lock.shield",
                                text: String(
                                    localized:
                                        "Connection details are encrypted in iPhone Keychain. Sync sends only the transcript. Your Mac may send AI requests to your configured model provider."
                                ))
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
            .navigationTitle(String(localized: "Connect Mac"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done")) { dismiss() }
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
            Text(String(localized: "Your Mac, within reach.")).font(.title2.weight(.bold)).foregroundStyle(
                ChumiTheme.text)
            Text(
                String(
                    localized:
                        "Record meetings on your phone. Your Mac uses its configured Codex or Claude to answer questions and summarize. Keep your Mac awake with Chumi running."
                )
            )
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
                        Text(String(localized: "Paired")).font(.subheadline.weight(.semibold)).foregroundStyle(
                            ChumiTheme.text)
                        Badge(text: String(localized: "Available"), tone: .ok)
                    }
                    Text(saved.url)
                        .font(.footnote.monospaced())
                        .foregroundStyle(ChumiTheme.text)
                        .textSelection(.enabled)
                    Text(
                        saved.certificateSHA256 == nil
                            ? String(localized: "Using a system-trusted HTTPS certificate")
                            : String(localized: "Using your paired Mac certificate fingerprint")
                    )
                    .font(.caption)
                    .foregroundStyle(ChumiTheme.muted)
                }
            }
        }
    }

    private var pairingCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 14) {
                SectionTitle(title: String(localized: "Pair your Mac"))
                VStack(alignment: .leading, spacing: 12) {
                    SetupStep(
                        number: 1, title: String(localized: "Run in the Chumi project directory on your Mac"),
                        command: "npm run mobile:setup")
                    SetupStep(
                        number: 2, title: String(localized: "Start the mobile companion service"),
                        command: "npm run start:mobile")
                    SetupStep(
                        number: 3, title: String(localized: "Copy the pairing JSON from Terminal and paste it below"))
                }
                SecureField(String(localized: "Paste the pairing code from your Mac"), text: $pairingCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .chumiField()
                    .accessibilityIdentifier("pairingCodeField")
                Text(
                    String(localized: "The pairing code contains an access token. Only paste a code from your own Mac.")
                )
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
                    SecureField(String(localized: "Access token"), text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .chumiField()
                    TextField(
                        String(localized: "Certificate SHA-256 fingerprint (required for self-signed certificates)"),
                        text: $pin
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.caption.monospaced())
                    .chumiField()
                }
                .padding(.top, 12)
            } label: {
                Label(String(localized: "Enter connection details manually"), systemImage: "keyboard")
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
                    Text(busy ? String(localized: "Verifying…") : String(localized: "Verify and save"))
                }
            }
            .buttonStyle(.chumi(.primary, fullWidth: true))
            .disabled(!canConnect)
            .accessibilityIdentifier("verifyConnectionButton")
            if connection.credentials != nil {
                Button(String(localized: "Unpair"), role: .destructive) {
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
