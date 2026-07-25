// ─────────────────────────────────────────────────────────────────────────────
// Tag lexicon + tag suggestion helpers
//
// Ported from janitor-proxy-extractor/lib/parser.js (commit d42ae93).
// The lexicon is curated by hand: high-precision genre/species/archetype tags
// that, when matched, are essentially always correct. The suggestion algorithm
// combines lexicon matches with proper-noun extraction and frequency analysis,
// then filters down to lexicon hits + multi-word phrases (single non-lexicon
// words are almost always noise).
// ─────────────────────────────────────────────────────────────────────────────

export const TAG_LEXICON = [
  // ─── Genres ───
  "fantasy", "sci-fi", "cyberpunk", "steampunk", "post-apocalyptic", "horror", "romance", "mystery",
  "slice of life", "adventure", "historical", "modern", "noir", "mecha", "isekai",
  "psychological", "thriller", "comedy", "drama", "tragedy", "action", "ecchi", "harem",
  "reverse harem", "shoujo", "shounen", "josei", "seinen", "yuri", "yaoi", "bara",
  "otome", "magical girl", "idol", "tournament", "survival", "military",

  // ─── Tone / Vibe ───
  "fluff", "smut", "angst", "slowburn", "comfort", "hurt", "wholesome", "dark",
  "comedic", "dramatic", "tragic", "uplifting", "bittersweet", "melancholy",
  "crack", "pwp", "plot heavy", "character study",

  // ─── Tropes / Dynamics ───
  "enemies to lovers", "friends to lovers", "rivalry", "rival", "mentor", "mentors",
  "ally", "enemy", "lover", "sibling", "parent", "servant", "master", "subordinate",
  "boss", "coworker", "roommate", "stranger", "childhood friend", "best friend",
  "fake dating", "arranged marriage", "forbidden love", "secret relationship",
  "love triangle", "second chance", "reunion", "unrequited love", "pining",
  "mutual pining", "amnesia", "memory loss", "time loop", "reincarnation",
  "soulmates", "fated mates", "mating bond", "true love", "forbidden romance",
  "age gap", "size difference", "opposites attract", "grumpy x sunshine",
  "sunshine x grumpy", "golden retriever", "black cat", "stuck together",
  "only one bed", "forced proximity", "hurt comfort", "angst with happy ending",
  "happy ending", "sad ending", "open ending",

  // ─── Archetypes / Roles ───
  "warrior", "mage", "assassin", "thief", "healer", "knight", "samurai", "ninja", "pirate",
  "detective", "mercenary", "noble", "peasant", "scholar", "merchant", "bard", "ranger",
  "cleric", "monk", "druid", "paladin", "sorcerer", "necromancer", "alchemist",
  "teacher", "student", "doctor", "nurse", "soldier", "guard", "captain",
  "prince", "princess", "queen", "king", "emperor", "empress", "lord", "lady",
  "maid", "butler", "waiter", "chef", "bartender", "barista", "librarian",
  "scientist", "engineer", "programmer", "hacker", "pilot", "astronaut",
  "journalist", "writer", "artist", "musician", "idol", "actor", "model",
  "priest", "shrine maiden", "miko", "summoner", "beast tamer", "adventurer",
  "guild master", "innkeeper", "tavern keeper", "blacksmith", "hunter",

  // ─── Species / Being ───
  "elf", "dwarf", "vampire", "werewolf", "demon", "angel", "fae", "fairy",
  "dragon", "android", "robot", "cyborg", "alien", "ghost", "zombie", "goblin",
  "orc", "troll", "catgirl", "foxgirl", "cowgirl", "bunnygirl", "wolfgirl",
  "monster girl", "animal ears", "kemonomimi", "harpy", "succubus", "incubus",
  "mermaid", "centaur", "minotaur", "gorgon", "lamia", "arachne", "slime",
  "golem", "kobold", "gnome", "halfling", "tiefling", "drow", "high elf",
  "dark elf", "wood elf", "half elf", "half orc", "dhampir", "lich", "wraith",
  "banshee", "ghoul", "revenant", "skeleton",

  // ─── Personality / Traits ───
  "dominant", "submissive", "stoic", "cheerful", "brooding", "mysterious", "arrogant",
  "shy", "confident", "cruel", "kind", "loyal", "manipulative", "naive", "cynical",
  "tsundere", "yandere", "kuudere", "dandere", "deredere", "himedere", "kamidere",
  "bratty", "smug", "gentle", "cold", "warm", "playful", "serious",
  "flirtatious", "teasing", "possessive", "protective", "jealous",
  "introverted", "extroverted", "awkward", "clumsy", "graceful", "elegant",
  "tomboy", "girly", "feminine", "masculine", "androgynous", "airhead",
  "genius", "bookish", "athletic", "lazy", "hardworking", "ambitious",
  "apathetic", "emotionless", "optimistic", "pessimistic",
  "sarcastic", "witty", "snarky", "sassy", "pouty", "mischievous",
  "sadistic", "masochistic", "ruthless", "merciful", "forgiving",
  "vengeful", "obsessive", "clingy", "distant", "aloof",

  // ─── Setting ───
  "kingdom", "empire", "city", "village", "academy", "school", "college", "university",
  "guild", "temple", "shrine", "tavern", "inn", "castle", "mansion", "palace",
  "forest", "desert", "jungle", "mountain", "ocean", "sea", "island", "archipelago",
  "space station", "starship", "spaceship", "dungeon", "ruins", "cave", "underworld",
  "hell", "heaven", "limbo", "dreamscape", "parallel world", "alternate universe",
  "farm", "countryside", "suburbs", "metropolis", "slums", "red light district",
  "cafe", "restaurant", "bar", "club", "brothel", "casino", "theater", "circus",
  "lab", "prison", "asylum", "hospital", "orphanage", "barracks", "arena", "stadium",
  "edo period", "medieval", "renaissance", "victorian", "edwardian", "roaring twenties",
  "wild west", "cold war", "world war", "modern day", "near future", "far future",
  "dystopia", "utopia", "cyberpunk city", "neon city",

  // ─── Relationship / Family ───
  "childhood friends", "best friends", "siblings", "twins", "step siblings",
  "half siblings", "cousins", "in laws", "step parent", "step child", "adopted",
  "foster family", "found family", "single parent", "divorced", "widowed",
  "married", "engaged", "dating", "exes", "estranged",

  // ─── Kinks / Smut tags ───
  "netori", "netorare", "ntr", "cuckolding", "cheating", "infidelity", "affair",
  "voyeurism", "exhibitionism", "bdsm", "bondage", "domsub", "femdom", "maledom",
  "switch", "service top", "power bottom", "brat tamer", "praise kink", "degradation",
  "humiliation", "worship", "body worship", "feet", "masturbation",
  "oral", "anal", "vaginal", "threesome", "group sex", "orgy", "gangbang",
  "public sex", "semi public", "quickie", "edging", "orgasm denial", "teasing",
  "dirty talk", "roleplay", "cosplay", "uniform", "lingerie", "swimwear",
  "naked apron", "maid outfit", "nurse outfit", "teacher outfit",
  "size difference", "large breasts", "small breasts", "flat chested",
  "muscular", "petite", "tall", "short", "chubby", "slender", "curvy",
  "ahegao", "creampie", "facial", "swallowing", "breeding", "marking",
  "biting", "scratching", "spanking", "choking", "hair pulling",
  "gentle femdom", "soft dom", "mean dom", "mommy", "daddy", "mommy issues",
  "daddy issues", "milf", "dilf", "cougar", "sugar daddy", "sugar mommy",
  "age gap", "first time", "virgin", "experienced", "innocent", "corruption",
  "corruption kink", "innocence kink", "purity", "promiscuous",

  // ─── Fandoms / Franchises (popular ones) ───
  "pokemon", "pokémon", "gundam", "naruto", "one piece", "bleach",
  "attack on titan", "my hero academia", "demon slayer", "jujutsu kaisen",
  "spy x family", "chainsaw man", "dragon ball", "final fantasy",
  "genshin impact", "honkai", "fate", "fate stay night", "fate grand order",
  "touhou", "hololive", "vtuber", "kancolle", "azur lane", "girl frontline",
  "blue archive", "arknights", "league of legends", "valorant", "overwatch",
  "genshin", "honkai star rail", "zepeto", "minecraft", "roblox", "fortnite",
  "honkai impact", "disney", "marvel", "dc comics", "harry potter",
  "lord of the rings", "star wars", "star trek", "doctor who", "sherlock",
  "twilight", "hunger games", "percy jackson", "dungeon meshi", "oshi no ko",

  // ─── Anime/manga style descriptors ───
  "gyaru", "gal", "lolita", "gothic lolita", "gothic", "punk", "emo", "visual novel",
  "light novel", "manga", "anime", "cosplay", "kawaii", "moe", "chibi",
  "magical girl", "idol", "host club", "hostess club", "visual kei",

  // ─── Age / Role ───
  "milf", "dilf", "teen", "young adult", "adult", "middle aged", "elder", "elderly",
  "child", "immortal", "ancient", "ageless",

  // ─── Power / Abilities ───
  "magic", "magical", "superpowers", "superhuman", "psychic", "telepathy",
  "telekinesis", "pyrokinesis", "cryokinesis", "electrokinesis", "hydrokinesis",
  "flight", "super strength", "super speed", "invisibility", "shapeshifting",
  "teleportation", "time manipulation", "gravity manipulation", "healing factor",
  "immortality", "invulnerability", "energy blast", "force field", "summoning",
  "necromancy", "pyromancy", "divination", "alchemy", "enchantment",
  "curse", "blessing", "ritual", "spellcaster", "spell casting",

  // ─── Status / Class ───
  "royalty", "nobility", "commoner", "outlaw", "criminal", "thief", "bandit",
  "pirate", "corsair", "bounty hunter", "smuggler", "gangster", "mafia",
  "yakuza", "mobster", "serial killer", "assassin", "hitman",
  "refugee", "orphan", "wanderer", "hermit", "nomad", "traveler", "pilgrim",
  "knight errant", "ronin", "wandering mage", "fallen noble", "disgraced",
  "exiled", "banished", "fugitive", "redeemed", "reformed",

  // ─── Body / Appearance descriptors ───
  "tall", "short", "petite", "muscular", "athletic", "slender", "curvy", "chubby",
  "plump", "thin", "lanky", "stocky", "broad shouldered", "narrow hips",
  "long hair", "short hair", "ponytail", "twin tails", "pigtails", "braids",
  "curly hair", "straight hair", "wavy hair", "messy hair", "slicked back",
  "bangs", "fringes", "bob cut", "pixie cut", "buzz cut", "bald",
  "blonde", "brunette", "black hair", "red hair", "white hair", "silver hair",
  "pink hair", "blue hair", "green hair", "purple hair", "rainbow hair",
  "heterochromia", "green eyes", "blue eyes", "brown eyes", "red eyes",
  "purple eyes", "yellow eyes", "golden eyes", "grey eyes", "pale skin",
  "tan skin", "dark skin", "freckles", "scars", "tattoos", "piercings",
  "glasses", "eye patch", "mask", "hood", "cape", "crown", "tiara",

  // ─── Languages / Ethnicity (when relevant to setting) ───
  "japanese", "american", "british", "french", "german", "russian", "chinese",
  "korean", "spanish", "italian", "indian", "brazilian", "australian",
  "canadian", "mexican", "egyptian", "greek", "norse", "celtic", "african",
];

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","to","in","on","at","for","with","by","from","as","is","are",
  "was","were","be","been","being","have","has","had","do","does","did","will","would","could","should",
  "may","might","can","this","that","these","those","i","you","he","she","it","we","they","him","her",
  "them","his","hers","its","our","their","my","your","what","which","who","whom","whose","when","where",
  "why","how","all","any","both","each","few","more","most","other","some","such","no","nor","not","only",
  "own","same","so","than","too","very","just","about","above","after","again","against","below","down",
  "during","further","here","into","off","out","over","then","there","under","up","if","because","while",
  "though","although","however","therefore","thus","also","one","two","three","very","will","shall",
]);

const DROP_ALWAYS_TAGS = new Set([
  "don't", "doesn't", "didn't", "won't", "wouldn't", "shouldn't", "couldn't",
  "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't", "hadn't",
  "she's", "he's", "it's", "they're", "we're", "you're", "i'm", "i've",
  "you've", "we've", "they've", "i'll", "you'll", "he'll", "she'll", "we'll",
  "they'll", "i'd", "you'd", "he'd", "she'd", "we'd", "they'd", "let's",
  "that's", "who's", "what's", "where's", "when's", "why's", "how's",
  "here's", "there's", "c's", "cj's", "'s", "'t", "'re", "'ve", "'ll", "'d",
  "'m",
]);

const LEXICON_SET = new Set(TAG_LEXICON);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SuggestTagsInput {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  system_prompt?: string;
  creator_notes?: string;
  [key: string]: string | undefined;
}

export interface SuggestTagsOptions {
  max?: number;
}

/**
 * Suggest tags for a card. Returns ranked unique tags.
 * Accepts either a string (treated as description) or an object of card fields.
 */
export function suggestTags(
  input: string | SuggestTagsInput,
  opts: SuggestTagsOptions = {},
): string[] {
  const max = opts.max || 10;

  let fields: SuggestTagsInput;
  if (typeof input === "string") {
    fields = { description: input };
  } else if (input && typeof input === "object") {
    fields = input;
  } else {
    return [];
  }

  const FIELD_WEIGHTS: Record<string, number> = {
    description:    1.0,
    personality:    0.8,
    scenario:       0.8,
    first_mes:      0.5,
    system_prompt:  0.4,
    creator_notes:  0.4,
    name:           0.3,
  };

  const scores = new Map<string, number>();
  const freq = new Map<string, number>();

  for (const [fieldName, weight] of Object.entries(FIELD_WEIGHTS)) {
    const raw = fields[fieldName];
    if (!raw || typeof raw !== "string") continue;

    const text = raw.toLowerCase();
    if (!text) continue;

    // 1. Lexicon matches — weighted by field importance.
    for (const tag of TAG_LEXICON) {
      const re = new RegExp(`\\b${escapeRegex(tag)}\\b`, "i");
      if (re.test(text)) {
        scores.set(tag, (scores.get(tag) || 0) + 5 * weight);
      }
    }

    // 2. Proper nouns (capitalized words not at sentence start).
    const words = raw.split(/[^a-zA-Z'\-]+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w || w.length < 3) continue;
      if (!/^[A-Z][a-z]/.test(w)) continue;
      if (i > 0 && !/[.!?]\s*$/.test(words[i - 1])) continue;
      const lower = w.toLowerCase();
      if (STOPWORDS.has(lower)) continue;
      scores.set(lower, (scores.get(lower) || 0) + 2 * weight);
    }

    // 3. Word frequency (non-stopwords, length >= 4).
    for (const rawWord of words) {
      const w = rawWord.toLowerCase();
      if (!w || w.length < 4) continue;
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + weight);
    }
  }

  for (const [w, count] of freq) {
    if (count >= 2) {
      scores.set(w, (scores.get(w) || 0) + count);
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([tag]) => tag);
}

/**
 * Filter raw tag suggestions: keep lexicon hits + multi-word phrases,
 * drop single non-lexicon words (almost always noise).
 */
export function filterSuggestedTags(rawTags: string[], cardName?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const nameWords = new Set(
    String(cardName || "")
      .toLowerCase()
      .split(/[^a-z0-9']+/i)
      .filter((w) => w.length > 1),
  );

  for (const t of rawTags) {
    const tag = String(t).toLowerCase().trim();
    if (!tag) continue;
    if (seen.has(tag)) continue;
    if (DROP_ALWAYS_TAGS.has(tag)) continue;
    if (nameWords.has(tag)) continue;
    if (tag.length < 3) continue;

    const isLexicon = LEXICON_SET.has(tag);
    const isMultiWord = tag.includes(" ") && tag.split(/\s+/).length >= 2;
    if (!isLexicon && !isMultiWord) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * Title-case a tag for display: 'slice of life' → 'Slice Of Life',
 * 'sci-fi' → 'Sci-Fi', 'ntr' → 'NTR'.
 */
export function prettifyTag(tag: string): string {
  return String(tag || "")
    .split(/\s+/)
    .map((w) => {
      if (/^[a-z]{2,3}$/.test(w) && ["ntr", "milf", "dilf", "pwp", "bdsm", "ecchi"].includes(w)) {
        return w.toUpperCase();
      }
      if (w.length === 2 && !["of", "to", "or", "in", "on", "at", "by", "x"].includes(w)) {
        return w.toUpperCase();
      }
      if (w.includes("-")) {
        return w.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-");
      }
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export interface AutoTagOptions {
  max?: number;
}

/**
 * Top-level helper: take a card object (V2 spec) and return a prettified,
 * filtered tag list. Returns null if no useful tags could be extracted.
 */
export function autoTagCard(
  card: { data?: any } | any,
  opts: AutoTagOptions = {},
): string[] | null {
  const max = opts.max || 8;
  const d = card?.data || card || {};
  const input: SuggestTagsInput = {
    name:          d.name,
    description:   d.description,
    personality:   d.personality,
    scenario:      d.scenario,
    first_mes:     d.first_mes,
    system_prompt: d.system_prompt,
    creator_notes: d.creator_notes,
  };
  const raw = suggestTags(input, { max: max * 4 });
  const filtered = filterSuggestedTags(raw, d.name).slice(0, max);
  if (filtered.length === 0) return null;
  return filtered.map(prettifyTag);
}
