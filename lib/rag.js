/**
 * lib/rag.js — Local RAG Engine (TF-IDF + Cosine Similarity)
 * Pure JavaScript. Zero dependencies. Runs in service worker.
 * Indexes page content into chunks and retrieves the most relevant
 * ones for a query — much smarter than keyword matching.
 */

// ─── Stop Words ──────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','shall','can',
  'need','dare','ought','used','to','of','in','for','on','with','at','by','from',
  'as','into','through','during','before','after','above','below','between','out',
  'off','over','under','again','further','then','once','here','there','when',
  'where','why','how','all','both','each','few','more','most','other','some',
  'such','no','nor','not','only','own','same','so','than','too','very','just',
  'because','but','and','or','if','while','this','that','these','those','it',
  'its','i','me','my','we','our','you','your','he','him','his','she','her',
  'they','them','their','what','which','who','whom','s','t','re','ve','ll','d'
]);

// ─── Tokenizer ───────────────────────────────────────────────────────
/**
 * Tokenize text into normalized, meaningful words.
 * Removes stop words and short tokens.
 */
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ─── TF-IDF Builder ──────────────────────────────────────────────────
/**
 * Compute term frequency for a single document (chunk).
 * Returns Map<term, tf> where tf is normalized by doc length.
 */
function computeTF(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const len = tokens.length || 1;
  tf.forEach((v, k) => tf.set(k, v / len));
  return tf;
}

/**
 * Compute IDF for all terms across all chunks.
 * Returns Map<term, idf>.
 */
function computeIDF(tokenizedChunks) {
  const df = new Map();
  const N = tokenizedChunks.length;
  for (const tokens of tokenizedChunks) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  df.forEach((count, term) => {
    idf.set(term, Math.log((N + 1) / (count + 1)) + 1); // Smoothed IDF
  });
  return idf;
}

/**
 * Build TF-IDF vector for a tokenized document.
 * Returns Map<term, tfidf>.
 */
function buildTFIDFVector(tokens, idf) {
  const tf = computeTF(tokens);
  const vec = new Map();
  tf.forEach((tfVal, term) => {
    const idfVal = idf.get(term) || Math.log(2); // Unknown terms get a default IDF
    vec.set(term, tfVal * idfVal);
  });
  return vec;
}

// ─── Cosine Similarity ───────────────────────────────────────────────
/**
 * Cosine similarity between two TF-IDF vectors.
 * Returns a score in [0, 1].
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0, normA = 0, normB = 0;
  vecA.forEach((val, term) => {
    dot += val * (vecB.get(term) || 0);
    normA += val * val;
  });
  vecB.forEach(val => { normB += val * val; });
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Chunker ─────────────────────────────────────────────────────────
/**
 * Split page content into overlapping chunks for indexing.
 * Tries to split at sentence boundaries. Each chunk ~150-250 chars.
 * Prepends the current section heading for context.
 */
function chunkContent(fullContent) {
  const chunks = [];
  const sections = fullContent.split(/\n(?=## )/);

  for (const section of sections) {
    // Extract heading from section
    const headingMatch = section.match(/^## ([^\n]+)/);
    const heading = headingMatch ? headingMatch[1].replace(/\s*\[.*?\]\s*$/, '').trim() : '';
    const body = section.replace(/^## [^\n]+\n/, '').trim();

    if (!body) continue;

    // Split body into sentences
    const sentences = body
      .replace(/([.!?])\s+/g, '$1\n')
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 15);

    // Group sentences into chunks of ~200 chars with 1-sentence overlap
    let current = heading ? `[${heading}] ` : '';
    let prevSentence = '';

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      if (current.length + sentence.length < 250) {
        current += sentence + ' ';
      } else {
        if (current.trim().length > 30) {
          chunks.push(current.trim());
        }
        // Start next chunk with overlap (previous sentence for context)
        current = (heading ? `[${heading}] ` : '') + prevSentence + ' ' + sentence + ' ';
      }
      prevSentence = sentence;
    }
    if (current.trim().length > 30) {
      chunks.push(current.trim());
    }
  }

  return chunks;
}

// ─── LocalRAG Class ──────────────────────────────────────────────────
/**
 * Local TF-IDF RAG engine.
 * Index a page once, then search many times — all in memory, instant.
 */
export class LocalRAG {
  constructor() {
    /** @type {Map<string, { chunks: string[], vectors: Map[], idf: Map, timestamp: number }>} */
    this.pageIndex = new Map();
    this.MAX_PAGES = 20; // Max pages to keep in memory
  }

  /**
   * Index a page's full content.
   * Splits into chunks, builds TF-IDF vectors, stores by URL.
   * Safe to call multiple times — will re-index if content changed.
   * @param {string} url - Page URL (used as cache key)
   * @param {string} fullContent - Full page text (from EXTRACT_PAGE)
   */
  indexPage(url, fullContent) {
    if (!fullContent || !url) return;

    const chunks = chunkContent(fullContent);
    if (chunks.length === 0) return;

    const tokenizedChunks = chunks.map(c => tokenize(c));
    const idf = computeIDF(tokenizedChunks);
    const vectors = tokenizedChunks.map(tokens => buildTFIDFVector(tokens, idf));

    // Evict oldest pages if at limit
    if (this.pageIndex.size >= this.MAX_PAGES) {
      const oldest = [...this.pageIndex.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.pageIndex.delete(oldest[0]);
    }

    this.pageIndex.set(url, {
      chunks,
      vectors,
      idf,
      timestamp: Date.now(),
      chunkCount: chunks.length
    });
  }

  /**
   * Search the indexed page for chunks most relevant to the query.
   * Returns top-K chunks sorted by cosine similarity score.
   * Falls back to [] if page not indexed or no good matches.
   *
   * @param {string} url - Page URL to search
   * @param {string} query - User's question or search query
   * @param {number} topK - Number of chunks to return (default: 3)
   * @param {number} minScore - Minimum similarity threshold (default: 0.05)
   * @returns {{ text: string, score: number, index: number }[]}
   */
  search(url, query, topK = 3, minScore = 0.05) {
    const index = this.pageIndex.get(url);
    if (!index || !query) return [];

    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    // Build query vector using the page's IDF (for consistent scoring)
    const queryVector = buildTFIDFVector(queryTokens, index.idf);

    // Score each chunk
    const scored = index.vectors.map((vec, i) => ({
      text: index.chunks[i],
      score: cosineSimilarity(queryVector, vec),
      index: i
    }));

    // Sort by score, filter low scores, return top-K
    return scored
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Check if a page URL is already indexed.
   * @param {string} url
   * @returns {boolean}
   */
  isIndexed(url) {
    return this.pageIndex.has(url);
  }

  /**
   * Get stats for debugging (shown in budget/status if needed).
   */
  getStats() {
    return {
      pagesIndexed: this.pageIndex.size,
      pages: [...this.pageIndex.entries()].map(([url, d]) => ({
        url: url.substring(0, 50),
        chunks: d.chunkCount,
        age: Math.round((Date.now() - d.timestamp) / 1000) + 's'
      }))
    };
  }
}
