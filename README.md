# Twitter Card Generator

一个用于生成 Twitter / X 图片卡片及可分享卡片链接的轻量 Web 工具。

它可以从网页链接中自动提取封面图，或使用上传的图片，生成带播放或暂停按钮效果的 `1200 x 630` PNG 图片；同时为每张图片提供带有 Twitter Card / Open Graph 元数据的落地页链接，供 X、Telegram、Slack 等平台抓取预览。

> 本项目不会登录 Twitter / X，也不会自动发布推文。它生成的是图片和可粘贴到推文中的公开链接。

## 功能

- 从 URL 自动读取 `twitter:image`、`og:image`、视频海报或页面图片。
- 支持直接上传 JPG、PNG、WebP、GIF、AVIF 图片作为素材。
- 自动裁切并输出标准大图卡片尺寸 `1200 x 630`。
- 可选择中央播放按钮或暂停按钮覆盖层。
- 提供网页操作界面，可连续处理多条素材并下载生成的 PNG。
- 为每张卡片生成 `/c/<id>` 页面，包含 Twitter Card 和 Open Graph meta 标签。
- 提供单张生成接口和 URL 批量生成接口。

## 工作流程

1. 在页面中输入一个网页 URL，或上传一张图片。
2. 选择需要显示的按钮样式。
3. 点击“生成卡片图”，服务端下载或读取图片并生成 PNG。
4. 页面返回生成图片和 Card 链接。
5. 部署到公网后，将 Card 链接放入推文，X 即可抓取大图预览。

## 本地运行

环境要求：Node.js 20 或更新版本。

```bash
npm install
npm start
```

打开 [http://localhost:3000](http://localhost:3000) 即可使用前端页面。

开发时也可以使用：

```bash
npm run dev
```

## 接口

### `POST /generate-card`

生成单张卡片。请求使用 `multipart/form-data`：

| 字段 | 说明 |
| --- | --- |
| `url` | 需要提取封面图的网页地址；与 `image` 二选一 |
| `image` | 上传的图片文件；优先于 `url` |
| `overlayMode` | `play` 或 `pause`，默认 `play` |
| `twitterSite` | 可选的 `@账号` 信息，用于生成页面的 meta 标签 |

响应中包含生成图片路径 `generated_image` 和可分享页面链接 `card_page_url`。

### `POST /generate-cards`

以 JSON 请求批量处理 URL：

```json
{
  "items": [
    { "url": "https://example.com/page", "overlayMode": "play" }
  ]
}
```

### `GET /c/:id`

返回卡片落地页。该页面的 `<head>` 中带有 Twitter Card / Open Graph 标签，是发布到社交平台时使用的链接。

### `GET /health`

返回服务健康状态。

## 部署说明

`localhost` 只能用于本地预览，Twitter / X 的爬虫无法访问本机地址。要生成可被平台抓取的 Card，必须把服务部署到公网，并设置：

```bash
BASE_URL=https://your-public-domain.example
```

项目包含 `Dockerfile`，可部署到 Railway 或其他支持 Node.js / Docker 的平台。

当前实现将生成图片、上传图片及卡片元数据保存在本地文件系统中的 `generated/`、`uploads/` 和 `cards.json`。如果部署平台的磁盘会在重启或重新部署后清空，应配置持久化存储或进一步接入对象存储与数据库。

## 技术栈

- Node.js + Express：HTTP 服务和页面托管
- Cheerio + Axios：网页元数据抓取与远程图片下载
- Sharp：图片裁切、缩放与 SVG 覆盖层合成
- Multer：上传文件接收

## 目录结构

```text
.
├── index.js          # 服务端、图片生成逻辑与 Card 页面
├── public/           # 前端操作页面
├── generated/        # 生成后的卡片图片
├── uploads/          # 用户上传的素材
├── cards.json        # 本地卡片元数据
├── Dockerfile        # 容器部署配置
└── SOP.md            # 从搭建到部署的完整操作说明
```

更多搭建和部署细节见 [SOP.md](./SOP.md)。
