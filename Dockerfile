FROM node:20-slim

# Chromium + minimal font packs so puppeteer-core can render HTML → PDF.
# Using the system chromium keeps the image ~200MB smaller than bundling
# a full puppeteer chromium build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-core \
      ca-certificates \
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
ENV PORT=3000

# dumb-init reaps zombie chromium processes that puppeteer spawns
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
