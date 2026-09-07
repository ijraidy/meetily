import SwiftUI

struct ContentView: View {
    @AppStorage(SettingsKey.theme) private var themeRaw = AppTheme.dark.rawValue

    var body: some View {
        TabView {
            MeetingsListView()
                .tabItem { Label("Meetings", systemImage: "list.bullet.rectangle.portrait") }

            RecordView()
                .tabItem { Label("Record", systemImage: "mic.circle") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .preferredColorScheme((AppTheme(rawValue: themeRaw) ?? .dark).colorScheme)
    }
}
