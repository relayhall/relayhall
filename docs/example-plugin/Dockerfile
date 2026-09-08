FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js .

# Run as non-root
RUN addgroup -g 1002 -S appuser && adduser -S appuser -u 1002
USER appuser

EXPOSE 3020

CMD ["node", "server.js"]
