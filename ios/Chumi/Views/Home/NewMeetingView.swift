import SwiftUI

/// Names a new local meeting and picks its type.
struct NewMeetingView: View {
    @EnvironmentObject private var store: MeetingStore
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var type = "lab_meeting"
    @State private var error: String?
    @FocusState private var titleFocused: Bool
    let onCreated: (UUID) -> Void

    private var canCreate: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && title.utf16.count <= 200
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 8) {
                        fieldLabel("会议名称")
                        TextField("例如：本周组会", text: $title)
                            .focused($titleFocused)
                            .submitLabel(.done)
                            .onSubmit(create)
                            .chumiField()
                            .accessibilityIdentifier("meetingTitleField")
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        fieldLabel("会议类型")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                            ForEach(Meeting.types, id: \.id) { option in
                                typeChip(id: option.id, label: option.label)
                            }
                        }
                    }
                    HintRow(systemImage: "iphone", text: "会议先保存在手机上，稍后可以连接 Mac。")
                    if let error { Notice(message: error) }
                }
                .padding(16)
            }
            .background(ChumiBackground())
            .navigationTitle("新会议")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建", action: create)
                        .fontWeight(.semibold)
                        .disabled(!canCreate)
                        .accessibilityIdentifier("createMeetingButton")
                }
            }
            .onAppear { titleFocused = true }
        }
        .presentationDetents([.large])
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(ChumiTheme.muted)
    }

    private func typeChip(id: String, label: String) -> some View {
        let selected = type == id
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return Button {
            type = id
        } label: {
            HStack(spacing: 8) {
                TypeDot(type: id)
                Text(label)
                    .font(.subheadline.weight(selected ? .semibold : .regular))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
                if selected { Image(systemName: "checkmark").font(.caption.weight(.bold)) }
            }
            .foregroundStyle(selected ? ChumiTheme.accent : ChumiTheme.text)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .background(selected ? ChumiTheme.accentSoft : ChumiTheme.panel, in: shape)
            .overlay(
                shape.strokeBorder(selected ? ChumiTheme.accent : ChumiTheme.border, lineWidth: selected ? 1.5 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func create() {
        guard canCreate else { return }
        do {
            let id = try store.create(title: title, type: type)
            dismiss()
            onCreated(id)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
