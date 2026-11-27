ZONE MORTE + SUPABASE · PASSE 38

FICHIERS
- server.js : serveur Express/Socket.IO et connexion Supabase côté serveur
- public/index.html : jeu
- public/grenades.js : script des grenades
- online.js : fonctionnalités multijoueur
- supabase-setup.sql : table à créer dans Supabase
- .env.example : exemple sans clé secrète

1) SUPABASE
- Ouvre ton projet Supabase.
- Va dans SQL Editor > New query.
- Copie le contenu de supabase-setup.sql, puis clique Run.
- Dans Project Settings > API, récupère Project URL et la clé service_role/secret.

2) RENDER
Dans ton service Render > Environment, ajoute :
SUPABASE_URL = https://pqcfhikitdddsvjtoffe.supabase.co
SUPABASE_SERVICE_ROLE_KEY = ta clé secrète service_role (ne la partage jamais).
Puis sauvegarde et redéploie.

Ne place JAMAIS la clé service_role dans index.html, dans un fichier public, ou dans GitHub.

3) TEST
Après déploiement, ouvre le jeu, crée un compte de test, puis recharge la page et reconnecte-toi.
La progression sauvegardée via /api/user/data est conservée dans Supabase.
Le cookie de session est en mémoire côté serveur : après un redémarrage/déploiement,
les joueurs devront se reconnecter, mais leurs comptes et progression restent stockés.

STOCKAGE LOCAL DE SECOURS
Sans variables Supabase, le serveur utilise encore data/users.json en local.
Sur Render, ce stockage local n'est pas garanti sans disque persistant.
Les comptes existants dans un ancien users.json ne sont pas copiés automatiquement :
il faut effectuer une migration séparée avant de supprimer l'ancien disque.


PASSE 38 · MOTEUR 3D SOLO COMMUN
- Le bouton JOUER lance désormais le moteur WebGL pour tous les modes solo.
- Survie zombie : vagues d'infectés, boss, butin et cinématique d'insertion.
- Entraînement : cibles de tir, sans ennemis hostiles.
- Battle royale, escouade, duel et classé hors ligne : combattants hostiles contrôlés par l'IA,
  dégâts à distance, élimination de la menace et victoire de secteur.
- Les commandes clavier/tactiles, les armes et les skins d'opérateur restent accessibles.

LIMITES CONNUES DE CETTE PASSE
- Le multijoueur en ligne utilise encore l'ancien moteur 2D et son protocole réseau.
- Les modes 3D hors survie sont une première adaptation solo : les bots tirent à distance
  via une logique simplifiée, et ne reproduisent pas encore toutes les mécaniques BR historiques.
- La progression/récompense des parties 3D n'est pas encore reliée au système XP/résultats
  historique. Cette intégration reste une étape séparée à réaliser et tester.
