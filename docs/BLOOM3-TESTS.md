# Bloom 3.0 — Windows preview checklist

This is an experimental test build. It deliberately leaves the working Bloom build and the default `main` branch untouched.

## What's in this build
- Clean transparent vector defaults for **ChatGPT** and **WhatsApp**, bypassing the opaque plates baked into some Microsoft Store icons.
- A special case for **maximized ChatGPT.exe** windows that are frameless but are not exclusive fullscreen games.
- A **compact Recherche button** inside the existing dock that sends the native **Win+S** shortcut.
- A **chevron** with live Windows notification-tray entries, native activation / context menus (via the existing tray UI Automation integration) and Task Manager.

## Test sequence on Windows
1. Back up Bloom settings; keep the previous executable safe in another folder.
2. Fully quit Bloom. Do **not** overwrite the working executable.
3. Scan the new executable with Microsoft Defender before opening.
4. Launch the new executable from a distinct folder, with no other Bloom process active.
5. Keep **Notch: Fixed** and **Dock: Fixed**.
6. Maximize ChatGPT; verify that the notch and dock remain visible. Restore ChatGPT and repeat; verify their animations still work.
7. Maximize Chrome and test another desktop app to ensure the previous zero-reserved-band behavior is unchanged.
8. Open a true fullscreen game/video; verify Bloom still steps aside in real fullscreen.
9. Click **Recherche** and type into the *native Windows Search* experience; confirm the pill is not itself a text field.
10. Click **⌃** in the dock. The panel should list applications that **expose Windows notification icons**, not every background process. Left-click a row to activate its tray icon; click **···** to open the application's native menu, where **Exit / Quit** is available only if the app offers it. Open Task Manager for other processes.
11. Open **Add App to Dock** and test typing, selecting apps and closing, with no click-through or unexpected dismissal.
12. Verify the new frameless ChatGPT/WhatsApp vectors. Note: these two built-in clean icons intentionally take priority over previously cached/custom Windows icons in this prototype.
13. Verify no duplicates are introduced into the dock and that standard window-focus/preview interactions still work.
14. On any issue: quit the preview and restart the previous Bloom executable.

## Icon provenance
- `public/brand-clean-chatgpt.svg`: transparent OpenAI mark sourced from the public Lobe Icons collection.
- `public/brand-clean-whatsapp.svg`: transparent WhatsApp mark sourced from Simple Icons (CC0).
Brand names and marks belong to their owners; files are included solely for local application identification and not as an endorsement.

## Known limitations
- This change does not terminate processes automatically.
- Some Windows tray icons (notably system shell controls) may not be exposed through the current discovery API.
- The ChatGPT maximization exception is intentionally scoped to `ChatGPT.exe`; not a blanket exemption for other frameless fullscreen apps.
- Native Windows and per-monitor focus behavior must be tested on the user's machine before merging this branch.
