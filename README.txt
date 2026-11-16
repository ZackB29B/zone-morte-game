ZONE MORTE - DEPLOIEMENT RENDER

Structure attendue :
- server.js
- package.json
- public/index.html

Render (Web Service) :
- Runtime : Node
- Build Command : npm install
- Start Command : npm start
- Instance port : laisser Render gérer PORT automatiquement

Le client utilise automatiquement le même domaine que le serveur pour Socket.IO.
Le endpoint de contrôle est /health.

Multijoueur :
1. Ouvrir la même URL Render sur plusieurs appareils/navigateurs.
2. Saisir le même code de salon (ex. BASTION-9), avec un pseudo différent.
3. Cliquer sur « Rejoindre le salon ».
4. Choisir Mobile ou PC pour démarrer.

Limite de cette première intégration : les positions et combats entre joueurs réels sont relayés par le serveur. Les bots, la zone, les objets et les bâtiments restent encore simulés côté navigateur ; ils ne constituent pas encore un état de partie entièrement autoritaire partagé. Cette version est une base multijoueur à tester, pas encore une version compétitive anti-triche.
