/**
 * Narrative check for the dip-reversal strategy.
 *
 * A meme coin's price is driven by the story people can retell in one sentence, not by its
 * fundamentals — so before buying a technically clean dip we ask: does this token belong to a
 * narrative that is currently moving money, and does it have the social surface a narrative
 * needs to spread? The answer is a 0–100 score, deterministic and cheap: it reuses the metadata
 * DexScreener already returns with the pair, so it costs no extra API call.
 *
 * It is a filter against nameless clones, not a price prediction.
 */

export interface NarrativeInput {
  symbol?: string | null;
  name?: string | null;
  description?: string | null;
  /** Social platform types from DexScreener's pair `info.socials` (twitter, telegram, discord…) */
  socials?: string[];
  /** Number of websites listed on the pair */
  websites?: number;
  /** Active DexScreener boosts — paid promotion, i.e. someone is actively pushing the story */
  boosts?: number;
  /** Extra keywords the user tracks, from settings (comma-separated in the cockpit) */
  extraKeywords?: string[];
}

export interface NarrativeResult {
  score: number;
  /** Narrative buckets that matched, strongest first */
  tags: string[];
  /** Human-readable reasons behind the score, for the Telegram alert and the inspector */
  notes: string[];
  /** Strongest matching narrative, or null when the token has no recognisable story */
  narrative: string | null;
}

/**
 * The buckets that have repeatedly carried Solana meme coins. Weights are relative strength of
 * the bucket as a story, not a prediction for any single token — and the list is meant to be
 * edited: narratives rotate, so the cockpit's "extra keywords" field feeds the same matcher.
 */
const NARRATIVE_TIERS: Array<{ tag: string; weight: number; words: string[] }> = [
  {
    tag: 'ai',
    weight: 30,
    words: ['ai', 'agent', 'defai', 'gpt', 'llm', 'neural', 'robot', 'bot', 'quant', 'mcp', 'swarm', 'brain'],
  },
  {
    tag: 'politics',
    weight: 28,
    words: ['trump', 'maga', 'elon', 'musk', 'biden', 'kamala', 'putin', 'obama', 'melania', 'vance', 'president', 'election'],
  },
  {
    tag: 'animal',
    weight: 25,
    words: [
      'dog', 'doge', 'shib', 'inu', 'cat', 'kitty', 'meow', 'penguin', 'pengu', 'frog', 'pepe', 'bird', 'monkey',
      'ape', 'hippo', 'capy', 'otter', 'wolf', 'bear', 'bull', 'goat', 'duck', 'fish', 'whale', 'moo',
    ],
  },
  {
    tag: 'culture',
    weight: 22,
    words: ['meme', 'wojak', 'chad', 'giga', 'moon', 'based', 'degen', 'gm', 'wagmi', 'chill', 'guy', 'fart', 'retard', 'jeet', 'cult'],
  },
  {
    tag: 'solana-native',
    weight: 18,
    words: ['sol', 'solana', 'bonk', 'wif', 'pump', 'jup', 'jito', 'saga', 'pumpfun'],
  },
  {
    tag: 'tech-finance',
    weight: 16,
    words: ['rwa', 'defi', 'desci', 'depin', 'zk', 'privacy', 'stake', 'yield', 'perp', 'casino', 'bet', 'game', 'gaming', 'gambl'],
  },
];

/** Words that mark a token as a clone, a test or an outright scam pitch */
const RED_FLAG_WORDS = ['test', 'testtoken', 'fake', 'scam', 'rug', 'honeypot', 'airdrop', 'free', 'giveaway', 'clone', 'copy', 'v2', '2.0'];

const SOCIAL_POINTS: Record<string, number> = { twitter: 12, x: 12, telegram: 8, discord: 4, tiktok: 6, youtube: 4, instagram: 4, github: 6 };
const MAX_SOCIAL_POINTS = 25;
const MAX_NARRATIVE_POINTS = 45;
const BASE_SCORE = 10;

function normalise(s?: string | null) {
  return (s || '').toLowerCase();
}

/** Symbols and names run words together ("pepecoin"), so substring matching is the right call there */
function hitsIn(haystack: string, words: string[]) {
  return words.filter((w) => haystack.includes(w));
}

export function scoreNarrative(input: NarrativeInput): NarrativeResult {
  const symbol = normalise(input.symbol);
  const name = normalise(input.name);
  const description = normalise(input.description).slice(0, 400);
  const identity = `${symbol} ${name}`;
  const haystack = `${identity} ${description}`;

  const notes: string[] = [];
  const tags: string[] = [];
  let score = BASE_SCORE;

  // 1. Narrative buckets — the strongest match pays full weight, each additional one adds a
  // little: a token that is both an AI *and* an animal play sits in two live narratives.
  const matched = NARRATIVE_TIERS.map((tier) => ({ tier, hits: hitsIn(haystack, tier.words) }))
    .filter((m) => m.hits.length > 0)
    .sort((a, b) => b.tier.weight - a.tier.weight);

  if (matched.length > 0) {
    let narrativePoints = matched[0].tier.weight;
    for (const m of matched.slice(1)) narrativePoints += 8;
    narrativePoints = Math.min(MAX_NARRATIVE_POINTS, narrativePoints);
    score += narrativePoints;
    for (const m of matched) tags.push(m.tier.tag);
    notes.push(`narasi ${matched.map((m) => `${m.tier.tag} (${m.hits.slice(0, 3).join('/')})`).join(' + ')} → +${narrativePoints}`);
  } else {
    notes.push('tidak ada narasi yang dikenali — token tanpa cerita');
  }

  // 2. Keywords the user is personally tracking count as a narrative of their own
  const extras = (input.extraKeywords || []).map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 2);
  const extraHits = hitsIn(haystack, extras);
  if (extraHits.length > 0) {
    score += 15;
    tags.push(`watchlist:${extraHits[0]}`);
    notes.push(`cocok dengan keyword kamu (${extraHits.slice(0, 3).join('/')}) → +15`);
  }

  // 3. Social surface — a narrative with nowhere to spread does not spread
  const socialTypes = [...new Set((input.socials || []).map((s) => normalise(s)))];
  let socialPoints = 0;
  for (const t of socialTypes) socialPoints += SOCIAL_POINTS[t] ?? 2;
  if ((input.websites || 0) > 0) socialPoints += 8;
  socialPoints = Math.min(MAX_SOCIAL_POINTS, socialPoints);
  score += socialPoints;
  notes.push(
    socialTypes.length || (input.websites || 0) > 0
      ? `sosial ${[...socialTypes, ...((input.websites || 0) > 0 ? ['website'] : [])].join('/')} → +${socialPoints}`
      : 'tidak ada sosial/website terdaftar → +0'
  );

  // 4. Someone is actively paying to push the story
  if ((input.boosts || 0) > 0) {
    score += 8;
    tags.push('boosted');
    notes.push(`DexScreener boost aktif (${input.boosts}) → +8`);
  }

  if (description.length >= 40) {
    score += 8;
    notes.push('deskripsi token terisi → +8');
  }

  // 5. Penalties
  const redFlags = hitsIn(identity, RED_FLAG_WORDS);
  if (redFlags.length > 0) {
    score -= 30;
    tags.push('red-flag');
    notes.push(`nama/simbol mengandung ${redFlags.join('/')} → −30`);
  }
  if (!symbol || symbol.length > 12) {
    score -= 8;
    notes.push('simbol kosong atau terlalu panjang → −8');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    tags,
    notes,
    narrative: matched[0]?.tier.tag ?? (extraHits.length ? `watchlist:${extraHits[0]}` : null),
  };
}

/** Parse the cockpit's comma-separated keyword field */
export function parseKeywords(raw?: string | null): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
