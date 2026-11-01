FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/astral-entrypoint.sh
RUN chmod +x /usr/local/bin/astral-entrypoint.sh && mkdir -p /data && chown node:node /data

# Деректер базасы осы томда сақталады (контейнер жаңартылса да өшпейді)
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Entrypoint /data құқығын түзетеді де, қосымшаны `node` пайдаланушысымен іске қосады
ENTRYPOINT ["astral-entrypoint.sh"]
CMD ["node", "server/index.js"]
