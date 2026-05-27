'use strict';

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const cheerio = require('cheerio');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const dns     = require('dns').promises;
const net     = require('net');
const { put, list } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

const CARD_W = 1200;
const CARD_H = 630;
const USE_BLOB_STORAGE = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const MAX_BATCH_SIZE = 10;

// ─── Ensure directories exist ─────────────────────────────────────────────────
for (const dir of USE_BLOB_STORAGE ? ['public'] : ['uploads', 'generated', 'public']) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
}

// ─── Card metadata store ──────────────────────────────────────────────────────
// Local development keeps data on disk. Vercel persists public card assets and
// non-sensitive display metadata in Blob so X can access links after cold starts.
const CARDS_CACHE = {};
const CARDS_FILE  = path.join(__dirname, 'cards.json');

if (!USE_BLOB_STORAGE) {
  try {
    Object.assign(CARDS_CACHE, JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')));
  } catch { /* fresh start */ }
}

async function loadCard(id) {
  if (!USE_BLOB_STORAGE) return CARDS_CACHE[id] || null;

  const pathname = `cards/${id}.json`;
  const result = await list({ prefix: pathname, limit: 1 });
  const metadataBlob = result.blobs.find(blob => blob.pathname === pathname);
  if (!metadataBlob) return null;

  const response = await axios.get(metadataBlob.url, { timeout: 8000 });
  return response.data;
}

async function saveCard(id, meta) {
  const storedMeta = { ...meta, created_at: new Date().toISOString() };

  if (USE_BLOB_STORAGE) {
    const publicMeta = {
      image_path: storedMeta.image_path,
      overlay_mode: storedMeta.overlay_mode,
      duration: storedMeta.duration,
      twitter_site: storedMeta.twitter_site || '',
      created_at: storedMeta.created_at,
    };
    await put(`cards/${id}.json`, JSON.stringify(publicMeta), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 60,
    });
    return;
  }

  CARDS_CACHE[id] = storedMeta;
  try { fs.writeFileSync(CARDS_FILE, JSON.stringify(CARDS_CACHE, null, 2)); }
  catch { /* local generation remains available even if persistence fails */ }
}

function baseUrl(req) {
  // Allow override via env (needed when deployed behind a proxy)
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // needed behind Railway / Cloudflare reverse proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',   express.static(path.join(__dirname, 'uploads')));
app.use('/generated', express.static(path.join(__dirname, 'generated')));

function requireGeneratorKey(req, res, next) {
  const requiredKey = process.env.GENERATOR_KEY;
  if (!requiredKey || req.get('x-generator-key') === requiredKey) return next();
  return res.status(401).json({ success: false, error: 'Invalid generator access key.' });
}

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = USE_BLOB_STORAGE
  ? multer.memoryStorage()
  : multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename:    (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `up_${uuidv4()}${ext}`);
    },
  });
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(file.mimetype);
    cb(null, ok);
  },
});

// ─── Outbound URL safety and web scraping ─────────────────────────────────────
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 192 && b === 0 || a === 192 && b === 0 && c === 2 ||
      a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a >= 224;
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized === '::' || normalized === '::1' ||
        normalized.startsWith('fc') || normalized.startsWith('fd') ||
        /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8:')) {
      return true;
    }
    if (normalized.startsWith('::ffff:')) {
      return isPrivateAddress(normalized.slice(7));
    }
  }

  return false;
}

async function assertPublicHttpUrl(rawUrl) {
  let target;
  try { target = new URL(rawUrl); }
  catch { throw new Error('Invalid URL.'); }

  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')) {
    throw new Error('Local network URLs are not allowed.');
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });

  if (addresses.length === 0 || addresses.some(result => isPrivateAddress(result.address))) {
    throw new Error('Private network URLs are not allowed.');
  }

  return target.href;
}

async function getPublicResource(rawUrl, options) {
  let currentUrl = rawUrl;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
    currentUrl = await assertPublicHttpUrl(currentUrl);
    const response = await axios.get(currentUrl, {
      ...options,
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400,
    });

    if (response.status >= 300) {
      const location = response.headers.location;
      if (!location || redirectCount === 5) throw new Error('Too many redirects.');
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    return response;
  }

  throw new Error('Could not fetch URL.');
}

async function scrapePageMeta(pageUrl) {
  const response = await getPublicResource(pageUrl, {
    timeout: 8000,
    maxContentLength: 2 * 1024 * 1024,
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  const $ = cheerio.load(response.data);

  const title =
    $('meta[name="twitter:title"]').attr('content') ||
    $('meta[property="og:title"]').attr('content')  ||
    $('title').text().trim()                        ||
    '';

  let imageUrl =
    $('meta[name="twitter:image"]').attr('content')     ||
    $('meta[property="og:image"]').attr('content')      ||
    $('video[poster]').first().attr('poster')            ||
    null;

  // Fall back to first sufficiently large <img>
  if (!imageUrl) {
    const candidates = [];
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || src.startsWith('data:')) return;
      const w = parseInt($(el).attr('width')  || '0', 10);
      const h = parseInt($(el).attr('height') || '0', 10);
      candidates.push({ src, w, h });
    });
    const large = candidates.find(c => c.w >= 300 || c.h >= 200);
    const first = candidates[0];
    imageUrl = (large || first)?.src || null;
  }

  // Resolve relative URL
  if (imageUrl) {
    try { imageUrl = new URL(imageUrl, pageUrl).href; }
    catch { imageUrl = null; }
  }

  return { title, imageUrl };
}

// ─── Download image buffer ────────────────────────────────────────────────────
async function downloadImage(url) {
  const res = await getPublicResource(url, {
    responseType: 'arraybuffer',
    timeout: 8000,
    maxContentLength: 20 * 1024 * 1024,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; TwitterCardBot/1.0)',
      'Accept':     'image/*,*/*;q=0.8',
    },
  });
  return Buffer.from(res.data);
}

// ─── SVG overlay ─────────────────────────────────────────────────────────────
function xmlEscape(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// ─── Random video duration ────────────────────────────────────────────────────
function randomDuration() {
  // Range: 00:00:10 → 02:00:00, always HH:MM:SS
  const totalSecs = Math.floor(Math.random() * (7200 - 10 + 1)) + 10;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function buildOverlaySvg(w, h, mode, duration) {
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const R  = 68;

  // ── Center play/pause icon ────────────────────────────────────────────────
  let icon;
  if (mode === 'pause') {
    const barH = 48, barW = 14, gap = 10;
    const by   = cy - Math.round(barH / 2);
    const lx   = cx - Math.round(barW + gap / 2);
    const rx   = cx + Math.round(gap / 2);
    icon = `
      <rect x="${lx}" y="${by}" width="${barW}" height="${barH}" rx="3" fill="white"/>
      <rect x="${rx}" y="${by}" width="${barW}" height="${barH}" rx="3" fill="white"/>`;
  } else {
    const triH = 48, triW = 42;
    const tx   = cx - Math.round(triW * 0.38);
    const ty   = cy - Math.round(triH / 2);
    icon = `
      <polygon points="${tx},${ty} ${tx},${ty + triH} ${tx + triW},${cy}" fill="white"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="black" fill-opacity="0.55"/>
  ${icon}
</svg>`;
}

// ─── Generate card PNG ────────────────────────────────────────────────────────
async function generateCard({ imageBuffer, overlayMode = 'play' }) {
  const duration = randomDuration(); // capture so we can store it in metadata
  const svgBuf  = Buffer.from(buildOverlaySvg(CARD_W, CARD_H, overlayMode, duration), 'utf8');
  const cardId  = uuidv4();
  const outFile = `card_${cardId}.png`;

  // Step 1: normalise — auto-rotate (EXIF), flatten transparency to white,
  //         then resize with cover so the full 1200×630 is always filled.
  const normalised = await sharp(imageBuffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Step 2: composite SVG overlay
  const outputBuffer = await sharp(normalised)
    .composite([{ input: svgBuf, top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toBuffer();

  if (USE_BLOB_STORAGE) {
    const image = await put(`generated/${outFile}`, outputBuffer, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'image/png',
    });
    return { cardId, imagePath: image.url, duration };
  }

  const outPath = path.join(__dirname, 'generated', outFile);
  await fs.promises.writeFile(outPath, outputBuffer);

  return { cardId, imagePath: `/generated/${outFile}`, duration };
}

// ─── POST /generate-card ──────────────────────────────────────────────────────
app.post('/generate-card', requireGeneratorKey, upload.single('image'), async (req, res) => {
  const { url, overlayMode = 'play', twitterSite = '' } = req.body;

  let imageBuffer     = null;
  let sourceImageUrl  = null;
  let usedUpload      = false;

  try {
    if (req.file) {
      imageBuffer    = USE_BLOB_STORAGE ? req.file.buffer : fs.readFileSync(req.file.path);
      sourceImageUrl = USE_BLOB_STORAGE ? null : `/uploads/${req.file.filename}`;
      usedUpload     = true;

    } else if (url) {
      let meta;
      try {
        meta = await scrapePageMeta(url);
      } catch (e) {
        return res.json({ success: false, url, error: `Could not fetch URL: ${e.message}` });
      }

      if (!meta.imageUrl) {
        return res.json({ success: false, url, error: 'No usable image found on the page.' });
      }

      sourceImageUrl = meta.imageUrl;

      try {
        imageBuffer = await downloadImage(meta.imageUrl);
      } catch (e) {
        return res.json({ success: false, url, error: `Image download failed: ${e.message}` });
      }

    } else {
      return res.status(400).json({ success: false, error: 'Provide a URL or upload an image.' });
    }

    const { cardId, imagePath, duration } = await generateCard({ imageBuffer, overlayMode });

    await saveCard(cardId, { source_url: url || null, source_image_url: sourceImageUrl, image_path: imagePath, overlay_mode: overlayMode, duration, twitter_site: twitterSite });

    const base = baseUrl(req);
    return res.json({
      success:             true,
      url:                 url || null,
      source_image:        sourceImageUrl,
      generated_image:     imagePath,
      card_page_url:       `${base}/c/${cardId}`,
      used_uploaded_image: usedUpload,
    });

  } catch (err) {
    console.error('[generate-card]', err.message);
    return res.json({ success: false, url: url || null, error: err.message });
  }
});

// ─── POST /generate-cards (batch, JSON only) ──────────────────────────────────
app.post('/generate-cards', requireGeneratorKey, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: '"items" array is required.' });
  }
  if (items.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ success: false, error: `A maximum of ${MAX_BATCH_SIZE} items is allowed per request.` });
  }

  const results = await Promise.all(
    items.map(async (item) => {
      const { url, overlayMode = 'play' } = item || {};
      if (!url) return { success: false, url: null, error: 'URL is required.' };

      let meta;
      try { meta = await scrapePageMeta(url); }
      catch (e) { return { success: false, url, error: `Fetch failed: ${e.message}` }; }

      if (!meta.imageUrl) return { success: false, url, error: 'No image found.' };

      let imageBuffer;
      try { imageBuffer = await downloadImage(meta.imageUrl); }
      catch (e) { return { success: false, url, error: `Download failed: ${e.message}` }; }

      try {
        const { cardId, imagePath, duration } = await generateCard({ imageBuffer, overlayMode });
        await saveCard(cardId, { source_url: url, source_image_url: meta.imageUrl, image_path: imagePath, overlay_mode: overlayMode, duration });
        const base = baseUrl(req);
        return {
          success:         true,
          url,
          source_image:    meta.imageUrl,
          generated_image: imagePath,
          card_page_url:   `${base}/c/${cardId}`,
        };
      } catch (e) {
        return { success: false, url, error: e.message };
      }
    })
  );

  res.json({ success: true, count: results.length, results });
});

// ─── GET /c/:id  —  Twitter Card landing page ────────────────────────────────
// This is the URL you paste into Twitter. Twitter's crawler visits it,
// reads the <meta> tags, and renders the 1200×630 image as a card.
app.get('/c/:id', async (req, res) => {
  let card;
  try {
    card = await loadCard(req.params.id);
  } catch (e) {
    console.error('[card-load]', e.message);
    return res.status(502).send('Card storage unavailable');
  }

  if (!card) {
    return res.status(404).send('Card not found');
  }

  // In local mode, regenerate a remotely sourced image if local files were lost.
  const diskPath = USE_BLOB_STORAGE ? null : path.join(__dirname, card.image_path);
  if (!USE_BLOB_STORAGE && !fs.existsSync(diskPath) && card.source_image_url) {
    try {
      const imageBuffer = await downloadImage(card.source_image_url);
      // Regenerate into the exact same path so the URL stays valid
      const svgBuf = Buffer.from(buildOverlaySvg(CARD_W, CARD_H, card.overlay_mode || 'play', card.duration), 'utf8');
      const normalised = await sharp(imageBuffer)
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
        .toBuffer();
      await sharp(normalised)
        .composite([{ input: svgBuf, top: 0, left: 0 }])
        .png({ compressionLevel: 8 })
        .toFile(diskPath);
    } catch (e) {
      console.error('[regen]', e.message);
    }
  }

  const base      = baseUrl(req);
  const imageUrl  = /^https?:\/\//.test(card.image_path) ? card.image_path : `${base}${card.image_path}`;
  const pageUrl   = `${base}/c/${req.params.id}`;
  const duration  = card.duration || '';
  const twitterSite = card.twitter_site || '';
  // Minimal HTML — Twitter only needs the <head> meta tags
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <!-- Twitter Card tags (summary_large_image = full-width image card) -->
  <meta name="twitter:card"        content="summary_large_image">
  ${twitterSite ? `<meta name="twitter:site" content="${twitterSite}">` : ''}
  <meta name="twitter:title"       content="${xmlEscape(duration)}">
  <meta name="twitter:description" content="点击立即播放 · HD 1080p | 无需下载">
  <meta name="twitter:image"       content="${imageUrl}">
  <meta name="twitter:image:width" content="1200">
  <meta name="twitter:image:height" content="630">
  <meta name="twitter:url"         content="${pageUrl}">

  <!-- Open Graph (Telegram, Slack, iMessage, etc.) -->
  <meta property="og:type"         content="website">
  <meta property="og:url"          content="${pageUrl}">
  <meta property="og:image"        content="${imageUrl}">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">

  <title>Video</title>
</head>
<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <img src="${imageUrl}" style="max-width:100%;max-height:100vh;display:block" alt="card">
</body>
</html>`);
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '1.1.0',
  storage: USE_BLOB_STORAGE ? 'vercel-blob' : 'local',
}));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Twitter Card Generator`);
  console.log(`   http://localhost:${PORT}\n`);
});
