FROM node:20-alpine

WORKDIR /app

# 优先复制依赖清单以利用 Docker 构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制应用代码
COPY server.js ./
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server.js"]
