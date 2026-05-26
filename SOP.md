# Twitter Card 生成器 — 完整 SOP

> 按此步骤，任何人都可以用 Claude Code 从零搭建一个一模一样的 Twitter Card 生成器，并部署到 Railway。

---

## 一、前置准备

需要提前准备好以下账号和工具：

| 工具 | 用途 | 是否免费 |
|------|------|----------|
| [GitHub](https://github.com) 账号 | 托管代码 | 免费 |
| [Railway](https://railway.app) 账号 | 部署服务器 | 免费（每月 $5 额度） |
| [Node.js](https://nodejs.org) 本地安装 | 本地运行测试 | 免费 |
| Claude Code | 生成代码 | 按使用量 |

---

## 二、创建项目目录

在终端运行：

```bash
mkdir twitter-card-generator
cd twitter-card-generator
```

---

## 三、把以下文件内容交给 Claude Code 创建

### 3.1 `package.json`

```json
{
  "name": "twitter-card-generator",
  "version": "1.0.0",
  "description": "Generate Twitter Card images with play/pause overlay from URLs",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js"
  },
  "dependencies": {
    "axios": "^1.6.7",
    "cheerio": "^1.0.0",
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.33.5",
    "uuid": "^9.0.0"
  },
  "optionalDependencies": {
    "@img/sharp-libvips-darwin-arm64": "^1.0.4"
  }
}
```

> **关键点：** `@img/sharp-libvips-darwin-arm64` 必须放在 `optionalDependencies`，否则 Railway（Linux 服务器）会因平台不兼容报 `EBADPLATFORM` 错误。

---

### 3.2 `Dockerfile`

```dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    fonts-liberation \
    fonts-dejavu-core \
    fontconfig \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --include=optional

COPY . .

RUN mkdir -p uploads generated

EXPOSE 3000
CMD ["node", "index.js"]
```

> **关键点：** 必须安装字体（`fonts-liberation` + `fonts-dejavu-core`），否则 Railway 容器内 sharp 渲染 SVG 文字会显示方块。

---

### 3.3 `.gitignore`

```
node_modules
uploads
generated
cards.json
.env
*.log
```

---

### 3.4 `.dockerignore`

```
node_modules
uploads
generated
cards.json
*.log
.git
```

---

### 3.5 `index.js`（完整版）

```javascript
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

for (const dir of ['uploads', 'generated', 'public']) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
}

const CARDS_CACHE = {};
const CARDS_FILE  = path.join(__dirname, 'cards.json');

try {
  Object.assign(CARDS_CACHE, JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')));
} catch { }

function loadCards() { return CARDS_CACHE; }

function saveCard(id, meta) {
  CARDS_CACHE[id] = { ...meta, created_at: new Date().toISOString() };
  try { fs.writeFileSync(CARDS_FILE, JSON.stringify(CARDS_CACHE, null, 2)); }
  catch { }
}

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads',   express.static(path.join(__dirname, 'uploads')));
app.use('/generated', express.static(path.join(__dirname, 'generated')));

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
    $('title').text().trim() || '';

  let imageUrl =
    $('meta[name="twitter:image"]').attr('content')  ||
    $('meta[property="og:image"]').attr('content')   ||
    $('video[poster]').first().attr('poster')         ||
    null;

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
    imageUrl = (large || candidates[0])?.src || null;
  }

  if (imageUrl) {
    try { imageUrl = new URL(imageUrl, pageUrl).href; }
    catch { imageUrl = null; }
  }

  return { title, imageUrl };
}

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

function xmlEscape(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

function randomDuration() {
  const totalSecs = Math.floor(Math.random() * (7200 - 10 + 1)) + 10;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function buildOverlaySvg(w, h, mode) {
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const R  = 68;

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

async function generateCard({ imageBuffer, overlayMode = 'play' }) {
  const duration = randomDuration();
  const svgBuf  = Buffer.from(buildOverlaySvg(CARD_W, CARD_H, overlayMode), 'utf8');
  const cardId  = uuidv4();
  const outFile = `card_${cardId}.png`;
  const outPath = path.join(__dirname, 'generated', outFile);

  const normalised = await sharp(imageBuffer)
    .rotate()
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
    .toBuffer();

  await sharp(normalised)
    .composite([{ input: svgBuf, top: 0, left: 0 }])
    .png({ compressionLevel: 8 })
    .toFile(outPath);

  return { cardId, imagePath: `/generated/${outFile}`, duration };
}

app.post('/generate-card', upload.single('image'), async (req, res) => {
  const { url, overlayMode = 'play', twitterSite = '' } = req.body;

  let imageBuffer = null, sourceImageUrl = null, usedUpload = false;

  try {
    if (req.file) {
      imageBuffer    = fs.readFileSync(req.file.path);
      sourceImageUrl = `/uploads/${req.file.filename}`;
      usedUpload     = true;
    } else if (url) {
      let meta;
      try { meta = await scrapePageMeta(url); }
      catch (e) { return res.json({ success: false, url, error: `Could not fetch URL: ${e.message}` }); }

      if (!meta.imageUrl) return res.json({ success: false, url, error: 'No usable image found on the page.' });

      sourceImageUrl = meta.imageUrl;
      try { imageBuffer = await downloadImage(meta.imageUrl); }
      catch (e) { return res.json({ success: false, url, error: `Image download failed: ${e.message}` }); }
    } else {
      return res.status(400).json({ success: false, error: 'Provide a URL or upload an image.' });
    }

    const { cardId, imagePath, duration } = await generateCard({ imageBuffer, overlayMode });
    saveCard(cardId, { source_url: url || null, source_image_url: sourceImageUrl, image_path: imagePath, overlay_mode: overlayMode, duration, twitter_site: twitterSite });

    const base = baseUrl(req);
    return res.json({
      success: true, url: url || null,
      source_image: sourceImageUrl,
      generated_image: imagePath,
      card_page_url: `${base}/c/${cardId}`,
      used_uploaded_image: usedUpload,
    });
  } catch (err) {
    console.error('[generate-card]', err.message);
    return res.json({ success: false, url: url || null, error: err.message });
  }
});

app.get('/c/:id', async (req, res) => {
  const cards = loadCards();
  const card  = cards[req.params.id];

  if (!card) return res.status(404).send('Card not found');

  const diskPath = path.join(__dirname, card.image_path);
  if (!fs.existsSync(diskPath) && card.source_image_url) {
    try {
      const imageBuffer = await downloadImage(card.source_image_url);
      const svgBuf = Buffer.from(buildOverlaySvg(CARD_W, CARD_H, card.overlay_mode || 'play'), 'utf8');
      const normalised = await sharp(imageBuffer)
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' })
        .toBuffer();
      await sharp(normalised)
        .composite([{ input: svgBuf, top: 0, left: 0 }])
        .png({ compressionLevel: 8 })
        .toFile(diskPath);
    } catch (e) { console.error('[regen]', e.message); }
  }

  const base        = baseUrl(req);
  const imageUrl    = `${base}${card.image_path}`;
  const pageUrl     = `${base}/c/${req.params.id}`;
  const duration    = card.duration || '';
  const twitterSite = card.twitter_site || '';

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="twitter:card"         content="summary_large_image">
  ${twitterSite ? `<meta name="twitter:site" content="${twitterSite}">` : ''}
  <meta name="twitter:title"        content="${xmlEscape(duration)}">
  <meta name="twitter:description"  content="点击立即播放 · HD 1080p | 无需下载">
  <meta name="twitter:image"        content="${imageUrl}">
  <meta name="twitter:image:width"  content="1200">
  <meta name="twitter:image:height" content="630">
  <meta name="twitter:url"          content="${pageUrl}">
  <meta property="og:type"          content="website">
  <meta property="og:url"           content="${pageUrl}">
  <meta property="og:image"         content="${imageUrl}">
  <title>Video</title>
</head>
<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <img src="${imageUrl}" style="max-width:100%;max-height:100vh;display:block" alt="card">
</body>
</html>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`✅  Twitter Card Generator  http://localhost:${PORT}`);
});
```

---

### 3.6 `public/index.html`

前端页面较长，直接让 Claude Code 生成，或从 GitHub 仓库复制：
`https://github.com/Yiwei-fly/twitter_card`

---

## 四、本地安装依赖并测试

```bash
npm install
node index.js
```

打开浏览器访问 `http://localhost:3000`，填入任意网址，点"生成卡片图"，确认能看到带播放按钮的 1200×630 图片。

---

## 五、推送到 GitHub

```bash
git init
git add .
git commit -m "init twitter card generator"
git branch -M main
git remote add origin https://github.com/你的用户名/twitter-card-generator.git
git push -u origin main
```

---

## 六、在 Railway 部署

1. 打开 [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. 选择刚才推送的仓库
3. Railway 会自动检测到 `Dockerfile` 并构建
4. 部署完成后，点击 Settings → 复制分配的域名（格式：`xxx.up.railway.app`）
5. 在 Railway 项目的 **Variables** 里添加环境变量：

```
BASE_URL = https://你的域名.up.railway.app
```

6. Railway 会自动重新部署，约 1~2 分钟完成

---

## 七、使用方法

1. 打开 `https://你的域名.up.railway.app`
2. 填入网页 URL（会自动抓取封面图）
3. 选择播放或暂停按钮样式
4. **填入自己的 Twitter 账号**（格式 `@你的账号`，不填则发推时图片左下角会出现域名条）
5. 点击"生成卡片图"
6. 复制生成的卡片链接（格式 `https://你的域名/c/xxxxxx`）
7. 粘贴到推文正文，Twitter 会自动展示图片卡

---

## 八、关键注意事项（踩坑总结）

| 问题 | 原因 | 解决方法 |
|------|------|----------|
| Railway 部署时报 `EBADPLATFORM` | Mac 专用包 `sharp-libvips-darwin-arm64` 放在了 `dependencies` | 移到 `optionalDependencies` |
| SVG 文字显示方块 | Railway 容器没有字体 | Dockerfile 安装 `fonts-liberation` + `fonts-dejavu-core` |
| 推特卡图片左下角出现域名条 | `twitter:url` 指向了源网页 URL | `twitter:url` 必须设为 `/c/:id` 页面自身的 URL |
| 出现两个时长角标 | PNG 里用 SVG 画了一个，`twitter:title` 又渲染了一个 | PNG 只保留播放/暂停圆圈，不要在 SVG 里再画时长文字 |
| Twitter 显示"No metatags found" | `twitter:title` 字段缺失 | 必须有 `twitter:title`，值填随机时长字符串 |
| 图片有黑色边框/黑色背景 | PNG 含透明通道 | sharp 处理时加 `.flatten({ background: {r:255,g:255,b:255} })` |
| Railway 重启后旧链接图片消失 | 免费版文件系统每次部署都会清空 | 在 `/c/:id` 路由里加自动重新生成逻辑 |

---

## 九、验证是否正常

把生成的卡片链接粘贴到 `https://cards-dev.twitter.com/validator`，点 Preview card，如果能看到正确的图片卡就说明部署成功。
