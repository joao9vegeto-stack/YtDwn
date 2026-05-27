# YT Downloader

## Instalação local

1. Instale as dependências:

```bash
npm install
```

2. Certifique-se de ter instalado no sistema:

- `ffmpeg`
- `ffprobe`
- `yt-dlp`
- `aria2c`

3. Inicie o servidor:

```bash
npm start
```

## Estrutura

- `server.cjs` — backend e geração do relatório do MP4 final
- `public/index.html` — interface principal
- `public/app.js` — lógica de progresso, histórico e relatório
- `public/style.css` — layout e modal do relatório

## Observações

- O histórico dos jobs é salvo no navegador para sobreviver a recarregamentos.
- O relatório final mostra container, codecs, FPS, áudio, tamanho e checagem de compatibilidade.
