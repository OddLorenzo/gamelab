export type Lang = 'fr' | 'en';

const STORAGE_KEY = 'mb.lang';

export const en: Record<string, string> = {
  'app.title': 'Monkey Bomb',

  'lobby.create': 'Create a room',
  'lobby.join': 'Join a room',
  'lobby.joinGo': 'Go',
  'lobby.leave': 'Leave the room',
  'lobby.codeLabel': 'Room code',
  'lobby.codePlaceholder': 'ABCD',
  'lobby.seats': 'Players: {count} of 3',
  'lobby.seatYou': 'You',
  'lobby.seatFilled': 'Player joined',
  'lobby.seatEmpty': 'Free seat',
  'lobby.connecting': 'Connecting...',
  'lobby.waiting': 'Waiting for the other players...',
  'lobby.start': 'Start',
  'lobby.waitHost': 'Waiting for the host to start...',
  'lobby.level': 'Level',
  'level.n': 'Level {n}',
  'lobby.lang': 'Language',
  'lobby.footerVersion': 'Monkey Bomb {version}',

  'err.full': 'This room is full.',
  'err.noRoom': 'No room with that code.',
  'err.network': 'Connection problem. Check your network and try again.',
  'err.playerLeft': 'A player left the game.',
  'err.hostLeft': 'The host left the game.',

  'results.won': 'Bomb defused!',
  'results.lost': 'Boom! The bomb went off.',
  'results.stars': 'Stars: {count} of 3',
  'results.next': 'Next level',
  'results.retry': 'Try again',
  'results.lobby': 'Back to the lobby',
  'results.waitHost': 'Waiting for the host to pick what is next...',

  'setting.jungle': 'The Jungle',
  'setting.temple': 'The Temple',
  'setting.harbor': 'The Harbor',
  'setting.market': 'The Market',
  'setting.volcano': 'The Volcano',
  'setting.cavern': 'The Cavern',
  'setting.treehouse': 'The Treehouse',
  'setting.shipwreck': 'The Shipwreck',
  'setting.fairground': 'The Fairground',
  'setting.summit': 'The Summit',

  'role.blind': 'Blind',
  'role.deaf': 'Deaf',
  'role.mute': 'Mute',

  'color.red': 'red',
  'color.blue': 'blue',
  'color.yellow': 'yellow',
  'color.green': 'green',
  'color.white': 'white',

  'emote.open': 'Emotes',
  'emote.point': 'Look here',
  'emote.wave': 'Hello',
  'emote.slap': 'Slap',
  'emote.panic': 'Panic',
  'emote.yes': 'Yes',
  'emote.no': 'No',

  'glyph.flame': 'flame',
  'glyph.spiral': 'spiral',
  'glyph.crab': 'crab',
  'glyph.hand': 'hand',
  'glyph.anchor': 'anchor',
  'glyph.eye': 'eye',
  'glyph.crown': 'crown',
  'glyph.moon': 'moon',
  'glyph.key': 'key',
  'glyph.cloud': 'cloud',
  'glyph.arrow': 'arrow',
  'glyph.tree': 'tree',
  'glyph.shell': 'shell',
  'glyph.leaf': 'leaf',
  'glyph.gear': 'gear',
  'glyph.bolt': 'lightning bolt',
  'glyph.drop': 'drop',
  'glyph.star': 'star',
  'glyph.bell': 'bell',
  'glyph.wave': 'wave',

  'manual.empty': 'Nothing to read yet. The manual pages show up when the game starts.',
  'manual.prev': 'Previous page',
  'manual.next': 'Next page',
  'manual.column': 'Column {n}',

  'manual.wires.title': 'Wires',
  'manual.wires.rule.3':
    '3 wires. Count the wires from the top: the first wire is the top one. Cut wires still count. Check the lines in this order and stop at the first one that applies:\n1. No {red} wire: cut the second wire.\n2. Otherwise, if the last wire is {white}: cut the first wire.\n3. Otherwise, if there is more than one {blue} wire: cut the last {blue} wire.\n4. Otherwise: cut the last wire.',
  'manual.wires.rule.4':
    '4 wires. Count the wires from the top: the first wire is the top one. Cut wires still count. Check the lines in this order and stop at the first one that applies:\n1. More than one {red} wire: cut the last {red} wire.\n2. Otherwise, if the last wire is {yellow} and there is no {red} wire: cut the first wire.\n3. Otherwise, if there is exactly one {blue} wire: cut that {blue} wire.\n4. Otherwise, if there is more than one {yellow} wire: cut the last wire.\n5. Otherwise: cut the second wire.',
  'manual.wires.rule.5':
    '5 wires. Count the wires from the top: the first wire is the top one. Cut wires still count. Check the lines in this order and stop at the first one that applies:\n1. If the last wire is {green}: cut the fourth wire.\n2. Otherwise, if there is exactly one {red} wire and more than one {yellow} wire: cut the first wire.\n3. Otherwise, if there is no {green} wire: cut the second wire.\n4. Otherwise: cut the first wire.',
  'manual.wires.rule.6':
    '6 wires. Count the wires from the top: the first wire is the top one. Cut wires still count. Check the lines in this order and stop at the first one that applies:\n1. No {yellow} wire: cut the third wire.\n2. Otherwise, if there is exactly one {yellow} wire and more than one {white} wire: cut the last {white} wire.\n3. Otherwise, if there is no {white} wire: cut the last wire.\n4. Otherwise: cut the fourth wire.',

  'manual.button.title': 'The button',
  'manual.button.rule.1':
    'Look at the color of the button and the word written on it (HOLD, PRESS or ABORT). Check the lines 1 to 5 in order and stop at the first one that applies:\n1. The {white} button labelled ABORT: tap.',
  'manual.button.rule.2': '2. The {blue} button, whatever the label: hold.',
  'manual.button.rule.3': '3. Any other button labelled ABORT: hold.',
  'manual.button.rule.4': '4. The {yellow} button labelled PRESS: hold.',
  'manual.button.rule.5': '5. Anything else: tap.',
  'manual.button.rule.6':
    'A tap: touch the button and let go at once. A hold: keep the finger on the button, then let go at the moment when the last digit of the seconds on the timer is the digit on the button (timer at 2:47 and digit 7: let go while the seconds of the timer end in 7). Letting go at another digit is a strike. Holding a button that needs a tap for too long is also a strike.',

  'manual.symbols.title': 'Symbols',
  'manual.symbols.rule.1':
    'The module shows 4 symbols in a 2 by 2 grid. Number them in reading order: 1 top left, 2 top right, 3 bottom left, 4 bottom right.',
  'manual.symbols.rule.2':
    'Find the one column in the table below that contains all 4 symbols. A column reads from top to bottom, and exactly one column fits.',
  'manual.symbols.rule.3':
    'Tap the 4 symbols in the order they appear in that column, from top to bottom. Give the order as the numbers 1 to 4, for example 3, 1, 4, 2.',
  'manual.symbols.rule.4':
    'A wrong tap is a strike and you must start the whole sequence again from the beginning. After the 4th right tap the module is solved.',

  'manual.code.title': 'The code',
  'manual.code.rule.1':
    'The serial number has 6 characters, read from left to right. Give each one a value: a digit is worth itself, a letter is worth its place in the alphabet (A=1, B=2, C=3 ... Z=26).',
  'manual.code.rule.2': 'Add up the 6 values. Call the total S.',
  'manual.code.rule.3':
    'The code has 4 digits. For digit number n (n = 1, 2, 3, 4): start from S, add n times the value of serial character number n, then add 3 times (n minus 1). The code digit is the last digit of the total.',
  'manual.code.rule.4':
    'Example: serial K7B3M9. Values: 11, 7, 2, 3, 13, 9, so S = 45.\nDigit 1: 45 + 1×11 + 0 = 56, so 6.\nDigit 2: 45 + 2×7 + 3 = 62, so 2.\nDigit 3: 45 + 3×2 + 6 = 57, so 7.\nDigit 4: 45 + 4×3 + 9 = 66, so 6.\nThe code is 6276.',
  'manual.code.rule.5':
    'The 4 digits are typed, then submitted. The keypad is like a phone: 1 2 3, then 4 5 6, then 7 8 9, then clear, 0, submit. A wrong code is a strike and wipes the digits. Clear erases what was typed.',

  'game.waiting': 'Getting your role...',
  'game.player': 'Player {n}',
  'game.emoteFrom': '{player}: {emote}',

  'ui.mic.denied': 'Your microphone is off, so nobody can hear you. The game still works: use gestures and emotes.',
};

export const fr: Record<string, string> = {
  'app.title': 'Monkey Bomb',

  'lobby.create': 'Créer une salle',
  'lobby.join': 'Rejoindre une salle',
  'lobby.joinGo': 'Go',
  'lobby.leave': 'Quitter la salle',
  'lobby.codeLabel': 'Code de la salle',
  'lobby.codePlaceholder': 'ABCD',
  'lobby.seats': 'Joueurs : {count} sur 3',
  'lobby.seatYou': 'Toi',
  'lobby.seatFilled': 'Joueur arrivé',
  'lobby.seatEmpty': 'Place libre',
  'lobby.connecting': 'Connexion...',
  'lobby.waiting': 'On attend les autres joueurs...',
  'lobby.start': 'Lancer',
  'lobby.waitHost': "On attend que l'hôte lance la partie...",
  'lobby.level': 'Niveau',
  'level.n': 'Niveau {n}',
  'lobby.lang': 'Langue',
  'lobby.footerVersion': 'Monkey Bomb {version}',

  'err.full': 'Cette salle est pleine.',
  'err.noRoom': 'Aucune salle avec ce code.',
  'err.network': 'Problème de connexion. Vérifie ton réseau et réessaie.',
  'err.playerLeft': 'Un joueur a quitté la partie.',
  'err.hostLeft': "L'hôte a quitté la partie.",

  'results.won': 'Bombe désamorcée !',
  'results.lost': 'Boum ! La bombe a explosé.',
  'results.stars': 'Étoiles : {count} sur 3',
  'results.next': 'Niveau suivant',
  'results.retry': 'Réessayer',
  'results.lobby': 'Retour à la salle',
  'results.waitHost': "On attend que l'hôte choisisse la suite...",

  'setting.jungle': 'La Jungle',
  'setting.temple': 'Le Temple',
  'setting.harbor': 'Le Port',
  'setting.market': 'Le Marché',
  'setting.volcano': 'Le Volcan',
  'setting.cavern': 'La Caverne',
  'setting.treehouse': 'La Cabane',
  'setting.shipwreck': "L'Épave",
  'setting.fairground': 'La Fête foraine',
  'setting.summit': 'Le Sommet',

  'role.blind': 'Aveugle',
  'role.deaf': 'Sourd',
  'role.mute': 'Muet',

  'color.red': 'rouge',
  'color.blue': 'bleu',
  'color.yellow': 'jaune',
  'color.green': 'vert',
  'color.white': 'blanc',

  'emote.open': 'Emotes',
  'emote.point': 'Regarde ici',
  'emote.wave': 'Salut',
  'emote.slap': 'Claque',
  'emote.panic': 'Panique',
  'emote.yes': 'Oui',
  'emote.no': 'Non',

  'glyph.flame': 'flamme',
  'glyph.spiral': 'spirale',
  'glyph.crab': 'crabe',
  'glyph.hand': 'main',
  'glyph.anchor': 'ancre',
  'glyph.eye': 'œil',
  'glyph.crown': 'couronne',
  'glyph.moon': 'lune',
  'glyph.key': 'clé',
  'glyph.cloud': 'nuage',
  'glyph.arrow': 'flèche',
  'glyph.tree': 'arbre',
  'glyph.shell': 'coquillage',
  'glyph.leaf': 'feuille',
  'glyph.gear': 'engrenage',
  'glyph.bolt': 'éclair',
  'glyph.drop': 'goutte',
  'glyph.star': 'étoile',
  'glyph.bell': 'cloche',
  'glyph.wave': 'vague',

  'manual.empty': 'Rien à lire pour le moment. Les pages du manuel apparaissent quand la partie démarre.',
  'manual.prev': 'Page précédente',
  'manual.next': 'Page suivante',
  'manual.column': 'Colonne {n}',

  'manual.wires.title': 'Fils',
  'manual.wires.rule.3':
    "3 fils. On compte les fils à partir du haut : le premier fil est celui du haut. Les fils coupés comptent toujours. Vérifie les lignes dans cet ordre et arrête-toi à la première qui s'applique :\n1. Aucun fil {red} : coupe le deuxième fil.\n2. Sinon, si le dernier fil est {white} : coupe le premier fil.\n3. Sinon, s'il y a plus d'un fil {blue} : coupe le dernier fil {blue}.\n4. Sinon : coupe le dernier fil.",
  'manual.wires.rule.4':
    "4 fils. On compte les fils à partir du haut : le premier fil est celui du haut. Les fils coupés comptent toujours. Vérifie les lignes dans cet ordre et arrête-toi à la première qui s'applique :\n1. Plus d'un fil {red} : coupe le dernier fil {red}.\n2. Sinon, si le dernier fil est {yellow} et qu'il n'y a aucun fil {red} : coupe le premier fil.\n3. Sinon, s'il y a exactement un fil {blue} : coupe ce fil {blue}.\n4. Sinon, s'il y a plus d'un fil {yellow} : coupe le dernier fil.\n5. Sinon : coupe le deuxième fil.",
  'manual.wires.rule.5':
    "5 fils. On compte les fils à partir du haut : le premier fil est celui du haut. Les fils coupés comptent toujours. Vérifie les lignes dans cet ordre et arrête-toi à la première qui s'applique :\n1. Si le dernier fil est {green} : coupe le quatrième fil.\n2. Sinon, s'il y a exactement un fil {red} et plus d'un fil {yellow} : coupe le premier fil.\n3. Sinon, s'il n'y a aucun fil {green} : coupe le deuxième fil.\n4. Sinon : coupe le premier fil.",
  'manual.wires.rule.6':
    "6 fils. On compte les fils à partir du haut : le premier fil est celui du haut. Les fils coupés comptent toujours. Vérifie les lignes dans cet ordre et arrête-toi à la première qui s'applique :\n1. Aucun fil {yellow} : coupe le troisième fil.\n2. Sinon, s'il y a exactement un fil {yellow} et plus d'un fil {white} : coupe le dernier fil {white}.\n3. Sinon, s'il n'y a aucun fil {white} : coupe le dernier fil.\n4. Sinon : coupe le quatrième fil.",

  'manual.button.title': 'Le bouton',
  'manual.button.rule.1':
    "Regarde la couleur du bouton et le mot écrit dessus (HOLD, PRESS ou ABORT). Vérifie les lignes 1 à 5 dans l'ordre et arrête-toi à la première qui s'applique :\n1. Bouton {white} avec le mot ABORT : appui bref.",
  'manual.button.rule.2': '2. Bouton {blue}, quel que soit le mot : appui long.',
  'manual.button.rule.3': '3. Tout autre bouton avec le mot ABORT : appui long.',
  'manual.button.rule.4': '4. Bouton {yellow} avec le mot PRESS : appui long.',
  'manual.button.rule.5': '5. Tout le reste : appui bref.',
  'manual.button.rule.6':
    'Appui bref : touche le bouton et relâche tout de suite. Appui long : garde le doigt sur le bouton, puis relâche au moment où le dernier chiffre des secondes du minuteur est le chiffre du bouton (minuteur à 2:47 et chiffre 7 : relâche tant que les secondes du minuteur se terminent par 7). Relâcher sur un autre chiffre compte comme une erreur. Garder le doigt trop longtemps sur un bouton à appui bref compte aussi comme une erreur.',

  'manual.symbols.title': 'Symboles',
  'manual.symbols.rule.1':
    'Le module montre 4 symboles dans une grille 2 sur 2. Numérote-les dans le sens de lecture : 1 en haut à gauche, 2 en haut à droite, 3 en bas à gauche, 4 en bas à droite.',
  'manual.symbols.rule.2':
    "Trouve dans le tableau ci-dessous l'unique colonne qui contient les 4 symboles. Une colonne se lit de haut en bas, et une seule colonne convient.",
  'manual.symbols.rule.3':
    "Il faut taper les 4 symboles dans l'ordre où ils apparaissent dans cette colonne, de haut en bas. Donne l'ordre avec les numéros de 1 à 4, par exemple 3, 1, 4, 2.",
  'manual.symbols.rule.4':
    'Un mauvais appui compte comme une erreur : il faut recommencer toute la séquence depuis le début. Après le 4e bon appui, le module est désamorcé.',

  'manual.code.title': 'Le code',
  'manual.code.rule.1':
    "Le numéro de série a 6 caractères, lus de gauche à droite. Donne une valeur à chacun : un chiffre vaut lui-même, une lettre vaut sa place dans l'alphabet (A=1, B=2, C=3 ... Z=26).",
  'manual.code.rule.2': 'Additionne les 6 valeurs. Appelle le total S.',
  'manual.code.rule.3':
    'Le code a 4 chiffres. Pour le chiffre numéro n (n = 1, 2, 3, 4) : pars de S, ajoute n fois la valeur du caractère numéro n du numéro de série, puis ajoute 3 fois (n moins 1). Le chiffre du code est le dernier chiffre du total.',
  'manual.code.rule.4':
    'Exemple : numéro de série K7B3M9. Valeurs : 11, 7, 2, 3, 13, 9, donc S = 45.\nChiffre 1 : 45 + 1×11 + 0 = 56, donc 6.\nChiffre 2 : 45 + 2×7 + 3 = 62, donc 2.\nChiffre 3 : 45 + 3×2 + 6 = 57, donc 7.\nChiffre 4 : 45 + 4×3 + 9 = 66, donc 6.\nLe code est 6276.',
  'manual.code.rule.5':
    "Les 4 chiffres sont tapés, puis validés. Le clavier ressemble à celui d'un téléphone : 1 2 3, puis 4 5 6, puis 7 8 9, puis effacer, 0, valider. Un mauvais code compte comme une erreur et efface les chiffres. Effacer supprime ce qui a été tapé.",

  'game.waiting': 'Attribution de ton rôle...',
  'game.player': 'Joueur {n}',
  'game.emoteFrom': '{player} : {emote}',

  'ui.mic.denied':
    "Ton micro est coupé : personne ne peut t'entendre. Le jeu fonctionne quand même, utilise les gestes et les emotes.",
};

const TABLES: Record<Lang, Record<string, string>> = { en, fr };

/** fr for any browser language starting with fr, else en. */
export function detectLang(language: string | undefined): Lang {
  return typeof language === 'string' && language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    // storage unavailable: fall through to the browser language
  }
  return detectLang(typeof navigator === 'undefined' ? undefined : navigator.language);
}

let current: Lang | null = null;

export function getLang(): Lang {
  current ??= initialLang();
  return current;
}

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    // the choice still applies for this session
  }
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

/** Translate `key` in the current language; `{name}` placeholders come from `vars`. Unknown key: the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = TABLES[getLang()];
  if (!Object.prototype.hasOwnProperty.call(table, key)) return key;
  const text = table[key];
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}
