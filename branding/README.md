Put the app icon sources here:
- icon.png  (1024x1024 PNG, used for Windows and iOS unless the two files below exist)
- icon-windows.png, icon-ios.png (optional overrides)
Then run: pnpm --dir frontend exec tauri icon ../branding/icon-windows.png  (generates frontend/src-tauri/icons/*)
and copy icon-ios.png to ios/Minuteman/Resources/Assets.xcassets/AppIcon.appiconset/Icon-1024.png
