FROM node:20

RUN apt-get update && apt-get install -y \
    ffmpeg \
    aria2 \
    python3 \
    python3-pip \
    curl

RUN pip3 install --break-system-packages yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
