# Twitter Card Generator

一个用于生成 Twitter / X 图片卡片及可分享卡片链接的轻量 Web 工具。

它可以从网页链接中自动提取封面图，或使用上传的图片，生成带播放或暂停按钮效果的 `1200 x 630` PNG 图片；同时为每张图片提供带有 Twitter Card / Open Graph 元数据的落地页链接，供 X、Telegram、Slack 等平台抓取预览。

> 本项目不会登录 Twitter / X，也不会自动发布推文。它生成的是图片和可粘贴到推文中的公开链接。

## 在线入口

[https://twitter-card-generator-jade.vercel.app/](https://twitter-card-generator-jade.vercel.app/)

线上生成接口受访问密钥保护。已生成的 Card 页面保持公开，以便 Twitter / X 抓取预览。

## 功能

- 从 URL 自动读取 `twitter:image`、`og:image`、视频海报或页面图片。
- 支持直接上传 JPG、PNG、WebP、GIF、AVIF 图片作为素材。
- 自动裁切并输出标准大图卡片尺寸 `1200 x 630`。
- 可选择中央播放按钮或暂停按钮覆盖层。
- 提供网页操作界面，可连续处理多条素材并下载生成的 PNG。
- 为每张卡片生成 `/c/<id>` 页面，包含 Twitter Card 和 Open Graph meta 标签。
- 提供单张生成接口和 URL 批量生成接口。
- 在 Vercel 部署时使用 Blob 持久化图片和卡片元数据。
- 支持为公开部署配置生成访问密钥，防止陌生人消耗免费额度。

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

完成上述命令后，在运行服务的这台电脑上打开
[http://localhost:3000](http://localhost:3000) 即可使用前端页面。

`localhost` 表示访问者自己的电脑，不是公开网站地址。其他人直接打开这个链接，
访问的是他们自己的本机，因此无法进入你的服务。

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

如果服务配置了 `GENERATOR_KEY`，请求还必须携带
`x-generator-key: <你的密钥>` 请求头。前端页面提供了对应的输入框。

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

`localhost` 只能用于本地预览，其他访问者以及 Twitter / X 的爬虫都无法通过该地址访问你的服务。
要让别人使用前端页面，或生成可被平台抓取的 Card，必须把服务部署到公网，并设置：

```bash
BASE_URL=https://your-public-domain.example
```

部署完成后，对外提供的前端入口将是类似
`https://your-public-domain.example/` 的公网地址，而不是 `http://localhost:3000/`。

### Vercel Hobby + Blob

Vercel 部署使用 public Blob 保存生成后的图片，以及渲染 Card 页面所需的最小元数据。
需要在 Vercel 项目中连接一个 public Blob store，使项目获得
`BLOB_READ_WRITE_TOKEN` 环境变量；服务检测到该变量后会自动切换到 Blob 存储。

为了避免公开生成接口被滥用而耗尽免费额度，公网部署还应配置：

```bash
GENERATOR_KEY=仅自己保存的随机密钥
```

前端页面需要输入该密钥后才能生成卡片，但已经生成的 `/c/<id>` 页面保持公开，
因此 X 可以正常抓取预览。

### 本地与容器部署

未配置 Blob 时，应用继续将图片和元数据保存到本地文件系统中的 `generated/`、
`uploads/` 和 `cards.json`，适用于本地运行或具备持久磁盘的容器平台。
项目仍保留 `Dockerfile` 供这类部署方式使用。

## 技术栈

- Node.js + Express：HTTP 服务和页面托管
- Cheerio + Axios：网页元数据抓取与远程图片下载
- Sharp：图片裁切、缩放与 SVG 覆盖层合成
- Multer：上传文件接收
- Vercel Blob：公网部署时持久化卡片图片与元数据

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
