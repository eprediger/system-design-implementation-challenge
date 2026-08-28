# Development image: run build, typecheck and tests manually (native Node on Debian).
FROM node:24-slim

WORKDIR /app

# Dependencies first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["npm", "test"]