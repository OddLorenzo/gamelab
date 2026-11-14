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
