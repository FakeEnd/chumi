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
                Text(String(localized: "Notes sync to your Mac as part of the transcript."))
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
            .navigationTitle(String(localized: "Add note"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Save"), action: onSave)
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
                    row(id: nil, name: String(localized: "No project"), systemImage: "minus.circle")
                }
                Section {
                    ForEach(projects) { project in
                        row(id: project.id, name: project.name, systemImage: "folder")
                    }
                    if projects.isEmpty {
                        Text(
                            String(
                                localized:
                                    "There are no projects on your Mac yet. Continue without one and create a project on your computer later."
                            )
                        )
                        .font(.footnote)
                        .foregroundStyle(ChumiTheme.muted)
                    }
                } header: {
                    Text(String(localized: "Projects on Mac"))
                } footer: {
                    Text(
                        String(
                            localized:
                                "Link a project to enable Project context when asking questions, using past Claude Code and Codex conversations from that project."
                        ))
                }
            }
            .scrollContentBackground(.hidden)
            .background(ChumiBackground())
            .navigationTitle(String(localized: "Link project"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Done")) { dismiss() }
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
