import type { today as en } from '../en/today.ts'
import type { Shape } from '../index.ts'

export const today = {
  title: 'Aujourd’hui',
  greeting: 'Content de vous revoir',
  due: { one: '{count} carte à revoir', other: '{count} cartes à revoir' },
  newCards: { one: '{count} nouvelle carte', other: '{count} nouvelles cartes' },
  start: 'Commencer la révision',
  allDone: 'Tout est fait pour aujourd’hui. À demain !',
  courses: 'Cours',
  addCourse: 'Nouveau cours',
  fromFiles: 'À partir de fichiers…',
  fromFilesNameHint: 'Repris de votre premier fichier. Vous pouvez le modifier.',
  filesChosen: { one: '{count} fichier : {names}', other: '{count} fichiers : {names}' },
  importingFiles: 'Lecture de vos fichiers…',
  openNewCourse: 'Ouvrir le cours',
  noCourses: 'Aucun cours pour l’instant. Créez-en un pour commencer.',
  streak: { one: '{count} jour d’affilée', other: '{count} jours d’affilée' },
  examIn: { one: 'Examen dans {count} jour', other: 'Examen dans {count} jours' },
  examCountdown: { one: 'Encore {count} jour', other: 'Encore {count} jours' },
  examToday: 'Examen aujourd’hui',
  setupLink: 'Première fois ? Configurer Cursus',
  installTitle: 'Installez Cursus d’abord',
  installed: 'Cursus tourne en app installée.',
  installBody:
    'Ajoutez Cursus à l’écran d’accueil ou au Dock avant de commencer. Sur iPhone et iPad, un onglet Safari et l’app installée gardent chacun leur propre copie de votre bibliothèque.',
  safariTabTitle: 'Vous êtes dans un onglet Safari.',
  safariTabBody:
    'Ce que vous ajoutez ici reste dans cet onglet, pas dans l’app installée. Installez d’abord : Partager, puis Sur l’écran d’accueil (ou Ajouter au Dock sur Mac).',
  storageTitle: 'Stockage sur cet appareil',
  storageKept: 'Conservé si l’espace manque',
  storagePersisted: 'Oui, persistant',
  storageBestEffort: 'Au mieux',
  storageUsed: 'Espace utilisé',
  storageUnknown: 'Non indiqué par ce navigateur',
  storageUsage: '{used} sur {quota} ({percent})',
  storageHint:
    'Sans stockage persistant, le navigateur peut effacer votre bibliothèque quand l’espace manque. Ajoutez aussi une sauvegarde de sync.',
  storageAsk: 'Demander à garder mes données',
  demoTitle: 'Essayer avec un cours de démo',
  demoBody:
    'Ajoute un cours de biologie cellulaire avec des chapitres, des notes, des diapositives, un protocole de TP, des PDF, des photos, des fiches, deux semaines de révisions et des séances planifiées\u00a0: vous voyez tout ce que fait Cursus avant d’ajouter vos propres cours. Vous pouvez le supprimer à tout moment.',
  demoAction: 'Essayer un cours de démo',
  demoCourse: 'Démo\u00a0: biologie cellulaire',
  heroDue: { one: '{count} carte à revoir aujourd’hui', other: '{count} cartes à revoir aujourd’hui' },
  examLead: 'dont {count} en {course} · {when}',
  caughtUp: 'Tout est à jour',
  laterTitle: {
    one: '{count} carte revient dans {interval}',
    other: '{count} cartes reviennent, la première dans {interval}',
  },
  laterBody: 'En cours d’apprentissage : elles reviennent plus tard aujourd’hui.',
  startKey: 'S',
  plannedTitle: 'Prévu aujourd’hui : {name}',
  courseDue: { one: '{count} à revoir', other: '{count} à revoir' },
  backupLine: 'Pas encore de sauvegarde',
  backupAction: 'Ajouter une sauvegarde',
  installHintLabel: 'Installer Cursus',
  installHintTitle: 'Vous êtes dans un onglet Safari.',
  installHintBody:
    'Ce que vous ajoutez ici reste dans cet onglet ; l’app installée démarre vide. Installez d’abord : Partager, puis Sur l’écran d’accueil.',
  installHintDismiss: 'Plus tard',
  // --- S-044 ---
  draftsLine: {
    one: '{count} carte suggérée depuis {course}',
    other: '{count} cartes suggérées depuis {course}',
  },
  draftsLineCourses: {
    one: '{count} carte suggérée depuis {courses} cours',
    other: '{count} cartes suggérées depuis {courses} cours',
  },
  draftsReview: 'Accepter ou modifier',
  draftsHeroBody: 'Acceptez les bonnes : elles rejoignent vos révisions.',
  // --- fin S-044 ---
  unreadableReviewsTitle: 'Une partie de l’historique est illisible.',
  unreadableReviews: {
    one: '{count} révision de votre historique est abîmée ou vient d’une version plus récente de Cursus. Elle est conservée telle quelle, mais laissée hors de votre planning et de vos statistiques tant que Cursus ne peut pas la lire. Mettre Cursus à jour peut régler le problème.',
    other:
      '{count} révisions de votre historique sont abîmées ou viennent d’une version plus récente de Cursus. Elles sont conservées telles quelles, mais laissées hors de votre planning et de vos statistiques tant que Cursus ne peut pas les lire. Mettre Cursus à jour peut régler le problème.',
  },
  unreadableReviewsDetails: 'Rapport de diagnostic',
  // --- Demo course: every feature, written when the student asks for it ---
  obLoopTitle: 'Comment fonctionne Cursus',
  obLoop1Title: 'Ajoutez ce que vous étudiez',
  obLoop1Body: 'Dans un cours, touchez « {add} » : une note, un PDF, des diapositives ou des photos.',
  obLoop2Title: 'Transformez-le en cartes',
  obLoop2Body:
    'Touchez « {generate} » pour que l’IA les propose à partir de vos sources, ou « {newCard} » pour en écrire une.',
  obLoop2BodyNoAi: 'Touchez « {newCard} » pour en écrire une : une question au recto, la réponse au verso.',
  obLoop3Title: 'Révisez quelques minutes par jour',
  obLoop3Body: 'Dans {today}, touchez « {start} ». Chaque carte revient juste avant que vous ne l’oubliiez.',
  obDataBody:
    'Tout reste sur cet appareil, sans compte. Ajoutez une sauvegarde dans Réglages › Sync pour en garder une copie ailleurs.',
  obAiTitle: 'L’IA, seulement si vous le souhaitez',
  obAiBody:
    'Des explications, des cartes suggérées et une discussion sur vos sources. Cursus fonctionne entièrement sans.',
  obAiLocal: 'Sur cet appareil (gratuit, hors ligne)',
  obAiKey: 'Avec ma propre clé',
  obAiLater: 'Ou plus tard : Réglages › IA, à tout moment.',
  obCreate: 'Créer mon premier cours',
  obSkip: 'Aller à Aujourd’hui',
  demoFailed: 'Le cours de démo n’a pas pu être ajouté. Rien n’a été modifié\u00a0; réessayez.',
  demoSecMembranes: 'Membranes',
  demoSecStructure: 'Structure',
  demoSecTransport: 'Transport',
  demoSecOrganelles: 'Organites',
  demoSecMito: 'Mitochondries',
  demoNoteTitle: 'Biologie cellulaire\u00a0: l’essentiel',
  demoNoteBody:
    '# Biologie cellulaire\u00a0: l’essentiel\n\nTout être vivant est fait de **cellules**, et toute cellule naît d’une autre cellule.\n\n## Ce que toute cellule possède\n\n- une **membrane plasmique** qui contrôle ce qui entre et sort\n- du **cytoplasme**, où ont lieu la plupart des réactions\n- des **ribosomes**, qui fabriquent les protéines\n- de l’**ADN**, qui porte les instructions\n\n## Procaryotes et eucaryotes\n\n| | Procaryote | Eucaryote |\n| --- | --- | --- |\n| Noyau | Non | Oui |\n| Taille typique | 1–5 µm | 10–100 µm |\n| Organites | Aucun à membrane | Mitochondries, RE, Golgi… |\n\n## Pourquoi les cellules restent petites\n\nPour une cellule sphérique de rayon $r$, la surface croît comme $r^2$ mais le volume comme $r^3$\u00a0:\n\n$$\\frac{A}{V} = \\frac{4\\pi r^2}{\\frac{4}{3}\\pi r^3} = \\frac{3}{r}$$\n\nDoublez le rayon\u00a0: chaque micromètre carré de membrane doit alimenter deux fois plus de cytoplasme.\n\n### Vérifier en code\n\nLe même rapport en quelques lignes de Python, avec `r` en µm\u00a0:\n\n```python\n# Le rapport A/V d’une sphère vaut 3/r : il est divisé par deux quand le rayon double\nfor r in [1, 2, 5, 10]:\n    print(f"r = {r} µm : A/V = {3 / r:.2f} par µm")\n```\n\nC’est l’une des raisons de la *théorie cellulaire* ([Wikipédia](https://fr.wikipedia.org/wiki/Th%C3%A9orie_cellulaire))\u00a0: les cellules se divisent au lieu de grandir sans fin. L’idée ancienne selon laquelle ~~les cellules naissent de la matière inerte~~ a été réfutée par Pasteur en 1859.\n\n## Potentiel de membrane\n\nL’équation de Nernst donne le potentiel d’équilibre d’un ion $X$ de charge $z$\u00a0:\n\n$$E_X = \\frac{RT}{zF}\\ln\\frac{[X]_e}{[X]_i}$$\n\n(e\u00a0: extérieur, i\u00a0: intérieur). Pour K⁺ à 37 °C, cela fait environ $-90$ mV.\n',
  demoNote2Title: 'Comment les mitochondries produisent l’ATP',
  demoNote2Body:
    '# Comment les mitochondries produisent l’ATP\n\nLes centrales énergétiques de la cellule\u00a0: elles convertissent l’énergie des nutriments en **ATP**.\n\n1. **Glycolyse** (cytoplasme)\u00a0: un glucose donne deux pyruvates, 2 ATP\n2. **Cycle de Krebs** (matrice)\u00a0: libère du CO₂, charge NADH et FADH₂\n3. **Phosphorylation oxydative** (membrane interne)\u00a0: environ 26 à 28 ATP\n\nAu total\u00a0:\n\n$$C_6H_{12}O_6 + 6\\,O_2 \\rightarrow 6\\,CO_2 + 6\\,H_2O$$\n\n> Les mitochondries gardent leur propre ADN circulaire, trace de leur origine bactérienne (endosymbiose).\n',
  demoDeckTitle: 'CM 3\u00a0: membranes et transport',
  demoSlide1Title: 'Membranes et transport',
  demoSlide1Sub: 'Biologie cellulaire · CM 3',
  demoSlide1Notes: 'Commencer par une question\u00a0: pourquoi une cellule ne fuit-elle pas\u00a0?',
  demoSlide2Title: 'La membrane plasmique',
  demoSlide2Bullets:
    'Une bicouche de phospholipides, épaisse d’environ 7–8 nm\nLes queues hydrophobes se font face\u00a0: les petites molécules apolaires passent, pas les ions\nDes protéines y flottent\u00a0: le modèle de la mosaïque fluide',
  demoSlide2Alt: 'Bicouche de phospholipides traversée par une protéine canal',
  demoSlide2Notes: 'Dessiner la bicouche au tableau et demander quel côté l’eau évite.',
  demoSlide3Title: 'Transport passif et actif',
  demoSlide3Table:
    'Mécanisme | Énergie | Exemple\nDiffusion simple | Aucune | O₂, CO₂\nDiffusion facilitée | Aucune | Glucose par GLUT\nTransport actif | ATP | Pompe Na⁺/K⁺',
  demoSlide3Notes: 'Le passif suit le gradient, l’actif va contre.',
  demoSlide4Title: 'Osmose',
  demoSlide4Bullets:
    'L’eau traverse la membrane par les aquaporines\nElle va vers le côté le plus riche en particules dissoutes\nLes globules rouges gonflent dans l’eau pure et rétrécissent dans l’eau salée',
  demoSlide4Notes: 'Montrer les photos de globules rouges dans trois solutions.',
  demoPhoto1Title: 'Épiderme d’oignon, ×400',
  demoPhoto1Caption: 'Peau d’oignon au microscope\u00a0: un noyau par cellule, parois colorées en rose',
  demoPhoto2Title: 'Schéma de cellule',
  demoPhoto2Caption: 'Cellule animale dessinée en cours, avec A et B légendés',
  demoQ01: 'Quelle est la plus petite unité du vivant\u00a0?',
  demoA01: 'La cellule. Tout être vivant est fait de cellules, et toute cellule naît d’une autre cellule.',
  demoQ02: 'Pourquoi une cellule sphérique ne peut-elle pas grandir indéfiniment\u00a0?',
  demoA02:
    'Son rapport surface/volume diminue quand elle grandit, $\\frac{A}{V} = \\frac{3}{r}$\u00a0: la membrane ne suffit plus à alimenter le volume.',
  demoQ03: 'De quoi est faite la membrane plasmique\u00a0?',
  demoA03: 'D’une bicouche de phospholipides où flottent des protéines\u00a0: le modèle de la mosaïque fluide.',
  demoQ04: 'Les phospholipides ont une tête {{c1::hydrophile}} et des queues {{c2::hydrophobes}}.',
  demoQ05:
    'Avec vos propres mots\u00a0: pourquoi O₂ et CO₂ traversent-ils facilement la membrane, mais pas les ions\u00a0?',
  demoA05:
    'Le cœur de la bicouche est hydrophobe. Les petites molécules apolaires s’y dissolvent\u00a0; les ions, chargés, sont repoussés et ont besoin de canaux ou de pompes.',
  demoQ06: 'Quels types de transport ne demandent pas d’énergie\u00a0?',
  demoA06:
    'Les trois suivent un gradient\u00a0:\n\n| Transport | Exemple |\n| --- | --- |\n| Diffusion simple | O₂, CO₂ |\n| Diffusion facilitée | Glucose par GLUT |\n| Osmose | Eau par les aquaporines |',
  demoQ07: 'Que dit la loi de Fick\u00a0?',
  demoA07: 'La diffusion suit le gradient de concentration\u00a0: $J = -D\\,\\frac{\\Delta C}{\\Delta x}$.',
  demoQ08: 'La pompe sodium-potassium fait sortir {{c1::3 Na⁺}} et entrer {{c2::2 K⁺}} pour chaque ATP.',
  demoQ09: 'Dans quel sens l’eau se déplace-t-elle par osmose\u00a0?',
  demoA09: 'Vers le côté le plus riche en particules dissoutes, là où la concentration en solutés est la plus forte.',
  demoQ10: 'Que donne l’équation de Nernst\u00a0?',
  demoA10:
    'Le potentiel d’équilibre d’un ion, $E_X = \\frac{RT}{zF}\\ln\\frac{[X]_e}{[X]_i}$ (extérieur, intérieur)\u00a0: environ $-90$ mV pour K⁺.',
  demoQ11: 'Quel organite porte la lettre A sur ce schéma\u00a0?',
  demoA11: 'Le noyau. Il contient l’ADN\u00a0; la tache sombre à l’intérieur est le nucléole.',
  demoQ12: 'Quel organite fabrique les protéines\u00a0?',
  demoA12: 'Le ribosome, libre dans le cytoplasme ou sur le réticulum endoplasmique rugueux.',
  demoQ13: 'Le {{c1::noyau}} contient l’{{c2::ADN}} de la cellule.',
  demoQ14: 'Quelle est l’équation globale de la respiration cellulaire\u00a0?',
  demoA14: '$C_6H_{12}O_6 + 6\\,O_2 \\rightarrow 6\\,CO_2 + 6\\,H_2O$, qui fournit environ 30 ATP.',
  demoQ15: 'Comment s’appellent les replis de la membrane mitochondriale interne\u00a0?',
  demoA15: 'Les crêtes. Elles agrandissent la surface qui porte la chaîne respiratoire.',
  demoQ16:
    'Les mitochondries ont leur propre ADN {{c1::circulaire::forme}}, trace de leur origine {{c2::bactérienne}}.',
  demoD1Q: 'Quelle est l’épaisseur de la membrane plasmique\u00a0?',
  demoD1A: 'Environ 7–8 nm.',
  demoD2Q: 'Le {{c1::transport actif}} déplace des substances contre leur gradient et consomme de l’{{c2::ATP}}.',
  demoD3Q: 'Donnez un exemple de diffusion facilitée.',
  demoD3A: 'Le glucose qui entre dans la cellule par un transporteur GLUT.',
  demoD4Q: 'Avec vos propres mots\u00a0: pourquoi un globule rouge éclate-t-il dans l’eau pure\u00a0?',
  demoD4A:
    'L’eau entre par osmose vers le cytoplasme, plus concentré, et la cellule n’a pas de paroi pour résister à la pression.',
  demoD5Q: 'Par quelles protéines l’eau traverse-t-elle le plus vite la membrane\u00a0?',
  demoD5A: 'Les aquaporines.',
  demoR1Q: 'Quel est le titre du CM 3\u00a0?',
  demoR1A: 'Membranes et transport.',
  demoPlanName: 'Révision de la semaine',
  demoPlan2Name: 'Avant le partiel',
  demoSecOld: 'Notes de l’an dernier',
  demoPastedBody:
    'Message du chargé de TD sur le forum du cours\u00a0:\n\nLe partiel sur les membranes porte sur le CM 3 et le TP 2\u00a0: la structure de la membrane, les transports passif et actif, et l’osmose. Calculatrice autorisée, téléphone interdit. Prévoyez un crayon pour la question de schéma.\n',
  demoPhoto2Notes:
    'Dessiné au CM 2. Avant l’examen\u00a0: B doit avoir ses crêtes à l’intérieur, et la tache sombre dans A est le nucléole.',
  demoDocTitle: 'TP 2\u00a0: globules rouges dans trois solutions',
  demoDocIntro: 'Travaillez en binôme. Rendez vos observations à la fin de la séance.',
  demoDocAimTitle: 'Objectif',
  demoDocAim:
    'Observer l’osmose\u00a0: comment les globules rouges changent dans des solutions de concentrations différentes.',
  demoDocMethodTitle: 'Protocole',
  demoDocMethod:
    'Étiqueter trois tubes\u00a0: eau distillée, NaCl à 0,9\u00a0% et NaCl à 3\u00a0%\nAjouter une goutte de sang dans chaque tube et attendre 10 minutes\nDéposer une goutte de chaque tube sur une lame et l’observer au ×400',
  demoDocSafetyTitle: 'Sécurité',
  demoDocSafety:
    'Gants et lunettes obligatoires. Les échantillons de sang vont dans le bac jaune, jamais dans l’évier.',
  demoDocResultsTitle: 'Résultats attendus',
  demoDocResults:
    'Solution | Eau | Globules rouges\nEau distillée (hypotonique) | Entre | Gonflent et éclatent\nNaCl à 0,9\u00a0% (isotonique) | À l’équilibre | Gardent leur forme\nNaCl à 3\u00a0% (hypertonique) | Sort | Se rétractent et deviennent crénelés',
  demoD6Q: 'Que devient un globule rouge dans du NaCl à 3\u00a0%\u00a0?',
  demoD6A: 'La solution est hypertonique\u00a0: la cellule perd de l’eau par osmose et se rétracte (crénelure).',
  demoD7Q: 'Quel organite porte la lettre B sur le schéma\u00a0?',
  demoD7A: 'Une mitochondrie\u00a0: les lignes en zigzag à l’intérieur sont ses crêtes.',
  demoPdfTitle: 'Partiel 2025\u00a0: membranes (annale)',
  demoPdfPage1:
    'Biologie cellulaire · Partiel 2025\nMembranes · 45 minutes · Documents interdits\n\n1. Dessinez une bicouche de phospholipides. Légendez les têtes hydrophiles et les queues hydrophobes. (4 points)\n2. Pourquoi O₂ et CO₂ traversent-ils la membrane, mais pas Na⁺\u00a0? (3 points)\n3. Citez les trois types de transport passif, avec un exemple pour chacun. (6 points)\n4. On place un globule rouge dans de l’eau distillée. Que se passe-t-il, et pourquoi\u00a0? (7 points)',
  demoPdfPage2:
    'Corrigé\n\n1. Les têtes sont tournées vers l’eau des deux côtés\u00a0; les queues se font face à l’intérieur.\n2. Le cœur de la bicouche est hydrophobe\u00a0: les petites molécules apolaires s’y dissolvent, pas les ions.\n3. Diffusion simple (O₂), diffusion facilitée (glucose par GLUT), osmose (eau par les aquaporines).\n4. L’eau entre par osmose\u00a0; sans paroi pour résister à la pression, la cellule gonfle et éclate.',
  demoSyllabusTitle: 'Programme du cours',
  demoSyllabus:
    'Biologie cellulaire · Programme\n\nCM 1\u00a0: les cellules et leurs constituants\nCM 2\u00a0: les organites\nCM 3\u00a0: membranes et transport\nCM 4\u00a0: mitochondries et énergie\nTP 2\u00a0: globules rouges dans trois solutions\n\nÉvaluation\u00a0: partiel sur les membranes (30\u00a0%), examen final (70\u00a0%).',
  demoSheet1Title: 'Le transport membranaire en bref',
  demoSheet1Body:
    'Les substances traversent la membrane gratuitement dans le sens de leur gradient, ou contre lui en dépensant de l’énergie.\n\n## Transport passif\n\nLa diffusion simple laisse passer les petites molécules apolaires à travers la bicouche\u00a0; la diffusion facilitée passe par des canaux et des transporteurs comme GLUT. Aucune ne consomme d’ATP.\n\n*{deck}*\n\n## Transport actif\n\nLes pompes déplacent des ions contre leur gradient et paient en ATP\u00a0: la pompe Na⁺/K⁺ fait sortir 3 Na⁺ et entrer 2 K⁺ pour chaque ATP.\n\n*{deck}*\n\n## Osmose\n\nL’eau va vers le côté le plus riche en particules dissoutes. Dans l’eau distillée, un globule rouge gonfle et éclate\u00a0; dans du NaCl à 3\u00a0%, il se rétracte.\n\n*{lab}*',
  demoSheet2Title: 'La respiration cellulaire',
  demoSheet2Body:
    'Les mitochondries tirent environ 30 ATP d’un glucose, en trois étapes.\n\n## Glycolyse\n\nDans le cytoplasme, un glucose donne deux pyruvates et 2 ATP.\n\n*{note}*\n\n## Cycle de Krebs\n\nDans la matrice, du CO₂ est libéré, et NADH et FADH₂ se chargent en électrons.\n\n*{note}*\n\n## Phosphorylation oxydative\n\nSur la membrane interne et ses crêtes, la chaîne respiratoire produit environ 26 à 28 ATP.\n\n*{note}*',
  // --- end demo course ---
  firstCardTitle: 'Ajoutez votre première carte',
  firstCardBody: 'Écrivez une carte dans un cours, ou ajoutez une source et acceptez les cartes suggérées.',
  firstCardBodyNoAi: 'Écrivez une carte dans un cours : une question au recto, la réponse au verso.',
  firstCardAction: 'Écrire une carte',
} as const satisfies Shape<typeof en>
