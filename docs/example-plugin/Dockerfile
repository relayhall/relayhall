FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js .

# Run as non-root
RUN groupadd --system --gid 1002 appuser && useradd --system --uid 1002 --gid appuser --no-create-home appuser
USER appuser

EXPOSE 3020

CMD ["node", "server.js"]
