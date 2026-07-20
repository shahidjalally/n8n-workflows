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
const PORT = process.env.PORT || 3000;

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

app.use(helmet());
app.use(compression());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const positiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const config = {
  // Page crashes must recycle the full browser process; retrying a crashed Page
  // instance (the old behaviour) can never recover.
  maxRetries: positiveInt(process.env.MAX_RETRIES, 3),
  retryDelay: positiveInt(process.env.RETRY_DELAY, 3000),
  timeout: positiveInt(process.env.TIMEOUT, 60000),
  headless: process.env.HEADLESS !== 'false',
};

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
    try {
      logger.info('Initializing browser...');

      this.browser = await chromium.launch({
        headless: config.headless,
        // Keep this list deliberately small. Several conflicting rendering and
        // isolation flags in the previous configuration caused Chromium page
        // processes to crash under container memory pressure.
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--no-first-run',
          '--no-zygote',
          '--window-size=1280,720',
        ]
      });

      this.context = await this.browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      // Maps result text is enough for this service. Avoid downloading images,
      // media and fonts, which materially lowers renderer memory usage.
      await this.context.route('**/*', route => {
        const type = route.request().resourceType();
        return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
      });

      this.page = await this.context.newPage();

      await this.page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
      });

      this.isInitialized = true;
      logger.info('Browser initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize browser:', error.message);
      this.isInitialized = false;
      throw error;
    }
  }

  async handleConsentAndSearch() {
    try {
      const isConsentPage = await this.page.evaluate(() => {
        return document.title.includes('fortsätter') ||
               document.title.includes('continue') ||
               document.title.includes('consent');
      });

      if (isConsentPage) {
        logger.info('Consent page detected. Accepting...');
        const consentSelectors = [
          'button:has-text("Accept all")',
          'button:has-text("Accept")',
          'button:has-text("Godkänn alla")',
          'button:has-text("Godkänn")',
          'button[aria-label*="Accept"]',
          'form button[type="submit"]'
        ];

        for (const selector of consentSelectors) {
          try {
            const button = await this.page.waitForSelector(selector, { timeout: 2000 });
            if (button) {
              await button.click();
              logger.info(`Clicked consent button`);
              await this.page.waitForTimeout(3000);
              break;
            }
          } catch (e) {}
        }
        await this.page.waitForTimeout(2000);
      }

      let searchBox = null;
      const searchSelectors = [
        'input[aria-label="Search"]',
        'input[aria-label="Sök"]',
        'input[placeholder="Search"]',
        'input[placeholder="Sök"]',
        '#searchboxinput',
        'input[role="combobox"]',
        'input[type="text"]:not([hidden])'
      ];

      for (const selector of searchSelectors) {
        try {
          searchBox = await this.page.waitForSelector(selector, { timeout: 2000 });
          if (searchBox && await searchBox.isVisible()) {
            logger.info(`Found search box`);
            break;
          }
        } catch (e) {}
      }

      if (!searchBox) {
        await this.page.screenshot({ path: '/tmp/no-searchbox.png' });
        throw new Error('Search box not found');
      }

      return searchBox;
    } catch (error) {
      logger.error('Error in handleConsentAndSearch:', error.message);
      throw error;
    }
  }

  async ensureInitialized() {
    if (!this.isInitialized || !this.browser || !this.browser.isConnected() || !this.page || this.page.isClosed()) {
      logger.info('Initializing a fresh browser process...');
      await this.resetBrowser();
    }
    return this.isInitialized;
  }

  isBrowserCrash(error) {
    return /page crashed|target page, context or browser has been closed|browser has been closed|connection closed/i.test(String(error?.message || error));
  }

  async resetBrowser() {
    const oldBrowser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    if (oldBrowser) {
      try { await oldBrowser.close(); } catch (error) { logger.warn(`Browser close during reset failed: ${error.message}`); }
    }
    await this.initialize();
  }

  async addToQueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject, timestamp: Date.now() });
      logger.info(`Task added to queue. Queue length: ${this.queue.length}`);
      this.processQueue();
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
      logger.error('Task execution failed:', error.message);
      item.reject(error);
    } finally {
      this.isProcessing = false;
      await this.cleanupPage();
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), 500);
      }
    }
  }

  async executeTask(task) {
    const { type, data } = task;
    let retries = 0;

    while (retries < config.maxRetries) {
      try {
        switch (type) {
          case 'search': return await this.searchPlaces(data);
          case 'details': return await this.getPlaceDetails(data);
          case 'reviews': return await this.getPlaceReviews(data);
          default: throw new Error(`Unknown task type: ${type}`);
        }
      } catch (error) {
        retries++;
        logger.warn(`Task failed (attempt ${retries}/${config.maxRetries}):`, error.message);
        if (retries < config.maxRetries) {
          await this.sleep(config.retryDelay * retries);
          // A page crash invalidates the entire Playwright target. Recreate the
          // browser instead of reloading the broken page.
          if (this.isBrowserCrash(error)) await this.resetBrowser();
          else await this.refreshPage();
        } else {
          throw error;
        }
      }
    }
  }

  async searchPlaces({ query, maxResults = 20 }) {
    if (!this.page) throw new Error('Page not initialized');

    logger.info(`Searching places for: "${query}"`);

    try {
      await this.page.goto('https://www.google.com/maps', {
        timeout: config.timeout,
        waitUntil: 'domcontentloaded'
      });

      await this.page.waitForTimeout(5000);

      const searchBox = await this.handleConsentAndSearch();

      await searchBox.click();
      await this.page.waitForTimeout(500);
      await searchBox.fill(query);
      await this.page.waitForTimeout(500);
      await this.page.keyboard.press('Enter');

      await this.page.waitForTimeout(8000);

      // Extract results with full details including phone numbers
      const results = await this.extractCompleteResults();

      logger.info(`Extracted ${results.length} results with contact info`);

      if (results.length === 0) {
        await this.page.screenshot({ path: '/tmp/no-results.png' });
        logger.warn('No results found');
      }

      return {
        query,
        totalResults: results.length,
        results: results.slice(0, maxResults),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('Search error:', error.message);
      throw error;
    }
  }

  async extractCompleteResults() {
    return await this.page.evaluate(() => {
      const results = [];

      // Find all business cards in the search results
      // Based on your screenshot, the structure has these elements
      const cards = document.querySelectorAll('[role="feed"] > div > div > a, [role="feed"] > div > a, [role="feed"] > div');

      cards.forEach((card, index) => {
        try {
          // Try to find the business name
          let title = '';
          const titleSelectors = [
            '.fontHeadlineSmall',
            '.NrDZNb',
            '.qBF1w',
            'h2',
            'h3',
            '[class*="title"]',
            '[class*="name"]',
            '[role="heading"]'
          ];

          for (const selector of titleSelectors) {
            const el = card.querySelector(selector);
            if (el) {
              title = el.textContent?.trim() || '';
              if (title) break;
            }
          }

          if (!title || title.length < 2) return;

          // Get the full text content of the card
          const fullText = card.textContent || '';

          // Extract phone number using regex - matches formats like:
          // +92 333 4102103, 0303 8038038, 0300-1234567, etc.
          const phoneRegex = /(?:\+92|0[0-9]{2,3})[-.\s]?[0-9]{3,4}[-.\s]?[0-9]{4,7}/g;
          const phoneMatches = fullText.match(phoneRegex);
          let phone = phoneMatches && phoneMatches.length > 0 ? phoneMatches[0].trim() : '';

          // Clean phone number
          if (phone) {
            phone = phone.replace(/[^0-9+]/g, '');
          }

          // Extract WhatsApp - look for WhatsApp mentions with number
          let whatsapp = '';
          const whatsappRegex = /whatsapp[:\s]*([0-9+\-.\s]+)/i;
          const whatsappMatch = fullText.match(whatsappRegex);
          if (whatsappMatch) {
            whatsapp = whatsappMatch[1].trim().replace(/[^0-9+]/g, '');
          }

          // Extract email
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const emailMatch = fullText.match(emailRegex);
          let email = emailMatch && emailMatch.length > 0 ? emailMatch[0] : '';

          // Extract address
          let address = '';
          const addressSelectors = [
            '.fontBodyMedium > span:last-child',
            '.W4Efsd:nth-child(2)',
            '[class*="address"]',
            '[class*="location"]'
          ];

          for (const selector of addressSelectors) {
            const el = card.querySelector(selector);
            if (el) {
              address = el.textContent?.trim() || '';
              if (address) break;
            }
          }

          // If no address found via selectors, try to extract from text
          if (!address) {
            const lines = fullText.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            // Address often contains numbers and street names
            for (const line of lines) {
              if (line.match(/\d+\s+\w+/) || line.match(/[A-Z]{2,}\s+\d{5}/)) {
                address = line;
                break;
              }
            }
          }

          // Extract rating
          let rating = 0;
          const ratingSelectors = ['.MW4etd', '.lI5VU', '[class*="rating"]'];
          for (const selector of ratingSelectors) {
            const el = card.querySelector(selector);
            if (el) {
              const ratingText = el.textContent?.trim() || '';
              const ratingMatch = ratingText.match(/([\d.]+)/);
              if (ratingMatch) {
                rating = parseFloat(ratingMatch[1]) || 0;
                break;
              }
            }
          }

          // Extract reviews count
          let reviews = 0;
          const reviewsSelectors = ['.UY7F9', '.yi40Hd', '[class*="reviews"]'];
          for (const selector of reviewsSelectors) {
            const el = card.querySelector(selector);
            if (el) {
              const reviewsText = el.textContent?.trim() || '';
              const reviewsMatch = reviewsText.match(/([\d,]+)/);
              if (reviewsMatch) {
                reviews = parseInt(reviewsMatch[1].replace(/,/g, '')) || 0;
                break;
              }
            }
          }

          // Extract website link
          let website = '';
          const websiteLink = card.querySelector('a[href^="http"]:not([href*="google"])');
          if (websiteLink) {
            website = websiteLink.getAttribute('href') || '';
          }

          // Get place ID from the link
          const link = card.querySelector('a[href*="/place/"]');
          let placeId = '';
          if (link) {
            const href = link.getAttribute('href') || '';
            const placeMatch = href.match(/place\/([^\/]+)/);
            if (placeMatch) {
              placeId = placeMatch[1];
            }
          }

          results.push({
            title: title,
            address: address || 'N/A',
            phone: phone || 'N/A',
            email: email || 'N/A',
            whatsapp: whatsapp || 'N/A',
            website: website || 'N/A',
            rating: rating,
            reviews: reviews,
            placeId: placeId,
            // Store full text for debugging
            _fullText: fullText.substring(0, 200)
          });

        } catch (e) {
          // Skip this card if there's an error
        }
      });

      return results;
    });
  }

  async getPlaceDetails({ placeId }) {
    if (!this.page) throw new Error('Page not initialized');

    logger.info(`Getting details for place: ${placeId}`);

    try {
      // Instead of scraping the details page, just use the search results
      // which already have all the info we need
      const results = await this.extractCompleteResults();

      // Find the matching result
      const match = results.find(r => r.placeId === placeId);

      if (match) {
        return { ...match, timestamp: new Date().toISOString() };
      }

      // If not found in current results, go to the place page
      await this.page.goto(`https://www.google.com/maps/place/${placeId}`, {
        timeout: config.timeout,
        waitUntil: 'domcontentloaded'
      });

      await this.page.waitForTimeout(5000);
      await this.handleConsentAndSearch();
      await this.page.waitForTimeout(3000);

      // Extract details from the page
      const details = await this.page.evaluate((pid) => {
        const getText = (selectors) => {
          if (typeof selectors === 'string') selectors = [selectors];
          for (const selector of selectors) {
            try {
              const el = document.querySelector(selector);
              if (el) {
                const text = el.textContent?.trim();
                if (text && text.length > 0) return text;
              }
            } catch (e) {}
          }
          return '';
        };

        const pageText = document.body?.innerText || '';

        // Extract phone
        const phoneRegex = /(?:\+92|0[0-9]{2,3})[-.\s]?[0-9]{3,4}[-.\s]?[0-9]{4,7}/g;
        const phoneMatches = pageText.match(phoneRegex);
        let phone = phoneMatches && phoneMatches.length > 0 ? phoneMatches[0].trim() : '';
        if (phone) phone = phone.replace(/[^0-9+]/g, '');

        // Extract email
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const emailMatch = pageText.match(emailRegex);
        let email = emailMatch && emailMatch.length > 0 ? emailMatch[0] : '';

        // Extract WhatsApp
        let whatsapp = '';
        const whatsappRegex = /whatsapp[:\s]*([0-9+\-.\s]+)/i;
        const whatsappMatch = pageText.match(whatsappRegex);
        if (whatsappMatch) {
          whatsapp = whatsappMatch[1].trim().replace(/[^0-9+]/g, '');
        }

        // Check for WhatsApp links
        const whatsappLink = document.querySelector('a[href*="wa.me"], a[href*="api.whatsapp"]');
        if (whatsappLink) {
          const href = whatsappLink.getAttribute('href');
          if (href) {
            const match = href.match(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)(\d+)/);
            if (match) whatsapp = match[1];
          }
        }

        // Get website
        let website = '';
        const websiteEl = document.querySelector('[data-item-id="authority"], a[aria-label*="Website"], a[href^="http"]:not([href*="google"])');
        if (websiteEl && websiteEl.tagName === 'A') {
          const href = websiteEl.getAttribute('href');
          if (href && href.startsWith('http') && !href.includes('google.com')) {
            website = href;
          }
        }

        return {
          title: getText(['h1', '[role="heading"]']) || 'N/A',
          address: getText(['[data-item-id="address"]', '[aria-label*="Address"]']) || 'N/A',
          phone: phone || 'N/A',
          email: email || 'N/A',
          whatsapp: whatsapp || 'N/A',
          website: website || 'N/A',
          placeId: pid
        };
      }, placeId);

      return { ...details, timestamp: new Date().toISOString() };
    } catch (error) {
      logger.error('Error getting place details:', error.message);
      throw error;
    }
  }

  async getPlaceReviews({ placeId, maxReviews = 10 }) {
    if (!this.page) throw new Error('Page not initialized');

    logger.info(`Getting reviews for place: ${placeId}`);

    await this.page.goto(`https://www.google.com/maps/place/${placeId}`, {
      timeout: config.timeout,
      waitUntil: 'domcontentloaded'
    });

    await this.page.waitForTimeout(5000);
    await this.handleConsentAndSearch();
    await this.page.waitForTimeout(2000);

    try {
      const reviewsTab = await this.page.waitForSelector('button[aria-label*="Reviews"]', {
        timeout: 10000
      });
      await reviewsTab.click();
      await this.page.waitForTimeout(3000);
    } catch (e) {
      logger.warn('Could not find reviews tab:', e.message);
    }

    const reviews = await this.page.evaluate(() => {
      const items = document.querySelectorAll('.jftiEf, .gws-localreviews__review');
      return Array.from(items).slice(0, 10).map(item => {
        const user = item.querySelector('.d4r55, .TSUbDb')?.textContent?.trim() || '';
        const rating = item.querySelector('.kvMYJc')?.getAttribute('aria-label')?.match(/(\d+)/)?.[1] || '';
        const date = item.querySelector('.rsqaWe, .dehysf')?.textContent?.trim() || '';
        const text = item.querySelector('.wiI7pd, .Jtu6Td')?.textContent?.trim() || '';

        return { user, rating: parseInt(rating) || 0, date, text };
      });
    });

    return {
      placeId,
      totalReviews: reviews.length,
      reviews,
      timestamp: new Date().toISOString()
    };
  }

  async refreshPage() {
    try {
      if (this.page) {
        await this.page.reload({ waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000);
      }
    } catch (error) {
      logger.warn('Failed to refresh page:', error);
    }
  }

  async cleanupPage() {
    try {
      if (this.context) {
        await this.context.clearCookies();
      }
    } catch (error) {
      logger.warn('Cleanup error:', error);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isInitialized = false;
    if (browser) await browser.close();
    logger.info('Browser closed');
  }
}

let scraperQueue = null;

app.get('/health', (req, res) => {
  res.json({
    success: true,
    browserConnected: Boolean(scraperQueue?.browser?.isConnected()),
    queueLength: scraperQueue?.queue.length || 0,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/scrape/search', async (req, res) => {
  try {
    const { query, maxResults = 10 } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: 'Query parameter is required' });
    }

    if (!scraperQueue) {
      scraperQueue = new ScraperQueue();
      await scraperQueue.initialize();
    }

    const result = await scraperQueue.addToQueue({
      type: 'search',
      data: { query, maxResults: Math.min(maxResults, 20) }
    });

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Search API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scrape/details', async (req, res) => {
  try {
    const { placeId } = req.body;

    if (!placeId) {
      return res.status(400).json({ success: false, error: 'PlaceId parameter is required' });
    }

    if (!scraperQueue) {
      scraperQueue = new ScraperQueue();
      await scraperQueue.initialize();
    }

    const result = await scraperQueue.addToQueue({
      type: 'details',
      data: { placeId }
    });

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Details API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/scrape/reviews', async (req, res) => {
  try {
    const { placeId, maxReviews = 10 } = req.body;

    if (!placeId) {
      return res.status(400).json({ success: false, error: 'PlaceId parameter is required' });
    }

    if (!scraperQueue) {
      scraperQueue = new ScraperQueue();
      await scraperQueue.initialize();
    }

    const result = await scraperQueue.addToQueue({
      type: 'reviews',
      data: { placeId, maxReviews: Math.min(maxReviews, 20) }
    });

    res.json({ success: true, data: result, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Reviews API error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    queueLength: scraperQueue ? scraperQueue.queue.length : 0,
    isProcessing: scraperQueue ? scraperQueue.isProcessing : false,
    isInitialized: scraperQueue ? scraperQueue.isInitialized : false,
    timestamp: new Date().toISOString()
  });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down...');
  if (scraperQueue) await scraperQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down...');
  if (scraperQueue) await scraperQueue.close();
  process.exit(0);
});

app.listen(PORT, () => {
  logger.info(`Google Maps Scraper server running on port ${PORT}`);
  logger.info('Headless mode: enabled');
  logger.info('Single-threaded mode: enabled');
});

module.exports = app;
