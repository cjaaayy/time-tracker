FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js storage.js domain.js mysqlBackend.js ./
COPY public ./public
RUN chown -R node:node /app
USER node
ENV NODE_ENV=production TIME_TRACKER_HOST=0.0.0.0 TIME_TRACKER_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "index.js"]
