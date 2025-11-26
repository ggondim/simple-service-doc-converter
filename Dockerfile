FROM oven/bun:debian

# Evita prompts interativos durante apt
ENV DEBIAN_FRONTEND=noninteractive

# Instala LibreOffice (soffice) e dependências úteis para execução headless
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice \
    default-jre-headless \
    fonts-dejavu-core \
    fontconfig \
    locales \
    ca-certificates \
  && locale-gen en_US.UTF-8 || true \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia arquivos do projeto
COPY . .

# Instala dependências com bun
RUN bun install --production

EXPOSE 3000

CMD ["bun", "src/server.ts"]
