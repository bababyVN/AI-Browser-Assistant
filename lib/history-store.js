/**
 * lib/history-store.js — Browsing History Vector Store (IndexedDB)
 * Stores visited pages with TF-IDF search capability.
 * Uses raw IndexedDB API — no dependencies.
 */

const DB_NAME = 'ai_assistant_history';
const DB_VERSION = 1;
const STORE_NAME = 'pages';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(new Error('Failed to open history database'));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('title', 'title', { unique: false });
      }
    };
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Tokenize for TF-IDF search (matches rag.js pattern)
 */
const STOP_WORDS = new Set(['the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may','might',
  'to','of','in','for','on','with','at','by','from','as','into','through','during',
  'before','after','above','below','between','out','off','over','under','again','then',
  'here','there','when','where','why','how','all','both','each','few','more','most',
  'other','some','such','no','nor','not','only','own','same','so','than','too','very',
  'just','because','but','and','or','if','while','this','that','these','those','it',
  'its','i','me','my','we','our','you','your','he','him','his','she','her','they',
  'them','their','what','which','who','whom','s','t','re','ve','ll','d']);

function tokenize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function textSimilarity(queryTokens, docTokens) {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const docSet = new Set(docTokens);
  let matches = 0;
  for (const t of queryTokens) if (docSet.has(t)) matches++;
  return matches / Math.max(queryTokens.length, 1);
}

export class VectorHistoryStore {
  constructor() {
    this._db = null;
  }

  async _getDB() {
    if (!this._db) this._db = await openDB();
    return this._db;
  }

  /**
   * Add or update a page entry in the history store.
   */
  async addEntry(url, title, description) {
    if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
    try {
      const db = await this._getDB();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry = {
        url,
        title: title || '',
        description: description || '',
        tokens: tokenize(`${title} ${description} ${url}`),
        timestamp: Date.now()
      };
      await idbRequest(store.put(entry));
    } catch (err) {
      console.warn('[HistoryStore] Failed to add entry:', err.message);
    }
  }

  /**
   * Search history using TF-IDF-style text matching.
   * Returns top matches sorted by relevance.
   */
  async search(query, options = {}) {
    const { limit = 10, from, to } = options;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    try {
      const db = await this._getDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const allEntries = await idbRequest(store.getAll());

      let filtered = allEntries;
      if (from) filtered = filtered.filter(e => e.timestamp >= new Date(from).getTime());
      if (to) filtered = filtered.filter(e => e.timestamp <= new Date(to).getTime());

      const scored = filtered.map(entry => ({
        url: entry.url,
        title: entry.title,
        description: entry.description,
        timestamp: new Date(entry.timestamp).toISOString(),
        score: textSimilarity(queryTokens, entry.tokens || tokenize(`${entry.title} ${entry.description}`))
      }));

      return scored
        .filter(e => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (err) {
      console.warn('[HistoryStore] Search failed:', err.message);
      return [];
    }
  }

  /**
   * Get stats about the history store.
   */
  async getStats() {
    try {
      const db = await this._getDB();
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const count = await idbRequest(store.count());
      return { totalEntries: count };
    } catch {
      return { totalEntries: 0 };
    }
  }
}
