// ShellMenuLocalization.swift — retitles the shell's items without replacing AppKit's window list.

import AppKit

@MainActor
final class ShellMenuLocalization {
    private var menus: [(NSMenu, String)] = []
    private var items: [(NSMenuItem, String)] = []

    /// Capture the English titles once, before AppKit adds dynamic window and service items.
    init(_ menu: NSMenu) { capture(menu) }

    private func capture(_ menu: NSMenu) {
        menus.append((menu, menu.title))
        for item in menu.items where !item.isSeparatorItem {
            items.append((item, item.submenu?.title ?? item.title))
            if let submenu = item.submenu { capture(submenu) }
        }
    }

    func retitle() {
        for (menu, title) in menus { menu.title = L(title) }
        for (item, title) in items { item.title = L(title) }
    }
}
