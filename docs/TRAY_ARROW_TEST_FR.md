# Test séparé du correctif de la flèche ↑

Branche : `test/bloom-3-tray-arrow-fix`, issue de
`bloom-3-recherche-tray-chatgpt` au commit `0d639a2`.

## Diagnostic

Le clic React ouvrait correctement le panneau. `get_tray_apps` appelait
`tray::enumerate`, dont `live_icons` retournait une liste vide quand la clé
`HKCU\Control Panel\NotifyIconSettings` était absente. L’interface affichait
alors « Aucune icône de notification détectée » sans distinguer incompatibilité
et absence réelle d’icônes. Le précédent correctif du hit-testing ne pouvait
donc pas résoudre ce défaut de découverte.

Vérification en lecture seule sur le PC de test : Windows 11 build 22000,
clé absente, fenêtre `NotifyIconOverflowWindow` présente et 16 boutons dans
son `ToolbarWindow32`. Les détails internes d’Explorer peuvent varier selon
les versions ; la compilation seule ne valide pas leur comportement réel.

## Correctif

La flèche vérifie la disponibilité du catalogue. S’il manque, elle ouvre le
panneau classique d’Explorer au-dessus du pointeur : icônes réelles, clics et
menus contextuels gérés par Windows. Sur les versions possédant le catalogue,
le panneau Bloom reste utilisé. Les doubles ouvertures sont bloquées et les
erreurs sont affichées. Les autres usages de `get_tray_apps` restent inchangés.

Le chemin classique ne déplace ni n’affiche la barre des tâches, ne modifie
pas les AppBars, ne lit pas la mémoire d’Explorer et ne change pas les
préférences d’icônes. Un garde restaure la position et le niveau du panneau
à la sortie, y compris sur erreur. Fermeture extérieure, Échap, désactivation
du dock et arrêt de Bloom sont pris en compte ; délai maximal de 60 secondes.

Les icônes de ChatGPT/WhatsApp, la recherche, le notch et la détection fullscreen
ne sont pas modifiés. Aucun tag, installateur, publication ni fusion.

## Télécharger et essayer

1. Dans GitHub > Youry954/bloom > Actions, ouvrir la dernière exécution réussie
   de « Build Bloom Preview (Windows) » pour cette branche.
2. En bas, télécharger l’artefact `Bloom-3-Tray-Fix-Windows-…`, puis extraire
   son ZIP dans un **nouveau dossier**. Conserver l’ancien `bloom.exe`.
3. Quitter Bloom avec son option Quitter. Ne pas lancer les deux copies en même temps.
4. Lancer le `bloom.exe` extrait. Il ne s’agit pas d’un installateur ; ne pas
   remplacer le fichier actuellement utilisé au démarrage. Les deux copies
   utilisent les mêmes réglages Bloom : éviter de les modifier pendant ce test.
5. Cliquer sur ↑ : sur Windows 11 build 22000, le panneau **Windows** des icônes
   masquées doit apparaître au-dessus du dock. Son apparence diffère du panneau Bloom.
6. Ouvrir une application depuis une icône, puis rouvrir ↑ et faire un clic droit
   sur une icône. Vérifier que le menu appartient à la bonne application.
   L’option Quitter dépend de l’application et n’est à utiliser que si souhaité.
7. Vérifier la fermeture par clic extérieur et Échap ; rouvrir plusieurs fois.
   Tester aussi les bords d’écran et un deuxième écran si disponible.
8. Vérifier Recherche, les icônes sans halo, les animations, le notch/dock avec
   ChatGPT maximisé, puis le comportement habituel en véritable plein écran.
9. Quitter cette copie et relancer l’ancien exécutable pour revenir à la version actuelle.

Les processus sans icône de notification ne figurent pas dans ce panneau.
Les icônes déjà épinglées dans la zone Windows ne sont pas des icônes masquées.

## Validation automatisée

Le workflow lance la compilation TypeScript/Vite, les tests Bun existants,
`cargo check --locked`, `cargo clippy --locked --all-targets`,
`cargo test --locked`, puis la compilation Tauri sans installateur.
Des tests Rust couvrent le placement aux bords d’écran, les coordonnées
négatives, les petits écrans et les dimensions physiques agrandies.
Un ancien test du notch attendait encore une réservation supérieure alors que
la branche source l’avait supprimée dans tous les modes. Seules ses assertions
ont été actualisées pour protéger le comportement actuel, sans changer le notch.
La validation visuelle et les menus réels restent à confirmer sur le PC utilisateur.
