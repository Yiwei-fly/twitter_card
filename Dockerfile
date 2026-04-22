FROM node:20-slim

# Install fonts so librsvg (used by sharp) can render SVG text
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
