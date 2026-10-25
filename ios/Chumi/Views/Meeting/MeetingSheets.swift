import SwiftUI

/// Adds a typed note to the transcript. The draft lives with the meeting, so cancelling keeps it.
struct NoteSheet: View {
    @Binding var note: String
    let canSave: Bool
    let onSave: () -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var isValid: Bool {
        !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && note.utf16.count <= 15_990
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text("文字笔记会作为会议记录同步到 Mac。")
                    .font(.footnote)
                    .foregroundStyle(ChumiTheme.muted)
                TextEditor(text: $note)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 180)
                    .padding(6)
                    .background(ChumiTheme.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(ChumiTheme.border))
                    .accessibilityIdentifier("noteTextField")
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(ChumiBackground())
            .navigationTitle("添加笔记")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", action: onSave)
                        .fontWeight(.semibold)
                        .disabled(!isValid || !canSave)
                }
            }
            .onAppear { focused = true }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Assigns the meeting to one of the Mac's projects, or to none.
struct ProjectPickerSheet: View {
    let projects: [MobileProject]
    let selectedId: String?
    let onSelect: (String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(id: nil, name: "不关联项目", systemImage: "minus.circle")
                }
                Section {
                    ForEach(projects) { project in
                        row(id: project.id, name: project.name, systemImage: "folder")
                    }
                    if projects.isEmpty {
                        Text("Mac 上还没有项目。可以先不关联，稍后在电脑端创建。")
                            .font(.footnote)
                            .foregroundStyle(ChumiTheme.muted)
                    }
                } header: {
                    Text("Mac 上的项目")
                } footer: {
                    Text("关联项目后，提问时可以打开“项目上下文”，参考这个项目以往的 Claude Code 和 Codex 会话。")
                }
            }
            .scrollContentBackground(.hidden)
            .background(ChumiBackground())
            .navigationTitle("关联项目")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private func row(id: String?, name: String, systemImage: String) -> some View {
        Button {
            onSelect(id)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: systemImage).foregroundStyle(ChumiTheme.accent).frame(width: 22)
                Text(name).foregroundStyle(ChumiTheme.text)
                Spacer()
                if selectedId == id {
                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(ChumiTheme.accent)
                }
            }
        }
        .listRowBackground(ChumiTheme.panel)
    }
}
