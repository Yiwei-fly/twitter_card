'use strict';

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const cheerio = require('cheerio');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

const CARD_W = 1200;
const CARD_H = 630;

// ─── Ensure directories exist ─────────────────────────────────────────────────
for (const dir of ['uploads', 'generated', 'public']) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
}

// ─── Card metadata store ──────────────────────────────────────────────────────
// In-memory primary store; also persisted to cards.json when filesystem allows.
const CARDS_CACHE = {};
const CARDS_FILE  = path.join(__dirname, 'cards.json');

// Preload any previously saved cards (works locally; skipped on Railway cold start)
try {
  Object.assign(CARDS_CACHE, JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')));
} catch { /* fresh start */ }

function loadCards() { return CARDS_CACHE; }

function saveCard(id, meta) {
  CARDS_CACHE[id] = { ...meta, created_at: new Date().toISOString() };
  try { fs.writeFileSync(CARDS_FILE, JSON.stringify(CARDS_CACHE, null, 2)); }
  catch { /* read-only filesystem on some hosts — in-memory is enough */ }
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

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
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

// ─── Web Scraping ─────────────────────────────────────────────────────────────
async function scrapePageMeta(pageUrl) {
  const response = await axios.get(pageUrl, {
    timeout: 8000,
    maxRedirects: 5,
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
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 8000,
    maxRedirects: 5,
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

  // ── Bottom-left duration badge ────────────────────────────────────────────
  const dur      = duration || randomDuration();
  // Offset from bottom: Twitter overlays a ~50px domain bar at the very bottom,
  // so we place the badge 70px above the bottom edge to stay visible.
  const padX     = 18, padY = h - 70;
  const badgeH   = 36, badgeR = 5;
  const fontSize = 22;
  // Approximate text width: monospace-ish, ~12px per char
  const textW    = dur.length * 12 + 4;
  const badgeW   = textW + 20;
  const badgeX   = padX;
  const badgeY   = padY - badgeH;
  const textX    = badgeX + badgeW / 2;
  const textY    = badgeY + badgeH / 2 + 7;

  const durationBadge = `
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}"
      rx="${badgeR}" fill="black" fill-opacity="0.75"/>
    <text x="${textX}" y="${textY}"
      font-family="DejaVu Sans Mono, Liberation Mono, monospace"
      font-size="${fontSize}"
      font-weight="bold"
      fill="white"
      text-anchor="middle"
    >${xmlEscape(dur)}</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${cx}" cy="${cy}" r="${R}" fill="black" fill-opacity="0.55"/>
  ${icon}
  ${durationBadge}
</svg>`;
}

// ─── Generate card PNG ────────────────────────────────────────────────────────
async function generateCard({ imageBuffer, overlayMode = 'play' }) {
  const duration = randomDuration(); // capture so we can store it in metadata
  const svgBuf  = Buffer.from(buildOverlaySvg(CARD_W, CARD_H, overlayMode, duration), 'utf8');
  const cardId  = uuidv4();
  const outFile = `card_${cardId}.png`;
  const outPath = path.join(__dirname, 'generated', outFile);

  // Step 1: normalise — auto-rotate (EXIF), flatten transparency to white,
  //         then resize with cover so the full 1200×630 is always filled.
  const normalised = await sharp(imageBuffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
    .toBuffer();

  // Step 2: composite SVG overlay
  await sharp(normalised)
    .composite([{ input: svgBuf, top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toFile(outPath);

  return { cardId, imagePath: `/generated/${outFile}`, duration };
}

// ─── POST /generate-card ──────────────────────────────────────────────────────
app.post('/generate-card', upload.single('image'), async (req, res) => {
  const { url, overlayMode = 'play' } = req.body;

  let imageBuffer     = null;
  let sourceImageUrl  = null;
  let usedUpload      = false;

  try {
    if (req.file) {
      imageBuffer    = fs.readFileSync(req.file.path);
      sourceImageUrl = `/uploads/${req.file.filename}`;
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

    saveCard(cardId, { source_url: url || null, source_image_url: sourceImageUrl, image_path: imagePath, overlay_mode: overlayMode, duration });

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
app.post('/generate-cards', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: '"items" array is required.' });
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
        saveCard(cardId, { source_url: url, source_image_url: meta.imageUrl, image_path: imagePath, overlay_mode: overlayMode, duration });
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
  const cards = loadCards();
  const card  = cards[req.params.id];

  if (!card) {
    return res.status(404).send('Card not found');
  }

  // If the image file was wiped (Railway redeploy), regenerate it silently
  const diskPath = path.join(__dirname, card.image_path);
  if (!fs.existsSync(diskPath) && card.source_image_url) {
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
  const imageUrl  = `${base}${card.image_path}`;
  const pageUrl   = `${base}/c/${req.params.id}`;
  const duration  = card.duration || '';
  const twitterSite = process.env.TWITTER_SITE || '';
  const srcUrl   = card.source_url || pageUrl;

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
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Twitter Card Generator`);
  console.log(`   http://localhost:${PORT}\n`);
});
