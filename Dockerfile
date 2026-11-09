# Vite 7 needs Node 20.19+ or 22.12+
FROM --platform=linux/amd64 node:22-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Build the app
COPY . .
RUN npm run build

# --- Production stage ---
FROM --platform=linux/amd64 nginx:alpine

# Copy built assets from builder (Vite writes to dist/)
COPY --from=builder /app/dist /usr/share/nginx/html

# SPA fallback: unknown paths serve index.html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
