FROM node:20

RUN apt-get update && apt-get install -y ffmpeg curl python3

WORKDIR /app

COPY . .

RUN npm install

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
-o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp

EXPOSE 3000

CMD ["node", "server.cjs"]
