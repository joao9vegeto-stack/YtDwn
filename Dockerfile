FROM node:20

RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
