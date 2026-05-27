FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    ffmpeg \
    aria2 \
    python3 \
    python3-pip \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
