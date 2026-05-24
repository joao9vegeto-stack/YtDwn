FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install yt-dlp

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install
RUN pnpm -r --if-present build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["pnpm", "--filter", "@workspace/api-server", "start"]
