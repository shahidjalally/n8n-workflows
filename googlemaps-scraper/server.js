const express = require('express');
const { chromium } = require('playwright');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');
const pino = require('pino');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const config = {
  navigationTimeout: Number(process.env.SCRAPER_NAVIGATION_TIMEOUT || 45000),
  selectorTimeout: Number(process.env.SCRAPER_SELECTOR_TIMEOUT || 10000),
  maxRetries: Number(process.env.SCRAPER_MAX_RETRIES || 2),
  retryDelay: Number(process.env.SCRAPER_RETRY_DELAY || 1500),
  maxSearchResults: Number(process.env.SCRAPER_MAX_RESULTS || 12),
  detailPauseMs: Number(process.env.SCRAPER_DETAIL_PAUSE_MS || 900),
  scrollPauseMs: Number(process.env.SCRAPER_SCROLL_PAUSE_MS || 1000),
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanString(value) {
  const s = String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (/^(?:n\/?a|na|none|null|unknown|-|—)$/i.test(s)) return '';
  return s;
}

function cleanPhone(value) {
  const s = cleanString(value);
  if (!s) return '';
  const cleaned = s.replace(/[^0-9+]/g, '');
  if (!cleaned || cleaned.length < 7) return '';
  return cleaned;
}

function canonicalMapsUrl(value) {
  const s = cleanString(value);
  if (!s) return '';
  try {
    const u = new URL(s, 'https://www.google.com');
    if (!/google\.[^/]+$/i.test(u.hostname) && !u.hostname.endsWith('.google.com')) return s;
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return s;
  }
}

function coordinatesFromUrl(value) {
  const s = String(value || '');
  let m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/);
  if (m) return { latitude: Number(m[1]), longitude: Number(m[2]) };
  m = s.match(/!3d(-?\d+(?:\.\d+)?).*?!4d(-?\d+(?:\.\d+)?)/);
  if (m) return { latitude: Number(m[1]), longitude: Number(m[2]) };
  return { latitude: null, longitude: null };
}

class ScraperQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
  }

  async initialize() {
    logger.info('Initializing browser...');

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,1000',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 1000 },
      locale: 'en-PK',
      timezoneId: 'Asia/Karachi',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Accept-Language': 'en-PK,en;q=0.9',
      },
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.selectorTimeout);
    this.page.setDefaultNavigationTimeout(config.navigationTimeout);

    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.isInitialized = true;
    logger.info('Browser initialized successfully');
  }

  async ensureInitialized() {
    if (!this.isInitialized || !this.browser || !this.context || !this.page) {
      await this.initialize();
    }
  }

  async addToQueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      logger.info(`Task added to queue. Queue length: ${this.queue.length}`);
      void this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;
    const item = this.queue.shift();

    try {
      await this.ensureInitialized();
      logger.info(`Processing task. Remaining in queue: ${this.queue.length}`);
      const result = await this.executeTask(item.task);
      item.resolve(result);
    } catch (error) {
      logger.error({ err: error }, 'Task execution failed');
      item.reject(error);
    } finally {
      this.isProcessing = false;
      await this.resetPageAfterTask();
      if (this.queue.length > 0) setTimeout(() => void this.processQueue(), 250);
    }
  }

  async executeTask(task) {
    let lastError;

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      try {
        if (task.type === 'search') return await this.searchPlaces(task.data);
        if (task.type === 'details') return await this.getPlaceDetails(task.data);
        if (task.type === 'reviews') return await this.getPlaceReviews(task.data);
        throw new Error(`Unknown task type: ${task.type}`);
      } catch (error) {
        lastError = error;
        logger.warn(`Task failed (attempt ${attempt}/${config.maxRetries}): ${error.message}`);
        if (attempt < config.maxRetries) {
          await sleep(config.retryDelay * attempt);
          await this.recreatePage();
        }
      }
    }

    throw lastError || new Error('Task failed');
  }

  async acceptConsentIfPresent() {
    const selectors = [
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'button[aria-label*="Accept"]',
      'form button[type="submit"]',
    ];

    for (const selector of selectors) {
      try {
        const button = this.page.locator(selector).first();
        if (await button.isVisible({ timeout: 800 })) {
          await button.click({ timeout: 1500 });
          await this.page.waitForTimeout(1000);
          logger.info('Accepted Google consent page');
          return;
        }
      } catch {}
    }
  }

  async searchPlaces({ query, maxResults = 10 }) {
    const wanted = Math.max(1, Math.min(Number(maxResults) || 10, config.maxSearchResults));
    logger.info(`Searching places for: "${query}" (max ${wanted})`);

    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
    await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await this.acceptConsentIfPresent();

    try {
      await Promise.race([
        this.page.waitForSelector('[role="feed"]', { timeout: 10000 }),
        this.page.waitForSelector('h1', { timeout: 10000 }),
      ]);
    } catch {}

    await this.page.waitForTimeout(1500);

    let links = await this.collectSearchResultLinks(wanted);

    // Google sometimes opens a single business directly instead of a list.
    if (links.length === 0 && /\/maps\/place\//.test(this.page.url())) {
      links = [{
        title: '',
        url: canonicalMapsUrl(this.page.url()),
      }];
    }

    const results = [];
    for (const item of links.slice(0, wanted)) {
      try {
        const details = await this.extractPlaceFromUrl(item.url, item.title);
        if (details.title) results.push(details);
      } catch (error) {
        logger.warn(`Failed detail extraction for ${item.url}: ${error.message}`);
        if (item.title) {
          results.push({
            title: item.title,
            address: '',
            phone: '',
            email: '',
            whatsapp: '',
            website: '',
            rating: null,
            reviews: 0,
            category: '',
            googleMapsUrl: canonicalMapsUrl(item.url),
            url: canonicalMapsUrl(item.url),
            latitude: null,
            longitude: null,
          });
        }
      }
    }

    logger.info(`Extracted ${results.length} complete results`);

    return {
      query,
      totalResults: results.length,
      results,
      timestamp: new Date().toISOString(),
    };
  }

  async collectSearchResultLinks(maxResults) {
    const seen = new Map();
    let stableRounds = 0;
    let previousSize = 0;

    for (let round = 0; round < 18 && seen.size < maxResults; round++) {
      const found = await this.page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        const root = feed || document;
        const anchors = Array.from(root.querySelectorAll(
          'a.hfpxzc[href*="/maps/place/"], a[href*="/maps/place/"]'
        ));

        return anchors.map(a => ({
          url: a.href || a.getAttribute('href') || '',
          title:
            a.getAttribute('aria-label') ||
            a.querySelector('.fontHeadlineSmall')?.textContent?.trim() ||
            '',
        }));
      });

      for (const item of found) {
        const url = canonicalMapsUrl(item.url);
        if (!url || !url.includes('/maps/place/')) continue;
        if (!seen.has(url)) seen.set(url, { url, title: cleanString(item.title) });
      }

      if (seen.size >= maxResults) break;

      stableRounds = seen.size === previousSize ? stableRounds + 1 : 0;
      previousSize = seen.size;
      if (stableRounds >= 3) break;

      const scrolled = await this.page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        if (!feed) return false;
        feed.scrollTop = feed.scrollHeight;
        return true;
      });

      if (!scrolled) break;
      await this.page.waitForTimeout(config.scrollPauseMs);
    }

    return Array.from(seen.values()).slice(0, maxResults);
  }

  async extractPlaceFromUrl(url, fallbackTitle = '') {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.acceptConsentIfPresent();

    try {
      await this.page.waitForSelector('h1', { timeout: 8000 });
    } catch {}

    await this.page.waitForTimeout(config.detailPauseMs);

    const raw = await this.page.evaluate(() => {
      const textOf = selectors => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const value = el?.textContent?.replace(/\s+/g, ' ').trim();
          if (value) return value;
        }
        return '';
      };

      const attrOf = (selectors, attr) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const value = el?.getAttribute(attr);
          if (value) return value;
        }
        return '';
      };

      const title = textOf(['h1.DUwDvf', 'h1']);
      const category = textOf(['button.DkEaL', 'button[jsaction*="category"]']);

      let address = textOf([
        'button[data-item-id="address"] .Io6YTe',
        '[data-item-id="address"] .Io6YTe',
        'button[data-item-id="address"]',
        '[data-item-id="address"]',
      ]);

      if (!address) {
        const aria = attrOf(['button[data-item-id="address"]', '[data-item-id="address"]'], 'aria-label');
        address = aria.replace(/^Address:\s*/i, '');
      }

      let phone = textOf([
        'button[data-item-id^="phone:tel:"] .Io6YTe',
        '[data-item-id^="phone:tel:"] .Io6YTe',
        'button[data-tooltip="Copy phone number"] .Io6YTe',
      ]);

      if (!phone) {
        const phoneEl = document.querySelector('[data-item-id^="phone:tel:"]');
        const id = phoneEl?.getAttribute('data-item-id') || '';
        phone = id.replace(/^phone:tel:/, '');
      }

      let website = attrOf([
        'a[data-item-id="authority"]',
        'a[aria-label^="Website:"]',
        'a[data-tooltip="Open website"]',
      ], 'href');

      if (website && /google\./i.test(website)) website = '';

      const ratingText = textOf([
        'div.F7nice span[aria-hidden="true"]',
        'span.ceNzKf',
      ]);

      const reviewAria = attrOf([
        'div.F7nice span[aria-label*="review"]',
        'span[aria-label*="reviews"]',
      ], 'aria-label');

      const rating = Number((ratingText.match(/[0-5](?:[.,]\d+)?/) || [])[0]?.replace(',', '.')) || null;
      const reviewMatch = reviewAria.match(/([\d,.]+)\s+review/i);
      const reviews = reviewMatch
        ? Number(reviewMatch[1].replace(/[^0-9]/g, '')) || 0
        : 0;

      return {
        title,
        category,
        address,
        phone,
        website,
        rating,
        reviews,
        currentUrl: location.href,
      };
    });

    const googleMapsUrl = canonicalMapsUrl(raw.currentUrl || url);
    const coords = coordinatesFromUrl(raw.currentUrl || url);

    return {
      title: cleanString(raw.title) || cleanString(fallbackTitle),
      address: cleanString(raw.address),
      phone: cleanPhone(raw.phone),
      email: '',
      whatsapp: '',
      website: cleanString(raw.website),
      rating: raw.rating,
      reviews: Number(raw.reviews) || 0,
      category: cleanString(raw.category),
      googleMapsUrl,
      url: googleMapsUrl,
      latitude: coords.latitude,
      longitude: coords.longitude,
    };
  }

  async getPlaceDetails({ placeId, url }) {
    const target = cleanString(url) || cleanString(placeId);
    if (!target) throw new Error('url or placeId is required');
    if (/^https?:\/\//i.test(target)) return this.extractPlaceFromUrl(target);
    return this.extractPlaceFromUrl(`https://www.google.com/maps/place/${encodeURIComponent(target)}`);
  }

  async getPlaceReviews({ placeId, url, maxReviews = 10 }) {
    const target = cleanString(url) || cleanString(placeId);
    if (!target) throw new Error('url or placeId is required');

    const targetUrl = /^https?:\/\//i.test(target)
      ? target
      : `https://www.google.com/maps/place/${encodeURIComponent(target)}`;

    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await this.acceptConsentIfPresent();
    await this.page.waitForTimeout(1200);

    try {
      const reviewsButton = this.page.locator('button[aria-label*="Reviews"], button[jsaction*="pane.reviewChart.moreReviews"]').first();
      if (await reviewsButton.isVisible({ timeout: 2500 })) {
        await reviewsButton.click();
        await this.page.waitForTimeout(1200);
      }
    } catch {}

    const wanted = Math.max(1, Math.min(Number(maxReviews) || 10, 20));
    const reviews = await this.page.evaluate(limit => {
      const cards = Array.from(document.querySelectorAll('.jftiEf')).slice(0, limit);
      return cards.map(card => {
        const user = card.querySelector('.d4r55')?.textContent?.trim() || '';
        const ratingLabel = card.querySelector('.kvMYJc')?.getAttribute('aria-label') || '';
        const rating = Number((ratingLabel.match(/([0-5](?:\.\d+)?)/) || [])[1]) || 0;
        const date = card.querySelector('.rsqaWe')?.textContent?.trim() || '';
        const text = card.querySelector('.wiI7pd')?.textContent?.trim() || '';
        return { user, rating, date, text };
      });
    }, wanted);

    return {
      placeId: cleanString(placeId),
      url: canonicalMapsUrl(targetUrl),
      totalReviews: reviews.length,
      reviews,
      timestamp: new Date().toISOString(),
    };
  }

  async recreatePage() {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (!this.context || !this.browser) {
        this.isInitialized = false;
        await this.ensureInitialized();
        return;
      }
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(config.selectorTimeout);
      this.page.setDefaultNavigationTimeout(config.navigationTimeout);
    } catch (error) {
      logger.warn(`Failed to recreate page: ${error.message}`);
      this.isInitialized = false;
    }
  }

  async resetPageAfterTask() {
    try {
      if (this.context) await this.context.clearCookies();
      if (this.page && !this.page.isClosed()) await this.page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => {});
    } catch (error) {
      logger.warn(`Cleanup error: ${error.message}`);
    }
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    logger.info('Browser closed');
  }
}

let scraperQueue = null;

async function getQueue() {
  if (!scraperQueue) {
    scraperQueue = new ScraperQueue();
    await scraperQueue.initialize();
  }
  return scraperQueue;
}

app.post('/api/scrape/search', async (req, res) => {
  try {
    const query = cleanString(req.body?.query);
    const maxResults = Math.max(1, Math.min(Number(req.body?.maxResults) || 10, config.maxSearchResults));
    if (!query) return res.status(400).json({ success: false, error: 'query is required' });

    const queue = await getQueue();
    const result = await queue.addToQueue({ type: 'search', data: { query, maxResults } });
    return res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error(`Search API error: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scrape/details', async (req, res) => {
  try {
    const placeId = cleanString(req.body?.placeId);
    const url = cleanString(req.body?.url);
    if (!placeId && !url) return res.status(400).json({ success: false, error: 'placeId or url is required' });

    const queue = await getQueue();
    const result = await queue.addToQueue({ type: 'details', data: { placeId, url } });
    return res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error(`Details API error: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scrape/reviews', async (req, res) => {
  try {
    const placeId = cleanString(req.body?.placeId);
    const url = cleanString(req.body?.url);
    const maxReviews = Math.max(1, Math.min(Number(req.body?.maxReviews) || 10, 20));
    if (!placeId && !url) return res.status(400).json({ success: false, error: 'placeId or url is required' });

    const queue = await getQueue();
    const result = await queue.addToQueue({ type: 'reviews', data: { placeId, url, maxReviews } });
    return res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error(`Reviews API error: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    queueLength: scraperQueue?.queue?.length || 0,
    isProcessing: scraperQueue?.isProcessing || false,
    isInitialized: scraperQueue?.isInitialized || false,
    maxSearchResults: config.maxSearchResults,
    timestamp: new Date().toISOString(),
  });
});

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down...`);
  if (scraperQueue) await scraperQueue.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app.listen(PORT, () => {
  logger.info(`Google Maps Scraper server running on port ${PORT}`);
  logger.info(`Headless mode: enabled`);
  logger.info(`Single-threaded queue: enabled`);
  logger.info(`Max results per search: ${config.maxSearchResults}`);
});

module.exports = app;
