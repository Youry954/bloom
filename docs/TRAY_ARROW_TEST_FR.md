# Test séparé du correctif de la flèche ↑

Branches de test : `fix-tray-chevron-fallback` (PR #6) et `test/bloom-3-tray-arrow-fix` (PR #5), issues de `bloom-3-recherche-tray-chatgpt` (`0d639a2`).

## Diagnostic

1. **Pourquoi `get_tray_apps` retournait une liste vide (`[]`)** :
   - `tray::enumerate()` → `live_icons()` lit la clé de registre `HKCU\Control Panel\NotifyIconSettings`.
   - Sur Windows 11 21H2 (Build 22000, comme le PC de test en `22000.2538`) ainsi que sur Windows 10, la clé `NotifyIconSettings` n’existe pas (elle a été introduite avec la réécriture XAML de la zone de notification dans Windows 11 22H2 Build 22621).
   - De plus, `Shell_NotifyIconGetRect` échoue (`E_FAIL`) pour les icônes masquées tant que le panneau d’overflow est caché sur Build 22000.

2. **Pourquoi `fix-tray-chevron-fallback` (`389a24e`) ouvrait « Paramètres rapides »** :
   - Sur `fix-tray-chevron-fallback`, lorsque `get_tray_apps` retournait `[]`, `Dock.tsx` appelait `invoke("open_system_tray")`.
   - Dans `src-tauri/src/commands.rs`, `open_system_tray()` envoyait la séquence clavier `Win+B` suivie de `Espace` (`VK_SPACE`) via `SendInput`.
   - Sur Windows 11, `Win+B` suivi de `Espace` active le bouton groupé réseau/son/batterie de la barre des tâches et ouvre le panneau Windows **« Paramètres rapides »** (Wi-Fi, Bluetooth, VPN, mode avion, luminosité, volume) au lieu des icônes cachées.

## Correctif appliqué

1. **Suppression définitive du raccourci `Win+B` + `Espace`** :
   - `open_system_tray()` dans `src-tauri/src/commands.rs` n’envoie plus jamais `Win+B` ni `VK_SPACE` ; il délègue à `crate::tray::show_legacy_overflow()`.
   - `Dock.tsx` interroge `uses_legacy_tray_overflow` et appelle `show_legacy_tray_overflow` lorsque `NotifyIconSettings` est absent ou que `enumerate()` est vide alors que `NotifyIconOverflowWindow` contient des icônes.

2. **Ouverture et dimensionnement complet de `NotifyIconOverflowWindow` (`src-tauri/src/tray.rs`)** :
   - Affiche directement la vraie fenêtre Windows des icônes cachées (`NotifyIconOverflowWindow` et son `ToolbarWindow32`) juste au-dessus de la flèche ↑ du dock.
   - Interroge `TB_GETBUTTONSIZE` (`WM_USER + 58`) et `TB_GETROWS` (`WM_USER + 40`) pour ajuster la hauteur de `ToolbarWindow32` et `NotifyIconOverflowWindow` à toutes les lignes d’icônes (ex. grille 3×4 en `180×240` px à 150 % DPI au lieu de rester tronquée à `180×180` px).
   - Maintient le panneau ouvert pendant l’utilisation d’un menu contextuel natif (`#32768`, clic droit sur une icône) et attend le relâchement du bouton de souris à la fermeture afin d’éviter toute réouverture involontaire.
   - Restaure intégralement la taille, la position, l’état `TOPMOST` et la visibilité d’origine via `Drop`.

## Télécharger et essayer

1. Dans GitHub > `Youry954/bloom` > Actions, ouvrir la dernière exécution réussie de **« Build Bloom Preview (Windows) »**.
2. Télécharger l’artefact **`Bloom-3-Preview-Windows`**, puis extraire son ZIP dans un dossier de test.
3. Quitter toute instance de Bloom en cours d’exécution avant de lancer le nouvel exécutable `bloom.exe`.
4. Cliquer sur la flèche **↑** du dock : le panneau des icônes cachées (Sécurité Windows, Bluetooth, Audio, ChatGPT, Chrome, Gemini, Bloom, Antigravity, etc.) doit s’ouvrir au-dessus du dock, **sans jamais ouvrir « Paramètres rapides »**.
5. Tester le clic gauche et le clic droit (menus contextuels natifs) sur les icônes, ainsi que la fermeture par clic extérieur ou touche `Échap`.
