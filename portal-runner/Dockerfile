# portal-runner — imagem leve com bun + os CLIs de portal.
# python3 entra só para a utilidade de auditoria tools/robots_check.py; não está
# no caminho de request (os CLIs tratam robots/WAF por conta própria).

FROM oven/bun:1-alpine

RUN apk add --no-cache python3

WORKDIR /app

# Zero dependências de runtime (CLIs e runner usam só a stdlib do bun), então
# não há `bun install` de produção. Copiamos o código direto.
COPY package.json tsconfig.json ./
COPY src ./src
COPY cli ./cli
COPY tools ./tools

ENV PORT=8080
EXPOSE 8080

# O usuário 'bun' já existe na imagem base; roda sem root.
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null 2>&1 || exit 1

CMD ["bun", "run", "src/server.ts"]
