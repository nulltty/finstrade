FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production HOST=0.0.0.0
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx src/index.ts"]
