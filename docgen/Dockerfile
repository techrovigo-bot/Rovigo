# docgen — HTTP fino sobre o pacote de geração de documentos. Zero deps de runtime.

FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json tsconfig.json ./
COPY src ./src
COPY prompts ./prompts

ENV PORT=8100
EXPOSE 8100

USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8100/health >/dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/server.ts"]
